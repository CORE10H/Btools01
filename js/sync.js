/* =====================================================================
   クラウド同期（段階1：同期ファイルによる手動同期）
   設計：docs/planning/claude_クラウド同期_仕様書.md

   この段階では保存先（クラウド）を持たず、「同期ファイル」を手で別の端末へ
   運んで同期する。同期ファイルの中身は、将来クラウドに置くファイル群と
   まったく同じ（暗号化済みのファイルを1つにまとめただけ）。保存先を
   差し替えるだけでクラウド同期になるよう、保存先は list/read/write/remove
   の4操作だけで扱う。

   主な仕組み：
     - 端末内のIndexedDBが主。クラウド（同期ファイル）はその写し
     - 各端末は自分専用のファイルにだけ書く（2台が同じファイルを上書きしない）
     - 前回同期した時点の状態（指紋と版）と今を比べる3方向比較で、
       更新・削除を見つける（アプリ側の保存・削除処理は変えなくてよい）
     - 版は「端末の時計＋今まで見た最大の版より必ず大きく」（Lamport時計の考え方）
     - 暗号化は封筒暗号化：ランダムな主鍵をパスフレーズ由来の鍵で包む
       （PBKDF2-SHA256 60万回 → AES-256-GCM）。主鍵からHKDFで
       暗号化用（AES-GCM）と名前用（HMAC）の鍵を作る
     - 画像などのバイナリは1点1ファイル。名前は中身の鍵付きハッシュ

   フールプルーフ（誤作動防止策）：
     1) 同期の対象は許可リスト（DB_RULES）のDBだけ。sideops_log は対象外
     2) 端末にないDBを版指定なしで開かない（空のDBが版1で作られ、アプリの
        初期化が走らなくなるため）。存在確認は indexedDB.databases()
     3) DBの版が端末どうしで違うときは、そのDBを合流しない（移行前の形の
        データで上書きしないため）。新しい版のSIDE-OPSが書いたファイルが
        あれば同期全体を止め、再読み込みを促す
     4) Stageでアプリを開いている間・他のタブでSIDE-OPSを開いている間は
        同期しない（開いているアプリが古いデータで上書きするのを防ぐ）
     5) 同じ端末で同期を走らせるのは1つだけ（Web Locks API）
     6) 1つのDBへの反映は1トランザクション。途中で失敗したら何も変わらない
     7) 競合で負けた版は「競合の控え」に30日残す
     8) その端末で初めて同期する前に、全データのバックアップを書き出す
     9) 顧客データを含むDB（RECON）は、初めて送る前に1回確認する
    10) 暗号化したファイルは名前と結び付けて検証（AAD）。別の名前のファイルとの
        すり替え・改ざんは復号できずに止まる
   ===================================================================== */
(() => {
  'use strict';

  // ---- 定数 ----
  // SIDE-OPSの版（yyyymmddnn の数値）。どれかのアプリでデータの形（レコードの
  // 項目・DBの版）を変えたら必ず上げる。自分より新しい版の端末が書いたファイルを
  // 見つけたら同期を止める（古い版が新しい項目を知らずに上書きして消すのを防ぐ）
  const SYNC_APP_BUILD = 2026101002;
  const FORMAT_VERSION = 1;
  const SYNC_DB_NAME = 'sideops_sync';
  const SYNC_DB_VERSION = 3; // 2：同期の記録（journal）を追加、3：同期のログ（runlog。かかった時間）を追加
  const KDF_ITERATIONS = 600000;        // OWASPの推奨値（PBKDF2-HMAC-SHA256）
  const KDF_ITERATIONS_MIN = 100000;    // 読み込んだmanifestの値の妥当範囲（細工されたファイルで固まらないように）
  const KDF_ITERATIONS_MAX = 10000000;
  const PASSPHRASE_MIN = 12;
  const DATAURL_MIN_LENGTH = 1024;      // これより短いdata URLは分離せず、そのまま文字列で持つ
  const MAX_DEPTH = 64;
  const LOG_MAX = 200;
  const CONFLICT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
  const BLOB_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // クラウドで、参照されなくなった画像を消すまでの猶予
  const STALE_SYNC_MS = 3 * 24 * 60 * 60 * 1000;  // 最後の同期からこれ以上たったら☁に印を付ける
  const STAGE_RETIRE_WAIT_MS = 2500;    // Stageを閉じたあと、アプリが未保存の入力を書き終えるまでの猶予（main.jsは1.5秒）
  const MANIFEST_NAME = 'sideops-sync-manifest.json';
  const PACKAGE_FORMAT = 'sideops-sync-package';
  const BACKUP_FORMAT = 'sideops-full-backup';
  const MAGIC = [0x53, 0x4f, 0x53, 0x31]; // 'SOS1'
  const DEVICE_ID_RE = /^[0-9a-f]{16}$/;
  const VER_RE = /^\d{13}-\d{4}-[0-9a-f]{16}$/; // 時刻13桁-カウンタ4桁-端末ID（19文字目から端末ID）
  const HASH_RE = /^[0-9a-f]{64}$/;
  const DATAURL_PREFIX_RE = /^data:[\w.+-]+\/[\w.+-]+(;[\w.+-]+=[\w.+-]+)*;base64$/i;

  // 同期の対象（許可リスト）。version はこの版のSIDE-OPSが知っている各アプリの
  // DB_VERSION（アプリ側を上げたら、ここも必ず同じ値に上げる）。
  //   excludeStores：同期しないストア
  //   only：指定したストア・レコード・項目だけを同期する（それ以外は端末ごと）
  //   sensitive：第三者の個人情報を含む。初めて送る前に確認する
  const DB_RULES = [
    { name: 'sideops_launcher', label: 'ランチャー（カード・アプリ）', version: 1 },
    { name: 'sideops_settings', label: '本体の設定（テーマ）', version: 1,
      // 壁紙（選択・アップロード画像）とパネルの透過率は端末ごと。新しい項目は
      // ここに書き足さない限り同期されない（＝端末ごと）
      only: { settings: { main: ['themeKey', 'customThemeTokens', 'eyedropperThemeTokens'] } } },
    { name: 'sideops_memo', label: 'メモ', version: 1 },
    { name: 'sideops_prompt_gallery', label: 'PROMPTGALLERY', version: 2 },
    { name: 'sideops_prompt_gallery_red', label: 'PROMPTGALLERY RED', version: 2 },
    { name: 'sideops_scaffold', label: 'SCAFFOLD', version: 1 },
    { name: 'sideops_scribit', label: 'SCRIBIT', version: 1 },
    { name: 'sideops_donemore', label: 'DONE MORE', version: 1 },
    { name: 'sideops_discotica', label: 'Discotica', version: 1 },
    { name: 'sideops_manuscript', label: 'MANUSCRIPT', version: 3 },
    { name: 'sideops_mindframe', label: 'MINDFRAME', version: 1, excludeStores: ['views'] }, // 表示位置・ズームは端末ごと
    { name: 'sideops_recon', label: 'RECON', version: 1, sensitive: true },
    // 読んだ位置は sideops_librarium_pos に分けた（2026-10-08）。本と同じDBだと、位置が変わるたびに全部の本文を送り直すため。
    // 本のDBに残る progress ストアは2026-10-07の版の名残（移し替えた後は空。同期しない）
    { name: 'sideops_librarium', label: 'LIBRARIUM', version: 1, excludeStores: ['progress'] },
    { name: 'sideops_librarium_pos', label: 'LIBRARIUM（読んだ位置）', version: 1 },
    // STAMPWORKS は企画だけを同期する（2026-10-10）。作業中の画像（sideops_stampworks_work）は数MBの画像を毎回送ると
    // 同期が重くなるので、わざとここに入れない（端末の中の一時保存。元の画像はカメラロールにあり、作り直せる）
    { name: 'sideops_stampworks', label: 'STAMPWORKS', version: 1 },
  ];
  const RULE_BY_NAME = new Map(DB_RULES.map((r) => [r.name, r]));

  class SyncError extends Error {}
  let lastReport = null; // 直近の同期の結果（動作確認用）

  // ===================== 「変えたよ」の印（本体ページの分） =====================
  // 各アプリの分は apps/sideops-theme-bridge.js が付ける。本体（ランチャー・設定）が IndexedDB に
  // 書き込んだときも、同じ形で localStorage に印を残す。同期が自分で書き込む分は、印を付けない
  // 元の関数（RAW）を使う
  const DIRTY_PREFIX = 'sideops_sync_dirty:';
  const RAW = {
    put: IDBObjectStore.prototype.put,
    add: IDBObjectStore.prototype.add,
    delete: IDBObjectStore.prototype.delete,
    clear: IDBObjectStore.prototype.clear,
  };
  let onLocalChange = null; // 画面（未送信の表示）へ知らせる
  (function hookDirtyMarks() {
    try {
      if (window.__sideopsDirtyHooked) return;
      window.__sideopsDirtyHooked = true;
      const last = {};
      const timers = {};
      const stamp = (key) => {
        last[key] = Date.now();
        try { localStorage.setItem(DIRTY_PREFIX + key, String(last[key])); } catch (err) { /* 保存できない環境は無視 */ }
        if (onLocalChange) { try { onLocalChange(key); } catch (err) { /* 表示の失敗は無視 */ } }
      };
      const mark = (os) => {
        const name = os && os.transaction && os.transaction.db && os.transaction.db.name;
        if (!name || name.indexOf('sideops_') !== 0 || name === 'sideops_sync') return;
        const key = name + '|' + os.name;
        if (!last[key] || Date.now() - last[key] > 500) { stamp(key); return; }
        if (!timers[key]) timers[key] = setTimeout(() => { timers[key] = 0; stamp(key); }, 600);
      };
      ['put', 'add', 'delete', 'clear'].forEach((m) => {
        const orig = IDBObjectStore.prototype[m];
        IDBObjectStore.prototype[m] = function (...args) {
          const r = orig.apply(this, args);
          try { mark(this); } catch (err) { /* 印が付けられなくても続ける */ }
          return r;
        };
      });
    } catch (err) { /* 何もしない */ }
  })();
  // 「変えたよ」の印を読む → { DB名: そのDBの同期するストアへの最後の書き込み時刻 }
  function readDirtyMarks() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(DIRTY_PREFIX)) continue;
        const v = Number(localStorage.getItem(k));
        if (!Number.isFinite(v)) continue;
        const rest = k.slice(DIRTY_PREFIX.length);
        const bar = rest.indexOf('|');
        const dbName = bar < 0 ? rest : rest.slice(0, bar);
        const store = bar < 0 ? null : rest.slice(bar + 1);
        const rule = RULE_BY_NAME.get(dbName);
        if (!rule) continue;
        // 同期しないストアへの書き込みは数えない
        if (store !== null) {
          if (rule.only && !Object.prototype.hasOwnProperty.call(rule.only, store)) continue;
          if ((rule.excludeStores || []).includes(store)) continue;
        }
        out[dbName] = Math.max(out[dbName] || 0, v);
      }
    } catch (err) { /* 読めなければ空（☁を押したときは全部見直すので取りこぼさない） */ }
    return out;
  }
  // 重い処理の途中で、画面の処理に順番を譲る
  const yieldUi = () => new Promise((r) => setTimeout(r, 0));

  // ===================== 小道具 =====================
  const te = new TextEncoder();
  const td = new TextDecoder();

  function bytesToB64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function toHex(buf) {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function randomHex(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return toHex(b);
  }
  async function sha256Hex(bytes) {
    return toHex(await crypto.subtle.digest('SHA-256', bytes));
  }
  async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // キーの順序を固定したJSON（指紋の計算用）
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  }
  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('トランザクションが中止されました'));
      tx.onerror = () => { /* onabort で拾う */ };
    });
  }
  function ruleLabel(name) { return (RULE_BY_NAME.get(name) || { label: name }).label; }

  // ===================== 暗号 =====================
  async function deriveWrapKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function hmacHex(key, data) {
    return toHex(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? te.encode(data) : data));
  }
  // 主鍵（32バイト）から、暗号化用・名前用の鍵を作る。どちらも取り出せない形
  async function keysFromMaster(master) {
    const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
    const salt = te.encode('sideops-sync/v1');
    const encKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('enc') }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const nameKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('name') }, base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const keyId = (await hmacHex(nameKey, 'key-id')).slice(0, 16);
    return { encKey, nameKey, keyId };
  }
  // 形式：'SOS1'(4) + IV(12) + 暗号文（認証タグ込み）
  async function seal(key, plain, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plain));
    const out = new Uint8Array(16 + ct.length);
    out.set(MAGIC, 0);
    out.set(iv, 4);
    out.set(ct, 16);
    return out;
  }
  async function unseal(key, sealed, aad) {
    if (!(sealed instanceof Uint8Array) || sealed.length < 32 || MAGIC.some((b, i) => sealed[i] !== b)) {
      throw new SyncError('同期ファイルの中身が壊れています（形式が違います）');
    }
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(4, 16), additionalData: te.encode(aad) }, key, sealed.subarray(16)));
    } catch (err) {
      throw new SyncError('復号できませんでした（ファイルが壊れているか、書き換えられています）');
    }
  }

  // ===================== manifest（同期全体の設定。暗号化しない） =====================
  function validateManifest(m) {
    if (!isPlainObject(m) || m.format !== 'sideops-sync-manifest') throw new SyncError('同期ファイルの設定（manifest）が見つかりません');
    if (typeof m.formatVersion !== 'number' || m.formatVersion > FORMAT_VERSION) {
      throw new SyncError('新しい版のSIDE-OPSで作られた同期ファイルです。SIDE-OPSを再読み込みして更新してください');
    }
    if (typeof m.spaceId !== 'string' || !/^[0-9a-f]{32}$/.test(m.spaceId)) throw new SyncError('同期ファイルの設定が壊れています（spaceId）');
    if (typeof m.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(m.keyId)) throw new SyncError('同期ファイルの設定が壊れています（keyId）');
    const k = m.kdf;
    if (!isPlainObject(k) || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iterations)
      || k.iterations < KDF_ITERATIONS_MIN || k.iterations > KDF_ITERATIONS_MAX || typeof k.salt !== 'string') {
      throw new SyncError('同期ファイルの設定が壊れています（鍵の作り方）');
    }
    if (typeof m.wrappedKey !== 'string') throw new SyncError('同期ファイルの設定が壊れています（鍵）');
    return m;
  }
  async function createManifest(passphrase) {
    const master = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const spaceId = randomHex(16);
    const wrapKey = await deriveWrapKey(passphrase, salt, KDF_ITERATIONS);
    const wrapped = await seal(wrapKey, master, 'sideops-sync|wrap|' + spaceId);
    const keys = await keysFromMaster(master);
    master.fill(0);
    const manifest = {
      format: 'sideops-sync-manifest', formatVersion: FORMAT_VERSION, spaceId, keyGen: 1, keyId: keys.keyId,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: bytesToB64(salt) },
      wrappedKey: bytesToB64(wrapped), createdAt: new Date().toISOString(),
    };
    return { manifest, keys };
  }
  async function unlockManifest(manifest, passphrase) {
    validateManifest(manifest);
    const wrapKey = await deriveWrapKey(passphrase, b64ToBytes(manifest.kdf.salt), manifest.kdf.iterations);
    let master;
    try {
      master = await unseal(wrapKey, b64ToBytes(manifest.wrappedKey), 'sideops-sync|wrap|' + manifest.spaceId);
    } catch (err) {
      throw new SyncError('パスフレーズが違います');
    }
    const keys = await keysFromMaster(master);
    master.fill(0);
    if (keys.keyId !== manifest.keyId) throw new SyncError('鍵の確認に失敗しました（同期ファイルが壊れています）');
    return keys;
  }
  function checkPassphraseRule(p) {
    if (typeof p !== 'string' || p.normalize('NFKC').length < PASSPHRASE_MIN) return `パスフレーズは${PASSPHRASE_MIN}文字以上にしてください`;
    if (p !== p.trim()) return 'パスフレーズの最初と最後に空白を入れないでください';
    return '';
  }

  // ===================== 同期の管理用DB（sideops_sync） =====================
  //   meta：device（端末ID・名前）/ keys（鍵）/ manifest（写し）/ clock / prefs / dbs（同期済みのDB）/ status
  //   records：前回同期した時点のレコードごとの状態 { id, db, store, key, ver, fp, deleted, dirty, baseVer }
  //   conflicts：競合で負けた版の控え / log：同期の記録
  let syncDbPromise = null;
  function syncDb() {
    if (!syncDbPromise) {
      syncDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
          if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' }).createIndex('db', 'db', { unique: false });
          if (!d.objectStoreNames.contains('conflicts')) d.createObjectStore('conflicts', { keyPath: 'id' }).createIndex('at', 'at', { unique: false });
          if (!d.objectStoreNames.contains('log')) d.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
          if (!d.objectStoreNames.contains('journal')) d.createObjectStore('journal', { keyPath: 'id', autoIncrement: true }).createIndex('at', 'at', { unique: false });
          if (!d.objectStoreNames.contains('runlog')) d.createObjectStore('runlog', { keyPath: 'id', autoIncrement: true }).createIndex('at', 'at', { unique: false });
        };
        req.onsuccess = () => {
          const d = req.result;
          d.onversionchange = () => { d.close(); syncDbPromise = null; };
          resolve(d);
        };
        req.onerror = () => { syncDbPromise = null; reject(req.error); };
      });
    }
    return syncDbPromise;
  }
  async function metaGet(key) {
    const d = await syncDb();
    return reqP(d.transaction('meta').objectStore('meta').get(key));
  }
  async function metaPut(obj) {
    const d = await syncDb();
    const tx = d.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(obj);
    await txDone(tx);
  }
  async function addLog(type, message) {
    try {
      const d = await syncDb();
      const tx = d.transaction('log', 'readwrite');
      const os = tx.objectStore('log');
      os.add({ at: Date.now(), type, message: String(message).slice(0, 2000) });
      const keys = await reqP(os.getAllKeys());
      if (keys.length > LOG_MAX) keys.slice(0, keys.length - LOG_MAX).forEach((k) => os.delete(k));
      await txDone(tx);
    } catch (err) { console.error('同期の記録に失敗しました', err); }
  }

  // ===================== 同期のログ（2026-10-08） =====================
  // 「しょっちゅう同期がかかって時間を取られる」の原因を調べるため、1回ごとに、きっかけ・結果・
  // かかった時間（段階ごと・通信の種類ごと・DBごと）・件数を、この端末の sideops_sync の runlog に残す。
  // ページの読み込み（ブラウザに閉じられて読み込み直したか）、しばらく離れて戻ったこと、
  // アプリを開くのを待ってもらった時間も残す。中身（データそのもの）は入れない。
  // 30日・1500件を超えた古いものから消す。書き出して分析に使う（同期の画面の「同期のログ」）
  const RUNLOG_MAX = 1500;
  const RUNLOG_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
  function logEnv() {
    const c = navigator.connection;
    return {
      vis: document.visibilityState,
      online: navigator.onLine,
      conn: (c && c.effectiveType) || '',
      sinceLoad: Math.round(performance.now()),
    };
  }
  async function addRunLog(entry) {
    try {
      const d = await syncDb();
      const tx = d.transaction('runlog', 'readwrite');
      const os = tx.objectStore('runlog');
      os.add({ v: 1, at: Date.now(), build: SYNC_APP_BUILD, ...entry, env: logEnv() });
      const old = await reqP(os.index('at').getAllKeys(IDBKeyRange.upperBound(Date.now() - RUNLOG_KEEP_MS)));
      old.forEach((k) => os.delete(k));
      const n = await reqP(os.count());
      if (n > RUNLOG_MAX) (await reqP(os.getAllKeys(null, n - RUNLOG_MAX))).forEach((k) => os.delete(k));
      await txDone(tx);
    } catch (err) { /* ログを残せなくても、同期には影響させない */ }
  }
  async function listRunLog() {
    try {
      const d = await syncDb();
      return await reqP(d.transaction('runlog').objectStore('runlog').getAll());
    } catch (err) { return []; }
  }
  async function clearRunLog() {
    const d = await syncDb();
    const tx = d.transaction('runlog', 'readwrite');
    tx.objectStore('runlog').clear();
    await txDone(tx);
  }
  // 1回の同期のログを組み立てる道具。lap(名前)＝前の区切りからの時間
  function startRunLog(kind, trigger, flags) {
    const t0 = performance.now();
    let last = t0;
    const e = { kind, trigger: trigger || '', flags: flags || {}, ms: {}, result: '' };
    return {
      e,
      lap(name) { const now = performance.now(); e.ms[name] = (e.ms[name] || 0) + Math.round(now - last); last = now; },
      skip(reason) { e.result = 'skip'; e.skip = reason; },
      fail(err) { e.result = 'error'; e.error = String((err && err.message) || err).slice(0, 300); },
      report(r) {
        if (!r) return;
        e.t = r.timing;
        e.stats = r.stats;
        e.conflicts = r.conflicts || 0;
        if (r.deferred) e.deferred = true;
        if (r.firstTime) e.firstTime = true;
        if (r.appliedDbs && r.appliedDbs.length) e.applied = r.appliedDbs;
        e.dbs = r.results
          .filter((x) => x.inAdd || x.inChange || x.inDel || x.outAdd || x.outChange || x.outDel || x.note || (r.timing && r.timing.scan && r.timing.scan[x.db] !== undefined))
          .map((x) => ({ db: x.db, in: [x.inAdd, x.inChange, x.inDel], out: [x.outAdd, x.outChange, x.outDel], ...(x.note ? { note: String(x.note).slice(0, 120) } : {}) }));
      },
      async end() {
        e.ms.total = Math.round(performance.now() - t0);
        if (!e.result) e.result = 'ok';
        await addRunLog(e);
      },
    };
  }

  function guessDeviceName() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Mac/i.test(ua)) return 'Mac';
    return 'この端末';
  }
  async function getDevice() {
    let dev = await metaGet('device');
    if (!dev || !DEVICE_ID_RE.test(dev.id)) {
      dev = { key: 'device', id: randomHex(8), name: guessDeviceName(), createdAt: Date.now() };
      await metaPut(dev);
    }
    return dev;
  }
  async function getPrefs() {
    const p = await metaGet('prefs');
    return { key: 'prefs', disabled: {}, sensitiveOk: {}, firstBackupDone: false, ...(p || {}) };
  }

  // ===================== 版（Lamport時計の考え方） =====================
  // 版の文字列：時刻13桁-カウンタ4桁-端末ID。文字列のまま大小比較できる
  function makeVer(t, c, dev) { return String(t).padStart(13, '0') + '-' + String(c).padStart(4, '0') + '-' + dev; }
  function verTime(v) { return Number(v.slice(0, 13)); }
  function verCount(v) { return Number(v.slice(14, 18)); }
  function createClock(saved, deviceId) {
    let t = saved && Number.isFinite(saved.t) ? saved.t : 0;
    let c = saved && Number.isFinite(saved.c) ? saved.c : 0;
    return {
      next() {
        const now = Date.now();
        if (now > t) { t = now; c = 0; } else if (++c > 9999) { t += 1; c = 0; }
        return makeVer(t, c, deviceId);
      },
      // 他の端末の版を見たら、自分の時計をそれ以上に進める（時計が遅れている端末でも、
      // 同期した後の編集は必ず新しいと判定されるように）
      observe(v) {
        const vt = verTime(v), vc = verCount(v);
        if (vt > t || (vt === t && vc > c)) { t = vt; c = vc; }
      },
      save() { return { key: 'clock', t, c }; },
    };
  }
  // その端末で初めて同期するDBのレコードは、レコード自身の更新日時を版にする
  // （同期を始めた時刻にすると、古いデータが他の端末の新しい編集に勝ってしまうため）。
  // 更新日時を持たないレコード（本体の設定など）は、すでにある同期に後から加わる側なら
  // 同期側の内容を採用する（adoptRemote：版を最小にして必ず負ける）。判断の材料が
  // 何もないのに、端末IDの大小で勝ち負けが決まるのを避けるため
  const LOWEST_DEVICE = '0000000000000000';
  function initialVer(raw, deviceId, adoptRemote) {
    const now = Date.now();
    let t = 0;
    if (isPlainObject(raw)) {
      for (const f of ['updatedAt', 'updated', 'createdAt']) {
        const v = raw[f];
        const n = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN);
        if (Number.isFinite(n) && n > 0) { t = n; break; }
      }
    }
    if (t === 0 && adoptRemote) return makeVer(0, 0, LOWEST_DEVICE);
    return makeVer(Math.min(Math.floor(t), now), 0, deviceId);
  }

  // ===================== 画像の要約の控え（2026-10-08） =====================
  // DBを見直すたびに、すべての画像を読み込んで要約（HMAC）を取り直していた。画像の多いアプリでは、
  // これが同期の時間の大半になる（スマホでは数秒）。画像の大きさ・種類と、頭と尻の16KBずつの要約を
  // 「控えの鍵」にして、前に取った要約を使い回す。控えはこの端末の同期の管理用DB（sideops_sync の meta）にだけ置く。
  // 1日1回の全体の見直し（freshBlobs）では控えを使わずに取り直す（万一の取り違えも、そこで直る）
  const BLOB_SAMPLE = 16 * 1024;
  const BLOB_CACHE_MIN = 64 * 1024;          // これより小さい画像は全部読む（控えを使うほどでもない）
  const BLOB_CACHE_MAX_ENTRIES = 20000;
  async function loadBlobCache(spaceId) {
    const c = await metaGet('blobcache');
    const map = c && c.spaceId === spaceId && isPlainObject(c.map) ? new Map(Object.entries(c.map)) : new Map();
    return { spaceId, map, changed: false };
  }
  async function saveBlobCache(cache) {
    if (!cache || !cache.changed) return;
    let entries = Array.from(cache.map.entries());
    if (entries.length > BLOB_CACHE_MAX_ENTRIES) entries = entries.slice(entries.length - BLOB_CACHE_MAX_ENTRIES);
    await metaPut({ key: 'blobcache', spaceId: cache.spaceId, map: Object.fromEntries(entries) });
  }
  async function blobQuickKey(blob) {
    const head = new Uint8Array(await blob.slice(0, BLOB_SAMPLE).arrayBuffer());
    const tail = new Uint8Array(await blob.slice(Math.max(BLOB_SAMPLE, blob.size - BLOB_SAMPLE)).arrayBuffer());
    const buf = new Uint8Array(head.length + tail.length);
    buf.set(head, 0);
    buf.set(tail, head.length);
    return blob.size + ':' + (blob.type || '') + ':' + await sha256Hex(buf);
  }
  // ctx.blobs には、読み込んだ中身（Uint8Array）か、まだ読んでいない Blob が入る。中身が要るときはこれで読む
  async function blobBytes(v) {
    return v instanceof Blob ? new Uint8Array(await v.arrayBuffer()) : v;
  }

  // ===================== レコードの符号化（Blob・data URLを参照に置き換える） =====================
  async function encodeValue(v, ctx, depth = 0) {
    if (depth > MAX_DEPTH) throw new SyncError('入れ子が深すぎるデータがあります');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.length >= DATAURL_MIN_LENGTH && v.startsWith('data:') ? encodeDataUrl(v, ctx) : v;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) return Object.is(v, -0) ? 0 : v;
      return { $sideopsNum: String(v) };
    }
    if (v === undefined) return undefined;
    if (typeof v !== 'object') throw new SyncError('対応していない種類のデータがあります（' + typeof v + '）');
    if (v instanceof Blob) {
      // 画像の要約の控え（下の blobQuickKey）があれば、画像を全部読まずに済ませる。
      // 送るときなど中身が要るときは、あとで読む（ctx.blobs には Blob のまま入れておく）
      let h = null, bytes = null, qk = null;
      const cache = ctx.blobCache;
      if (cache && v.size >= BLOB_CACHE_MIN) {
        qk = await blobQuickKey(v);
        h = cache.map.get(qk) || null;
        if (h && !HASH_RE.test(h)) h = null;
      }
      if (!h) {
        bytes = new Uint8Array(await v.arrayBuffer());
        h = await ctx.hash(bytes);
        if (qk) { cache.map.set(qk, h); cache.changed = true; }
      }
      ctx.blobs.set(h, bytes || v);
      const m = { $sideopsBlob: h, type: v.type || '', size: v.size };
      if (typeof File !== 'undefined' && v instanceof File) { m.fileName = v.name; m.lastModified = v.lastModified; }
      return m;
    }
    if (v instanceof Date) {
      if (!Number.isFinite(v.getTime())) throw new SyncError('不正な日付のデータがあります');
      return { $sideopsDate: v.toISOString() };
    }
    if (v instanceof ArrayBuffer || v instanceof Uint8Array) {
      const bytes = v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new Uint8Array(v);
      const h = await ctx.hash(bytes);
      ctx.blobs.set(h, bytes);
      return { $sideopsBytes: h, view: v instanceof ArrayBuffer ? 'ArrayBuffer' : 'Uint8Array', size: bytes.length };
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) { const e = await encodeValue(x, ctx, depth + 1); out.push(e === undefined ? null : e); }
      return out;
    }
    if (!isPlainObject(v)) throw new SyncError('対応していない種類のデータがあります（' + (v.constructor && v.constructor.name) + '）');
    const out = {};
    for (const k of Object.keys(v)) {
      if (k.startsWith('$sideops')) throw new SyncError('同期用に予約した項目名（$sideops…）を含むデータがあります');
      const e = await encodeValue(v[k], ctx, depth + 1);
      if (e !== undefined) out[k] = e;
    }
    return out;
  }
  async function encodeDataUrl(s, ctx) {
    const comma = s.indexOf(',');
    if (comma < 0 || comma > 200) return s;
    const prefix = s.slice(0, comma);
    if (!DATAURL_PREFIX_RE.test(prefix)) return s;
    const payload = s.slice(comma + 1);
    let bytes;
    try { bytes = b64ToBytes(payload); } catch (err) { return s; }
    if (bytesToB64(bytes) !== payload) return s; // 元の文字列に正確に戻せない形は分離しない
    const h = await ctx.hash(bytes);
    ctx.blobs.set(h, bytes);
    return { $sideopsDataUrl: h, prefix, size: bytes.length };
  }
  function blobRefs(v, out = new Set(), depth = 0) {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return out;
    if (Array.isArray(v)) { v.forEach((x) => blobRefs(x, out, depth + 1)); return out; }
    for (const m of ['$sideopsBlob', '$sideopsDataUrl', '$sideopsBytes']) {
      if (typeof v[m] === 'string') { out.add(v[m]); return out; }
    }
    Object.keys(v).forEach((k) => blobRefs(v[k], out, depth + 1));
    return out;
  }
  function decodeValue(v, bytesOf, depth = 0) {
    if (depth > MAX_DEPTH) throw new SyncError('入れ子が深すぎるデータがあります');
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => decodeValue(x, bytesOf, depth + 1));
    if (typeof v.$sideopsBlob === 'string') {
      const bytes = bytesOf(v.$sideopsBlob);
      const type = typeof v.type === 'string' ? v.type : '';
      if (typeof v.fileName === 'string' && typeof File !== 'undefined') {
        return new File([bytes], v.fileName, { type, lastModified: Number(v.lastModified) || 0 });
      }
      return new Blob([bytes], { type });
    }
    if (typeof v.$sideopsDataUrl === 'string') {
      if (typeof v.prefix !== 'string' || !DATAURL_PREFIX_RE.test(v.prefix)) throw new SyncError('不正な画像データがあります');
      return v.prefix + ',' + bytesToB64(bytesOf(v.$sideopsDataUrl));
    }
    if (typeof v.$sideopsBytes === 'string') {
      const bytes = bytesOf(v.$sideopsBytes);
      return v.view === 'ArrayBuffer' ? bytes.slice().buffer : new Uint8Array(bytes);
    }
    if (typeof v.$sideopsDate === 'string') return new Date(v.$sideopsDate);
    if (typeof v.$sideopsNum === 'string') return Number(v.$sideopsNum);
    const out = {};
    for (const k of Object.keys(v)) out[k] = decodeValue(v[k], bytesOf, depth + 1);
    return out;
  }
  async function fingerprint(encoded) {
    return sha256Hex(te.encode(canonical(encoded)));
  }

  // IndexedDBのキー → 状態管理用の文字列。文字列・数値・それらの配列だけを扱う
  function keyStr(key) {
    if (typeof key === 'string') return 's:' + key;
    if (typeof key === 'number' && Number.isFinite(key)) return 'n:' + key;
    if (Array.isArray(key) && key.every((k) => typeof k === 'string' || (typeof k === 'number' && Number.isFinite(k)))) return 'a:' + JSON.stringify(key);
    throw new SyncError('対応していない種類のキーがあります');
  }
  function validKey(key) {
    try { keyStr(key); return true; } catch (err) { return false; }
  }
  function rid(db, store, key) { return db + '\u001f' + store + '\u001f' + keyStr(key); }
  function keyAtPath(value, keyPath) {
    if (typeof keyPath !== 'string') return undefined;
    let cur = value;
    for (const part of keyPath.split('.')) {
      if (!isPlainObject(cur)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  // ===================== 各アプリのDB =====================
  async function localDbVersions() {
    if (typeof indexedDB.databases !== 'function') {
      throw new SyncError('このブラウザは同期に対応していません（indexedDB.databases がありません）');
    }
    const list = await indexedDB.databases();
    return new Map(list.filter((d) => d && d.name).map((d) => [d.name, d.version]));
  }
  // すでにあるDBだけを開く。万一なかった場合は作らせずに中止する
  function openExistingDb(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      let aborted = false;
      req.onupgradeneeded = () => { aborted = true; req.transaction.abort(); };
      req.onsuccess = () => { const d = req.result; d.onversionchange = () => d.close(); resolve(d); };
      req.onerror = () => reject(aborted ? new SyncError(name + ' がこの端末にありません') : req.error);
      req.onblocked = () => reject(new SyncError(name + ' を開けませんでした（他のタブで使用中）'));
    });
  }
  // この端末にまだないDBを、同期ファイルに記録された形（ストア・キー・索引）で作る
  function createDbFromSchema(name, version, schema) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const [storeName, s] of Object.entries(schema)) {
          if (d.objectStoreNames.contains(storeName)) continue;
          const os = d.createObjectStore(storeName, { keyPath: s.keyPath === undefined ? null : s.keyPath, autoIncrement: !!s.autoIncrement });
          for (const ix of s.indexes || []) os.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique, multiEntry: !!ix.multiEntry });
        }
      };
      req.onsuccess = () => { const d = req.result; d.onversionchange = () => d.close(); resolve(d); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new SyncError(name + ' を作れませんでした（他のタブで使用中）'));
    });
  }
  function validSchema(schema) {
    if (!isPlainObject(schema)) return false;
    return Object.entries(schema).every(([n, s]) => typeof n === 'string' && n && isPlainObject(s)
      && (s.keyPath === null || typeof s.keyPath === 'string' || (Array.isArray(s.keyPath) && s.keyPath.every((p) => typeof p === 'string')))
      && Array.isArray(s.indexes || []) && (s.indexes || []).every((ix) => isPlainObject(ix) && typeof ix.name === 'string'
        && (typeof ix.keyPath === 'string' || (Array.isArray(ix.keyPath) && ix.keyPath.every((p) => typeof p === 'string')))));
  }
  function readSchema(db, storeNames) {
    const schema = {};
    if (!storeNames.length) return schema;
    const tx = db.transaction(storeNames);
    for (const n of storeNames) {
      const os = tx.objectStore(n);
      schema[n] = {
        keyPath: os.keyPath, autoIncrement: os.autoIncrement,
        indexes: Array.from(os.indexNames).map((ix) => {
          const i = os.index(ix);
          return { name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry };
        }),
      };
    }
    return schema;
  }
  function syncedStores(rule, db) {
    const all = Array.from(db.objectStoreNames);
    if (rule.only) return all.filter((n) => Object.prototype.hasOwnProperty.call(rule.only, n));
    return all.filter((n) => !(rule.excludeStores || []).includes(n));
  }
  // only 指定のレコードから、同期する項目だけを取り出す
  function project(rule, storeName, key, raw, keyPath) {
    const fields = rule.only && rule.only[storeName] && rule.only[storeName][key];
    if (!fields || !isPlainObject(raw)) return raw;
    const out = {};
    if (typeof keyPath === 'string') out[keyPath] = raw[keyPath];
    for (const f of fields) if (raw[f] !== undefined) out[f] = raw[f];
    return out;
  }

  // DBの今の中身を読む（同期の対象のストア・レコードだけ）
  // 戻り値：{ schema, stores, recs: Map(rid → { store, key, raw, encoded, fp }) , blobs: Map(hash → bytes), skipped }
  //   schema は同期しないストアも含めた全ストアの形（ほかの端末でDBを作るときに、
  //   アプリが必要とするストアを欠かさないため）
  async function scanDb(rule, db, hash, blobCache, detail) {
    const dt = detail || { read: 0, encode: 0, fp: 0, n: 0 }; // かかった時間の内訳（同期の記録用）
    const stores = syncedStores(rule, db);
    const schema = readSchema(db, Array.from(db.objectStoreNames));
    const recs = new Map();
    const blobs = new Map();
    let skipped = 0;
    for (const storeName of stores) {
      const tx = db.transaction(storeName);
      const os = tx.objectStore(storeName);
      let keys, values;
      if (rule.only) {
        const wanted = Object.keys(rule.only[storeName] || {});
        values = await Promise.all(wanted.map((k) => reqP(os.get(k))));
        keys = wanted.filter((k, i) => values[i] !== undefined);
        values = values.filter((v) => v !== undefined);
      } else {
        const tr = performance.now();
        [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
        dt.read += performance.now() - tr;
      }
      for (let i = 0; i < keys.length; i++) {
        if (i % 25 === 24) await yieldUi(); // 件数の多いDBでも画面が固まらないように
        const key = keys[i];
        if (!validKey(key)) { skipped++; continue; }
        const raw = project(rule, storeName, key, values[i], os.keyPath);
        const ctx = { hash, blobs: new Map(), blobCache: blobCache || null };
        let encoded;
        const te0 = performance.now();
        try { encoded = await encodeValue(raw, ctx); } catch (err) {
          skipped++;
          console.warn('同期できないレコードを飛ばしました', rule.name, storeName, key, err);
          continue;
        }
        ctx.blobs.forEach((b, h) => blobs.set(h, b));
        const tf = performance.now();
        dt.encode += tf - te0;
        const fp = await fingerprint(encoded);
        dt.fp += performance.now() - tf;
        dt.n++;
        recs.set(rid(rule.name, storeName, key), { store: storeName, key, raw, encoded, fp });
      }
    }
    return { schema, stores, recs, blobs, skipped };
  }

  // ===================== 保存先（list/read/write/remove の4操作） =====================
  // 段階1：同期ファイルを読み込んだメモリ上の保存先。クラウド対応時は同じ4操作を持つ別の実装を足す
  function createMemoryBackend(files) {
    const map = files || new Map();
    return {
      kind: 'file',
      files: map,
      async list() { return Array.from(map.keys()); },
      async read(name) { return map.has(name) ? map.get(name) : null; },
      async write(name, bytes) { map.set(name, bytes); },
      async remove(name) { map.delete(name); },
    };
  }
  function backendFromPackage(obj) {
    if (!isPlainObject(obj) || obj.format !== PACKAGE_FORMAT) throw new SyncError('SIDE-OPSの同期ファイルではありません');
    if (typeof obj.formatVersion !== 'number' || obj.formatVersion > FORMAT_VERSION) {
      throw new SyncError('新しい版のSIDE-OPSで作られた同期ファイルです。SIDE-OPSを再読み込みして更新してください');
    }
    if (!isPlainObject(obj.files)) throw new SyncError('同期ファイルが壊れています');
    const map = new Map();
    for (const [name, b64] of Object.entries(obj.files)) {
      if (!/^[\w.-]{1,120}$/.test(name) || typeof b64 !== 'string') throw new SyncError('同期ファイルが壊れています（' + name.slice(0, 40) + '）');
      try { map.set(name, b64ToBytes(b64)); } catch (err) { throw new SyncError('同期ファイルが壊れています（' + name.slice(0, 40) + '）'); }
    }
    return createMemoryBackend(map);
  }
  function packageBlob(backend, spaceId) {
    const files = {};
    Array.from(backend.files.keys()).sort().forEach((n) => { files[n] = bytesToB64(backend.files.get(n)); });
    const obj = { format: PACKAGE_FORMAT, formatVersion: FORMAT_VERSION, spaceId, exportedAt: new Date().toISOString(), files };
    return new Blob([JSON.stringify(obj)], { type: 'application/json' });
  }
  async function readManifest(backend) {
    // クラウドでは、版の印（eTag）が前回読んだときと同じなら、控えを使ってダウンロードしない（2026-10-08。
    // 毎回の同期で設定を1〜2回ダウンロードしていた）。設定は暗号化しない公開の形なので、控えを置いても漏れるものはない
    const cacheable = backend.kind !== 'file' && typeof backend.stamp === 'function';
    let st = '';
    if (cacheable) {
      await backend.list();
      st = backend.stamp(MANIFEST_NAME) || '';
      const c = st ? await metaGet('manifestCache') : null;
      if (c && c.kind === backend.kind && c.stamp === st && isPlainObject(c.value)) {
        try { return validateManifest(c.value); } catch (err) { /* 控えが古い形なら読み直す */ }
      }
    }
    const bytes = await backend.read(MANIFEST_NAME);
    if (!bytes) return null;
    let m;
    try { m = JSON.parse(td.decode(bytes)); } catch (err) { throw new SyncError('同期ファイルの設定（manifest）が壊れています'); }
    const v = validateManifest(m);
    if (cacheable && st) await metaPut({ key: 'manifestCache', kind: backend.kind, stamp: st, value: m });
    return v;
  }

  // ===================== 鍵の状態 =====================
  async function getKeys() {
    const k = await metaGet('keys');
    return k && k.encKey && k.nameKey ? k : null;
  }
  async function saveKeys(manifest, keys) {
    await metaPut({ key: 'keys', spaceId: manifest.spaceId, keyId: keys.keyId, keyGen: manifest.keyGen || 1, encKey: keys.encKey, nameKey: keys.nameKey, savedAt: Date.now() });
    await metaPut({ key: 'manifest', value: manifest });
  }
  // 保存先の状態を確かめる：empty（同期がまだない）/ needsPassphrase / ready / otherSpace（この端末は別の同期を使っている）
  async function inspect(backend) {
    const manifest = await readManifest(backend);
    if (!manifest) return { state: 'empty', manifest: null };
    const keys = await getKeys();
    if (!keys) return { state: 'needsPassphrase', manifest };
    if (keys.spaceId !== manifest.spaceId || keys.keyId !== manifest.keyId) return { state: 'otherSpace', manifest };
    return { state: 'ready', manifest };
  }
  async function unlock(manifest, passphrase) {
    const keys = await unlockManifest(manifest, passphrase);
    await saveKeys(manifest, keys);
  }
  async function createSpace(passphrase) {
    const msg = checkPassphraseRule(passphrase);
    if (msg) throw new SyncError(msg);
    const { manifest, keys } = await createManifest(passphrase);
    await saveKeys(manifest, keys);
    await addLog('info', '新しい同期を作りました');
    return manifest;
  }
  // ---- 小さな秘密（クラウドの更新用トークン等）を、同期の鍵で暗号化して保存する ----
  // 鍵がまだない端末では保存しない（呼び出し側はメモリだけで持つ）
  async function saveSecret(name, value) {
    const keys = await getKeys();
    if (!keys) return false;
    const data = await seal(keys.encKey, te.encode(String(value)), 'sideops-sync|secret|' + name);
    await metaPut({ key: 'secret:' + name, data, savedAt: Date.now() });
    return true;
  }
  async function loadSecret(name) {
    const keys = await getKeys();
    if (!keys) return null;
    const rec = await metaGet('secret:' + name);
    if (!rec || !(rec.data instanceof Uint8Array)) return null;
    try { return td.decode(await unseal(keys.encKey, rec.data, 'sideops-sync|secret|' + name)); } catch (err) { return null; }
  }
  async function deleteSecret(name) {
    const d = await syncDb();
    const tx = d.transaction('meta', 'readwrite');
    tx.objectStore('meta').delete('secret:' + name);
    await txDone(tx);
  }

  // 「この端末を忘れる」：鍵と同期の状態を消す（アプリのデータは消さない）。クラウドへの接続と、
  // 覚えているログイン（暗号化した更新用トークン）も消す
  async function forgetDevice() {
    const d = await syncDb();
    const secretKeys = (await reqP(d.transaction('meta').objectStore('meta').getAllKeys())).filter((k) => typeof k === 'string' && k.startsWith('secret:'));
    const tx = d.transaction(['meta', 'records', 'conflicts', 'journal'], 'readwrite');
    ['keys', 'manifest', 'clock', 'dbs', 'status', 'device', 'cloud', 'written', 'seen', 'own', 'scanned', ...secretKeys].forEach((k) => tx.objectStore('meta').delete(k));
    tx.objectStore('journal').clear();
    tx.objectStore('records').clear();
    tx.objectStore('conflicts').clear();
    await txDone(tx);
    const prefs = await getPrefs();
    prefs.sensitiveOk = {};
    prefs.firstBackupDone = false;
    await metaPut(prefs);
    await addLog('info', 'この端末の同期を解除しました（鍵と同期の状態を消去）');
  }

  // ===================== 同期の本体 =====================
  function fileNames(keys) {
    return {
      device: async (deviceId) => 'd_' + (await hmacHex(keys.nameKey, 'device|' + deviceId)).slice(0, 32) + '.bin',
      db: async (deviceId, dbName) => 'b_' + (await hmacHex(keys.nameKey, 'db|' + deviceId + '|' + dbName)).slice(0, 32) + '.bin',
      blob: (hash) => 'x_' + hash + '.bin',
      // 同期のログ（2026-10-08）：「ログを書き出す」を押したときだけ置く。同期そのものは読まない（l_ で始まる名前は無視する）
      log: async (deviceId) => 'l_' + (await hmacHex(keys.nameKey, 'log|' + deviceId)).slice(0, 32) + '.bin',
    };
  }
  async function writeJsonFile(backend, keys, spaceId, name, obj) {
    const sealed = await seal(keys.encKey, await gzip(te.encode(JSON.stringify(obj))), 'sideops-sync|' + spaceId + '|' + name);
    await backend.write(name, sealed);
  }
  async function readJsonFile(backend, keys, spaceId, name) {
    const bytes = await backend.read(name);
    if (!bytes) return null;
    const plain = await gunzip(await unseal(keys.encKey, bytes, 'sideops-sync|' + spaceId + '|' + name));
    try { return JSON.parse(td.decode(plain)); } catch (err) { throw new SyncError('同期ファイルの中身が壊れています'); }
  }
  function validEntry(e) {
    return isPlainObject(e) && validKey(e.key) && typeof e.ver === 'string' && VER_RE.test(e.ver)
      && (e.deleted === true ? true : e.value !== undefined);
  }

  // hooks：
  //   confirmSensitive(rule) → Promise<boolean>：顧客データを初めて同期する前の確認（ないときは、そのDBを今回は飛ばす）
  //   scanAll：印に関係なく、すべてのDBを見直す（☁を押したとき・1日1回）
  //   pushOnly：送るだけ（ほかの端末の変更は読まず、この端末のデータ帳も書き換えない。アプリを開いている間に使う）
  //   onProgress(text)：進み具合の表示
  // 戻り値：{ results: [...], applied, appliedDbs, conflicts, firstTime, pushOnly, stats }
  // 保存先の4操作の時間を測る（中身は変えない）
  function timedBackend(backend, timing) {
    // 操作の種類ごとに、回数・時間・バイト数も数える（同期のログ用）
    timing.ops = timing.ops || {};
    const wrap = (name, fn) => (typeof fn !== 'function' ? fn : async (...a) => {
      const t = performance.now();
      const o = timing.ops[name] || (timing.ops[name] = { n: 0, ms: 0, bytes: 0 });
      let r;
      try { r = await fn(...a); return r; } finally {
        const dt = performance.now() - t;
        timing.net += dt; timing.netCount++;
        o.n++; o.ms += dt;
        if (name === 'read' && r && typeof r.length === 'number') o.bytes += r.length;
        if (name === 'write' && a[1] && typeof a[1].length === 'number') o.bytes += a[1].length;
      }
    });
    return { ...backend, list: wrap('list', backend.list), read: wrap('read', backend.read), write: wrap('write', backend.write), remove: wrap('remove', backend.remove) };
  }
  async function syncWith(backend, hooks = {}) {
    const progress = (t) => { try { if (hooks.onProgress) hooks.onProgress(t); } catch (err) { /* 表示に失敗しても続ける */ } };
    // かかった時間の内訳（2026-10-08）：通信（保存先とのやり取り）とDBの見直しを分けて測り、同期の記録に残す
    const timing = { start: performance.now(), net: 0, netCount: 0, scan: {}, scanDetail: {}, apply: {} };
    backend = timedBackend(backend, timing);
    const keys = await getKeys();
    if (!keys) throw new SyncError('この端末はまだ同期の鍵を持っていません');
    progress('クラウドを確認しています');
    const manifest = await readManifest(backend);
    if (!manifest) throw new SyncError('同期ファイルに設定（manifest）がありません');
    if (manifest.spaceId !== keys.spaceId || manifest.keyId !== keys.keyId) throw new SyncError('この端末は別の同期を使っています');
    const spaceId = manifest.spaceId;
    const pushOnly = !!hooks.pushOnly;
    const scanAll = !!hooks.scanAll && !pushOnly;
    const dev = await getDevice();
    const prefs = await getPrefs();
    const clock = createClock(await metaGet('clock'), dev.id);
    const dbsMeta = (await metaGet('dbs')) || { key: 'dbs', synced: {} };
    const names = fileNames(keys);
    const hash = (bytes) => hmacHex(keys.nameKey, bytes);
    const report = { results: [], applied: false, appliedDbs: [], conflicts: 0, conflictIds: [], firstTime: false, pushOnly, stats: { scanned: 0, skipped: 0, downloaded: 0 } };
    const journalItems = []; // 受け取りで書き換える前の中身（同期の記録。取り消しに使う）
    // 画像の要約の控え（1日1回の全体の見直しでは使わずに取り直す）
    const blobCache = hooks.freshBlobs ? { spaceId, map: new Map(), changed: true } : await loadBlobCache(spaceId);

    // クラウドでは、中身が前回書いたときと同じファイルは書き直さない（通信を減らす）。
    // 前回書いた時点の「中身の要約」と「保存先での版の印（eTag）」の両方が一致するときだけ省く。
    // 同期ファイル（手で運ぶ形）は、古いファイルを読み込み直した場合に備えて、毎回すべて書く
    const cacheable = backend.kind !== 'file' && typeof backend.stamp === 'function';
    const stampOf = (n) => (cacheable ? backend.stamp(n) || '' : '');
    let written = null;
    if (cacheable) {
      const w = await metaGet('written');
      written = w && w.spaceId === spaceId && w.kind === backend.kind && isPlainObject(w.files) ? w : { key: 'written', spaceId, kind: backend.kind, files: {} };
    }
    async function writeIfChanged(name, obj) {
      const rest = { ...obj };
      delete rest.writtenAt;
      const digest = written ? await sha256Hex(te.encode(canonical(rest))) : '';
      const prev = written && written.files[name];
      if (prev && prev.digest === digest && prev.stamp === stampOf(name)) return false;
      await writeJsonFile(backend, keys, spaceId, name, obj);
      if (written) written.files[name] = { digest, stamp: stampOf(name) };
      return true;
    }
    // ほかの端末のファイルで、前回取り込んだ時から版の印が変わっていないものは、ダウンロードしない
    let seen = { files: {} };
    if (cacheable) {
      const s = await metaGet('seen');
      if (s && s.spaceId === spaceId && s.kind === backend.kind && isPlainObject(s.files)) seen = s;
    }
    const seenNext = { key: 'seen', spaceId, kind: backend.kind, files: {} };
    const unchanged = (n) => cacheable && !!seen.files[n] && !!seen.files[n].stamp && seen.files[n].stamp === stampOf(n);
    // 自分が前回書いた内容（DBのファイルの一覧と、参照している画像）
    const ownRec = await metaGet('own');
    const ownMeta = ownRec && ownRec.spaceId === spaceId && ownRec.kind === backend.kind && isPlainObject(ownRec.dbs) ? ownRec : null;
    const scannedRec = (await metaGet('scanned')) || { key: 'scanned', dbs: {} };
    const dirtyAt = readDirtyMarks();

    // ---- ほかの端末の目次を読む（検査を通るまで、何も書き換えない） ----
    const listed = new Set(await backend.list());
    const remoteDevices = [];
    let ownPrev = null;
    const devName = await names.device(dev.id);
    for (const name of listed) {
      if (!name.startsWith('d_')) continue;
      if (pushOnly && name !== devName) continue;
      let info;
      if (unchanged(name) && isPlainObject(seen.files[name].info)) {
        info = seen.files[name].info;
      } else {
        info = await readJsonFile(backend, keys, spaceId, name);
        report.stats.downloaded++;
      }
      if (!isPlainObject(info) || info.format !== 'sideops-sync-device' || !DEVICE_ID_RE.test(info.device) || !isPlainObject(info.dbs)) {
        throw new SyncError('同期ファイルの中身が壊れています（端末の情報）');
      }
      if (name !== await names.device(info.device)) throw new SyncError('同期ファイルの中身が壊れています（端末の情報の名前が合いません）');
      if (typeof info.formatVersion !== 'number' || info.formatVersion > FORMAT_VERSION
        || (typeof info.appBuild === 'number' && info.appBuild > SYNC_APP_BUILD)) {
        throw new SyncError(`「${String(info.deviceName || '別の端末').slice(0, 40)}」が新しい版のSIDE-OPSで書いたデータがあります。SIDE-OPSを再読み込みして更新してから、もう一度同期してください`);
      }
      seenNext.files[name] = { stamp: stampOf(name), info };
      if (info.device === dev.id) { ownPrev = info; continue; }
      remoteDevices.push(info);
    }
    const prevOwnDbs = (ownMeta && ownMeta.dbs) || (ownPrev && ownPrev.dbs) || {};
    const prevOwnBlobs = (ownMeta && isPlainObject(ownMeta.blobs) && ownMeta.blobs) || {};
    report.devices = remoteDevices.map((i) => ({ name: String(i.deviceName || '別の端末').slice(0, 40), at: i.lastWriteAt || i.writtenAt || '' }));
    // 版の末尾の端末IDから、その変更をした端末の名前を引く（競合の控えに残す。2026-10-10）
    const devNames = new Map(remoteDevices.map((i) => [i.device, String(i.deviceName || '別の端末').slice(0, 40)]));
    const verBy = (v) => (typeof v !== 'string' ? '' : v.slice(19) === dev.id ? 'この端末' : devNames.get(v.slice(19)) || '別の端末');

    // ---- ほかの端末のDBのファイル：版の印が変わったものだけダウンロードする ----
    const referenced = new Set();
    const remoteFiles = new Map(); // DB名 → [{ info, name, changed, file, dbVersion, blobs }]
    async function loadEntry(e) {
      const f = await readJsonFile(backend, keys, spaceId, e.name);
      report.stats.downloaded++;
      if (!f) return false; // 目次だけ残ってファイルがない（書き込み途中で止まった等）→ 無視
      if (!isPlainObject(f) || f.format !== 'sideops-sync-db' || f.db !== e.db || f.device !== e.info.device
        || !Number.isInteger(f.dbVersion) || !validSchema(f.schema) || !isPlainObject(f.stores)) {
        throw new SyncError('同期ファイルの中身が壊れています（' + ruleLabel(e.db) + '）');
      }
      e.file = f;
      e.dbVersion = f.dbVersion;
      e.blobs = Array.isArray(f.blobs) ? f.blobs.filter((h) => typeof h === 'string') : [];
      return true;
    }
    for (const info of remoteDevices) {
      for (const [dbName, ref] of Object.entries(info.dbs)) {
        const expected = await names.db(info.device, dbName);
        if (!isPlainObject(ref) || ref.file !== expected) throw new SyncError('同期ファイルの中身が壊れています（DBのファイル名が合いません）');
        if (!listed.has(expected)) continue;
        const e = { info, db: dbName, name: expected, changed: !unchanged(expected), file: null, dbVersion: null, blobs: null };
        if (e.changed) {
          if (!(await loadEntry(e))) continue;
        } else {
          e.dbVersion = seen.files[expected].dbVersion;
          e.blobs = Array.isArray(seen.files[expected].blobs) ? seen.files[expected].blobs : [];
        }
        e.blobs.forEach((h) => referenced.add(h));
        if (!remoteFiles.has(dbName)) remoteFiles.set(dbName, []);
        remoteFiles.get(dbName).push(e);
      }
    }

    const localVersions = await localDbVersions();
    const ownDbs = {};
    const ownBlobs = {};
    let gcSafe = true;
    let wroteAny = false; // 今回、DBのファイルを実際に送ったか（端末の目次の「最後に送った時刻」に使う）
    const d = await syncDb();

    for (const rule of DB_RULES) {
      const res = {
        db: rule.name, label: rule.label, pulled: 0, removed: 0, pushed: 0, conflicts: 0, note: '',
        inAdd: 0, inChange: 0, inDel: 0, outAdd: 0, outChange: 0, outDel: 0,
      };
      report.results.push(res);
      const remotes = remoteFiles.get(rule.name) || [];
      const keepPrev = () => {
        if (prevOwnDbs[rule.name]) {
          ownDbs[rule.name] = prevOwnDbs[rule.name];
          if (Array.isArray(prevOwnBlobs[rule.name])) ownBlobs[rule.name] = prevOwnBlobs[rule.name];
          else gcSafe = false; // 自分の前回のファイルが参照している画像が分からない → 今回は片付けない
        }
      };
      // 取り込まなかったファイルは「取り込み済み」にしない（次回また読む）。変わっていないものは前回の印を引き継ぐ
      const carrySeen = (merged) => {
        for (const e of remotes) {
          if (merged && merged.includes(e)) seenNext.files[e.name] = { stamp: stampOf(e.name), dbVersion: e.dbVersion, blobs: e.blobs };
          else if (!e.changed && seen.files[e.name]) seenNext.files[e.name] = seen.files[e.name];
        }
      };
      if (prefs.disabled[rule.name]) { res.note = '同期しない設定'; carrySeen(); continue; }

      let localVersion = localVersions.get(rule.name);
      if (localVersion !== undefined && localVersion > rule.version) {
        res.note = 'この版のSIDE-OPSが知らないDBの版です（同期の設定の更新漏れ）。同期しません';
        keepPrev(); carrySeen();
        continue;
      }
      const firstTime = !dbsMeta.synced[rule.name];
      // 送るだけのときは、まだ一度もほかの端末と合流していないDBには触らない（初めての合流は通常の同期で行う）
      if (pushOnly && (firstTime || localVersion === undefined)) { keepPrev(); continue; }
      const lastScan = scannedRec.dbs[rule.name] || 0;
      const locallyDirty = firstTime || scanAll || !lastScan || (dirtyAt[rule.name] || 0) >= lastScan;
      const remoteChanged = !pushOnly && remotes.some((e) => e.changed);
      // 変わっていないDBは開きもしない（これが一番の軽量化）
      if (localVersion !== undefined && !locallyDirty && !remoteChanged) {
        keepPrev(); carrySeen();
        report.stats.skipped++;
        continue;
      }

      // DBの版が違う端末のデータは合流しない（移行前の形のデータで上書きしないため）
      const needAll = firstTime || localVersion === undefined;
      const usable = [];
      if (!pushOnly) {
        for (const e of remotes) {
          if (!needAll && !e.changed) continue; // 前回取り込み済みで、その後変わっていない
          if (!e.file && !(await loadEntry(e))) continue;
          if (localVersion === undefined ? e.dbVersion === rule.version : e.dbVersion === localVersion) usable.push(e);
          else res.note = `「${String(e.info.deviceName || '別の端末').slice(0, 40)}」とDBの版が違うため、その端末の分は取り込みませんでした（古い方の端末で${rule.label}を一度開いてから同期してください）`;
        }
      }
      if (localVersion === undefined && !usable.length) { keepPrev(); carrySeen(); continue; } // この端末にもなく、取り込めるデータもない

      // 顧客データ（RECON）は、初めて同期する前に1回確認する（送る側でも受け取る側でも）
      if (rule.sensitive && !prefs.sensitiveOk[rule.name]) {
        if (!hooks.confirmSensitive) {
          res.note = '確認待ち（☁から同期すると確認が出ます）';
          keepPrev(); carrySeen();
          continue;
        }
        const ok = await hooks.confirmSensitive(rule);
        if (!ok) {
          prefs.disabled[rule.name] = true;
          await metaPut(prefs);
          res.note = '送らないことを選んだため、同期しない設定にしました';
          carrySeen();
          continue;
        }
        prefs.sensitiveOk[rule.name] = true;
        await metaPut(prefs);
      }

      progress(`${rule.label}を確認しています`);
      report.stats.scanned++;
      // ---- 端末にDBがなければ、同期ファイルに記録された形で作る ----
      let db;
      if (localVersion === undefined) {
        db = await createDbFromSchema(rule.name, rule.version, usable[0].file.schema);
        localVersion = rule.version;
      } else {
        db = await openExistingDb(rule.name);
      }
      try {
        // ---- 前回同期した時点との比較（3方向比較） ----
        const stList = await reqP(d.transaction('records').objectStore('records').index('db').getAll(rule.name));
        const st = new Map(stList.map((s) => [s.id, s]));
        stList.forEach((s) => { if (typeof s.ver === 'string' && VER_RE.test(s.ver)) clock.observe(s.ver); });
        // ---- ほかの端末の最新の版を集める ----
        const best = new Map();
        const allowedStores = new Set(syncedStores(rule, db));
        for (const r of usable) {
          for (const [storeName, entries] of Object.entries(r.file.stores)) {
            if (!allowedStores.has(storeName) || !Array.isArray(entries)) continue;
            for (const e of entries) {
              if (!validEntry(e)) continue;
              if (rule.only && !(rule.only[storeName] && Object.prototype.hasOwnProperty.call(rule.only[storeName], e.key))) continue;
              clock.observe(e.ver);
              const id = rid(rule.name, storeName, e.key);
              const cur = best.get(id);
              if (!cur || e.ver > cur.ver) best.set(id, { store: storeName, key: e.key, ver: e.ver, deleted: e.deleted === true, value: e.value });
            }
          }
        }

        // ---- 前回同期した時点との比較で、この端末の変更を見つける ----
        const scanStart = Date.now();
        const scanT0 = performance.now();
        const sd = { read: 0, encode: 0, fp: 0, n: 0 };
        let scan = await scanDb(rule, db, hash, blobCache, sd);
        timing.scan[rule.name] = Math.round(performance.now() - scanT0);
        timing.scanDetail[rule.name] = { n: sd.n, read: Math.round(sd.read), encode: Math.round(sd.encode), fp: Math.round(sd.fp) };
        const changed = new Map(); // この端末の変更：id → { kind: 'add'|'change'|'del', ver（この端末で付けた版） }
        for (const [id, c] of scan.recs) {
          const s = st.get(id);
          if (!s) {
            const ver = firstTime ? initialVer(c.raw, dev.id, best.has(id)) : clock.next();
            if (ver.slice(19) !== LOWEST_DEVICE) clock.observe(ver);
            st.set(id, { id, db: rule.name, store: c.store, key: c.key, ver, fp: c.fp, deleted: false, dirty: true, baseVer: null });
            changed.set(id, { kind: 'add', ver });
          } else if (s.deleted || s.fp !== c.fp) {
            const kind = s.deleted ? 'add' : 'change';
            if (!s.dirty) { s.baseVer = s.ver; s.dirty = true; }
            s.ver = clock.next(); s.fp = c.fp; s.deleted = false;
            changed.set(id, { kind, ver: s.ver });
          }
        }
        for (const [id, s] of st) {
          if (s.deleted || scan.recs.has(id)) continue;
          if (!s.dirty) { s.baseVer = s.ver; s.dirty = true; }
          s.ver = clock.next(); s.deleted = true; s.fp = null;
          changed.set(id, { kind: 'del', ver: s.ver });
        }
        // 初めての合流で、同じ内容のデータが別々のIDで両方にあれば知らせる
        // （両方の端末で別々に登録した同じデータは、IDが違うので両方残る）
        if (firstTime && usable.length) {
          const dup = await countLikelyDuplicates(scan, best);
          if (dup) res.note = (res.note ? res.note + ' / ' : '') + `同じ内容で別々のIDのデータが${dup}件あります（両方の端末で別々に登録した可能性。不要な方を消すと、ほかの端末にも反映されます）`;
        }

        // ---- 合流：レコードごとに版の大きい方を採用。両方で変えていたら負けた方を控える ----
        const plan = [];         // { op: 'put'|'del', id, store, key, value(符号化済み) }
        const losers = [];       // { side, id, store, key, loserVer, winnerVer, raw | encoded, 勝った方：winnerRaw | winnerEnc, winnerDeleted }
        let n = 0;
        for (const [id, r] of best) {
          if (++n % 50 === 0) await yieldUi();
          const s = st.get(id);
          if (s && r.ver === s.ver) continue;
          // 中身がまったく同じなら、書き直さずに版だけ揃える（受け取り・送り出しにも数えない）
          if (s && ((s.deleted && r.deleted) || (!s.deleted && !r.deleted && await fingerprint(r.value) === s.fp))) {
            Object.assign(s, { ver: r.ver, dirty: false, baseVer: null });
            changed.delete(id);
            continue;
          }
          if (!s) {
            st.set(id, { id, db: rule.name, store: r.store, key: r.key, ver: r.ver, fp: null, deleted: r.deleted, dirty: false, baseVer: null });
            if (!r.deleted) plan.push({ op: 'put', id, store: r.store, key: r.key, value: r.value });
            continue;
          }
          if (r.ver > s.ver) {
            if (s.dirty && !s.deleted && (r.deleted || await fingerprint(r.value) !== s.fp)) {
              const c = scan.recs.get(id);
              if (c) losers.push({ side: 'local', id, store: s.store, key: s.key, loserVer: s.ver, winnerVer: r.ver, raw: c.raw, winnerEnc: r.deleted ? null : r.value, winnerDeleted: r.deleted });
            }
            if (r.deleted) { if (!s.deleted) plan.push({ op: 'del', id, store: r.store, key: r.key }); }
            else plan.push({ op: 'put', id, store: r.store, key: r.key, value: r.value });
            Object.assign(s, { ver: r.ver, deleted: r.deleted, dirty: false, baseVer: null, fp: null });
          } else if (s.dirty && !r.deleted && (s.baseVer === null || r.ver > s.baseVer)
            && (s.deleted || await fingerprint(r.value) !== s.fp)) {
            // こちらの変更が勝ったが、相手もその間に変えていた → 相手の版を控える
            const w = scan.recs.get(id);
            losers.push({ side: 'remote', id, store: r.store, key: r.key, loserVer: r.ver, winnerVer: s.ver, encoded: r.value, winnerRaw: s.deleted || !w ? null : w.raw, winnerDeleted: s.deleted || !w });
          }
        }

        // ---- 必要な画像を集めて検証する ----
        const need = new Set();
        plan.forEach((p) => { if (p.op === 'put') blobRefs(p.value, need); });
        losers.forEach((l) => { if (l.encoded) blobRefs(l.encoded, need); if (l.winnerEnc) blobRefs(l.winnerEnc, need); });
        const fetched = new Map();
        if (need.size) progress(`${rule.label}の画像を受け取っています`);
        for (const h of need) {
          if (!HASH_RE.test(h)) throw new SyncError('同期ファイルの中身が壊れています（画像の参照）');
          if (scan.blobs.has(h)) { fetched.set(h, await blobBytes(scan.blobs.get(h))); continue; }
          const name = names.blob(h);
          const bytes = await backend.read(name);
          if (!bytes) throw new SyncError(rule.label + ' の画像が同期ファイルに見つかりません');
          const plain = await unseal(keys.encKey, bytes, 'sideops-sync|' + spaceId + '|' + name);
          if (await hash(plain) !== h) throw new SyncError(rule.label + ' の画像が壊れています');
          fetched.set(h, plain);
        }
        const bytesOf = (h) => {
          const b = fetched.get(h);
          if (!b) throw new SyncError(rule.label + ' の画像が見つかりません');
          return b;
        };

        // ---- 同期の途中でアプリが開かれていたら、そのDBへの受け取りは次回に回す ----
        // （開いているアプリの足元のデータを書き換えないため。何も保存せずに、このDBを飛ばす）
        if (plan.length && hooks.canApply && !hooks.canApply(rule.name)) {
          res.note = 'アプリを開いていたため、受け取りは次の同期に回しました';
          keepPrev(); carrySeen();
          report.deferred = true;
          continue;
        }

        // ---- 反映（1トランザクション。失敗したら何も変わらない） ----
        if (plan.length) {
          const applyT0 = performance.now();
          progress(`${rule.label}を受け取っています`);
          const storeNames = [...new Set(plan.map((p) => p.store))];
          const keyPaths = readSchema(db, storeNames);
          // 書き換える前の中身（同期の記録に残す。only 指定のレコードは、端末ごとの項目を残すのにも使う）
          const existing = new Map();
          const rtx = db.transaction(storeNames);
          for (const p of plan) existing.set(p.id, await reqP(rtx.objectStore(p.store).get(p.key)));
          const prepared = [];
          for (const p of plan) {
            const kp = keyPaths[p.store].keyPath;
            if (p.op === 'del') { prepared.push({ ...p, kp }); continue; }
            let value = decodeValue(p.value, bytesOf);
            if (rule.only) {
              const fields = rule.only[p.store][p.key];
              const base = isPlainObject(existing.get(p.id)) ? { ...existing.get(p.id) } : {};
              for (const f of fields) { if (isPlainObject(value) && value[f] !== undefined) base[f] = value[f]; else delete base[f]; }
              if (typeof kp === 'string') base[kp] = p.key;
              value = base;
            }
            if (typeof kp === 'string' && keyStr(keyAtPath(value, kp)) !== keyStr(p.key)) {
              throw new SyncError(rule.label + ' に、キーと中身が合わないデータがあります');
            }
            prepared.push({ ...p, kp, value });
          }
          // 同期が自分で書き込む分は「変えたよ」の印を付けない（元の関数を使う）
          const wtx = db.transaction(storeNames, 'readwrite');
          const done = txDone(wtx);
          try {
            for (const p of prepared) {
              const os = wtx.objectStore(p.store);
              if (p.op === 'del') {
                if (rule.only) {
                  const fields = rule.only[p.store][p.key];
                  const cur = existing.get(p.id);
                  if (isPlainObject(cur)) { const v = { ...cur }; fields.forEach((f) => delete v[f]); RAW.put.call(os, v); }
                } else RAW.delete.call(os, p.key);
              } else if (p.kp === null) RAW.put.call(os, p.value, p.key);
              else RAW.put.call(os, p.value);
            }
          } catch (err) {
            try { wtx.abort(); } catch (e) { /* すでに終了 */ }
            throw err;
          }
          await done;
          // 受け取った変更の内訳（scan はまだ反映前の中身）
          for (const p of plan) {
            if (p.op === 'del') res.inDel++;
            else if (scan.recs.has(p.id)) res.inChange++;
            else res.inAdd++;
          }
          report.applied = true;
          report.appliedDbs.push(rule.name);
          // 反映後の中身で指紋を取り直す（次回、反映した分を「この端末の変更」と誤認しないように）
          scan = await scanDb(rule, db, hash, blobCache);
          for (const p of plan) {
            const s = st.get(p.id);
            const c = scan.recs.get(p.id);
            if (s && c) s.fp = c.fp;
            journalItems.push({ db: rule.name, store: p.store, key: p.key, kp: keyPaths[p.store].keyPath, before: existing.get(p.id), op: p.op, afterFp: c ? c.fp : null });
          }
          timing.apply[rule.name] = Math.round(performance.now() - applyT0); // 受け取った分の書き込みと、指紋の取り直し
        }

        // ---- 自分のファイルを書く：画像 → DBのファイル（端末の情報は最後にまとめて） ----
        // 並び順はキーの順に固定する（中身が同じなら、ファイルも同じになるように）
        const outStores = {};
        scan.stores.forEach((nm) => { outStores[nm] = []; });
        const usedBlobs = new Set();
        const ordered = Array.from(st.values()).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
        for (const s of ordered) {
          if (!outStores[s.store]) continue;
          if (s.deleted) { outStores[s.store].push({ key: s.key, ver: s.ver, deleted: true }); continue; }
          const c = scan.recs.get(s.id);
          if (!c) continue;
          blobRefs(c.encoded, usedBlobs);
          outStores[s.store].push({ key: s.key, ver: s.ver, value: c.encoded });
        }
        if (changed.size) progress(`${rule.label}を送っています`);
        for (const h of usedBlobs) {
          referenced.add(h);
          const name = names.blob(h);
          if (listed.has(name)) continue;
          const bytes = scan.blobs.has(h) ? await blobBytes(scan.blobs.get(h)) : null;
          if (!bytes) throw new SyncError(rule.label + ' の画像を読めませんでした');
          await backend.write(name, await seal(keys.encKey, bytes, 'sideops-sync|' + spaceId + '|' + name));
          listed.add(name);
        }
        const dbFile = await names.db(dev.id, rule.name);
        if (await writeIfChanged(dbFile, {
          format: 'sideops-sync-db', formatVersion: FORMAT_VERSION, db: rule.name, dbVersion: db.version,
          schema: scan.schema, appBuild: SYNC_APP_BUILD, device: dev.id, writtenAt: new Date().toISOString(),
          blobs: Array.from(usedBlobs).sort(), stores: outStores,
        })) wroteAny = true;
        listed.add(dbFile);
        ownDbs[rule.name] = { file: dbFile, dbVersion: db.version, count: scan.recs.size };
        ownBlobs[rule.name] = Array.from(usedBlobs).sort();
        // 送り出した変更の内訳。相手の新しい版に負けた変更は送っていない（競合として数える）
        for (const [id, ch] of changed) {
          const s = st.get(id);
          if (!s || s.ver !== ch.ver) continue;
          if (ch.kind === 'add') res.outAdd++;
          else if (ch.kind === 'change') res.outChange++;
          else res.outDel++;
        }
        res.pulled = res.inAdd + res.inChange;
        res.removed = res.inDel;
        res.pushed = res.outAdd + res.outChange + res.outDel;
        if (firstTime) report.firstTime = true;
        if (scan.skipped) res.note = (res.note ? res.note + ' / ' : '') + `同期できない形のレコード${scan.skipped}件を飛ばしました`;

        // ---- 状態を保存 ----
        // 送るだけのときは「送信済み」にしない：ほかの端末の変更と見比べていないので、
        // 次の同期で競合を見分けられるように、変更前の版（baseVer）を残しておく
        const now = Date.now();
        const wtx2 = d.transaction(['records', 'conflicts'], 'readwrite');
        const recOs = wtx2.objectStore('records');
        for (const s of st.values()) {
          if (!pushOnly) { s.dirty = false; s.baseVer = null; }
          recOs.put(s);
        }
        for (const l of losers) {
          let value = l.raw;
          if (l.encoded) value = decodeValue(l.encoded, bytesOf);
          // 勝った方の中身（winner）と、それぞれの変更をした端末（loserBy・winnerBy）も残す（「違いを見る」で見比べるため。2026-10-10）
          let winner = l.winnerDeleted ? null : l.winnerRaw;
          if (!l.winnerDeleted && l.winnerEnc !== undefined && l.winnerEnc !== null) winner = decodeValue(l.winnerEnc, bytesOf);
          const cid = randomHex(8);
          report.conflictIds.push(cid);
          wtx2.objectStore('conflicts').put({
            id: cid, at: now, db: rule.name, store: l.store, key: l.key, side: l.side, loserVer: l.loserVer, winnerVer: l.winnerVer, value,
            winner, winnerDeleted: !!l.winnerDeleted, loserBy: verBy(l.loserVer), winnerBy: verBy(l.winnerVer),
          });
        }
        await txDone(wtx2);
        res.conflicts = losers.length;
        report.conflicts += losers.length;
        dbsMeta.synced[rule.name] = true;
        scannedRec.dbs[rule.name] = scanStart;
        carrySeen(usable);
      } finally {
        db.close();
      }
    }

    // ---- 端末の情報（どのDBのファイルを持っているか）を最後に書く ----
    progress('仕上げています');
    // lastWriteAt：この端末が最後に実際にデータを送った時刻（ほかの端末に「最終送信」として見せる）
    const lastWriteAt = wroteAny ? new Date().toISOString() : ((ownMeta && ownMeta.lastWriteAt) || (ownPrev && ownPrev.lastWriteAt) || null);
    await writeIfChanged(devName, {
      format: 'sideops-sync-device', formatVersion: FORMAT_VERSION, device: dev.id, deviceName: dev.name,
      appBuild: SYNC_APP_BUILD, writtenAt: new Date().toISOString(), lastWriteAt, dbs: ownDbs,
    });
    listed.add(devName);
    // 使わなくなった自分のDBファイル（同期しない設定にしたDB等）を消す
    for (const [nm, ref] of Object.entries(prevOwnDbs)) {
      if (!ownDbs[nm] && ref && typeof ref.file === 'string' && listed.has(ref.file)) { await backend.remove(ref.file); listed.delete(ref.file); }
    }
    // どこからも参照されない画像を片付ける。同期ファイル（手で運ぶ形）ではその場で消す。
    // クラウドでは、ほかの端末が書き込みの途中の可能性があるため、最後に書き換えられてから
    // 一定期間たったものだけを消す。送るだけのときと、参照が分からないときは片付けない
    if (!pushOnly && gcSafe) {
      Object.values(ownBlobs).forEach((arr) => arr.forEach((h) => referenced.add(h)));
      for (const nm of Array.from(listed)) {
        if (!nm.startsWith('x_') || referenced.has(nm.slice(2, -4))) continue;
        if (backend.kind === 'file' || (typeof backend.ageMs === 'function' && backend.ageMs(nm) > BLOB_GRACE_MS)) { await backend.remove(nm); listed.delete(nm); }
      }
    }
    if (written) await metaPut(written);
    if (cacheable && !pushOnly) await metaPut(seenNext);
    await metaPut({ key: 'own', spaceId, kind: backend.kind, dbs: ownDbs, blobs: ownBlobs, lastWriteAt });
    await metaPut(scannedRec);
    await metaPut(clock.save());
    await metaPut(dbsMeta);
    const prevStatus = (await metaGet('status')) || {};
    const nowTs = Date.now();
    await metaPut({
      ...prevStatus, key: 'status', lastSyncKind: backend.kind,
      lastPushAt: nowTs,
      lastSyncAt: pushOnly ? (prevStatus.lastSyncAt || nowTs) : nowTs,
      lastFullScanAt: scanAll ? nowTs : (prevStatus.lastFullScanAt || 0),
      devices: pushOnly ? (prevStatus.devices || []) : report.devices,
      lastSummary: pushOnly ? (prevStatus.lastSummary || '') : summaryCounts(report),
    });
    if (journalItems.length) await addJournal(journalItems, backend.kind);
    await purgeConflicts();
    await addLog(pushOnly ? 'push' : 'sync', summarizeReport(report).join(' / ') || '変更なし');
    await saveBlobCache(blobCache);
    report.timing = {
      total: Math.round(performance.now() - timing.start), net: Math.round(timing.net), netCount: timing.netCount, scan: timing.scan, scanDetail: timing.scanDetail,
      ops: Object.fromEntries(Object.entries(timing.ops || {}).map(([k, o]) => [k, { n: o.n, ms: Math.round(o.ms), bytes: o.bytes }])),
      apply: timing.apply,
    };
    lastReport = report;
    return report;
  }

  // ---- 結果の表示：アプリごとに「受け取り」「送り出し」を、追加・変更・削除の内訳つきで ----
  function countParts(add, change, del) {
    return [add && `追加${add}`, change && `変更${change}`, del && `削除${del}`].filter(Boolean).join('・');
  }
  function resultLine(r) {
    const inN = r.inAdd + r.inChange + r.inDel;
    const outN = r.outAdd + r.outChange + r.outDel;
    const segs = [];
    if (inN) segs.push(`受け取り${inN}件（${countParts(r.inAdd, r.inChange, r.inDel)}）`);
    if (outN) segs.push(`送り出し${outN}件（${countParts(r.outAdd, r.outChange, r.outDel)}）`);
    if (r.conflicts) segs.push(`競合${r.conflicts}件`);
    if (!segs.length && !r.note) return '';
    return `${r.label}：${segs.length ? segs.join('／') : '変更なし'}${r.note ? `（${r.note}）` : ''}`;
  }
  function summarizeReport(report) {
    return report.results.map(resultLine).filter(Boolean);
  }
  // ☁の画面の「最後の同期」に添える短い要約
  function summaryCounts(report) {
    let inN = 0, outN = 0;
    report.results.forEach((r) => { inN += r.inAdd + r.inChange + r.inDel; outN += r.outAdd + r.outChange + r.outDel; });
    return inN || outN || report.conflicts ? `受け取り${inN}・送り出し${outN}${report.conflicts ? `・競合${report.conflicts}` : ''}` : '変更なし';
  }

  // ===================== 同期の記録（受け取りで書き換える前の中身）と取り消し =====================
  // 同期でこの端末のデータを書き換えたとき（受け取り・削除）、書き換える前の中身を残す。
  // 30日、または合計がおよそ50MBを超えたら古いものから消す（画像の多いアプリは記録が大きくなるため）
  const JOURNAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
  const JOURNAL_MAX_BYTES = 50 * 1024 * 1024;
  const JOURNAL_MAX_ENTRIES = 100;
  function estimateSize(v, depth = 0) {
    if (v == null || depth > MAX_DEPTH) return 8;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v !== 'object') return 8;
    if (v instanceof Blob) return v.size;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    let n = 16;
    for (const k of Object.keys(v)) n += k.length * 2 + estimateSize(v[k], depth + 1);
    return n;
  }
  async function addJournal(items, kind) {
    try {
      let size = 0;
      items.forEach((it) => { size += estimateSize(it.before); });
      const counts = {};
      items.forEach((it) => { counts[it.db] = (counts[it.db] || 0) + 1; });
      const d = await syncDb();
      const tx = d.transaction('journal', 'readwrite');
      tx.objectStore('journal').add({ at: Date.now(), kind, items, counts, size, undone: false });
      await txDone(tx);
      await pruneJournal();
    } catch (err) {
      console.warn('同期の記録を残せませんでした', err); // 記録の失敗で同期そのものを失敗にはしない
    }
  }
  async function pruneJournal() {
    const d = await syncDb();
    const list = await reqP(d.transaction('journal').objectStore('journal').getAll());
    list.sort((a, b) => b.at - a.at); // 新しい順
    const del = [];
    let total = 0;
    list.forEach((e, i) => {
      total += e.size || 0;
      if (Date.now() - e.at > JOURNAL_KEEP_MS || i >= JOURNAL_MAX_ENTRIES || (i > 0 && total > JOURNAL_MAX_BYTES)) del.push(e.id);
    });
    if (!del.length) return;
    const tx = d.transaction('journal', 'readwrite');
    del.forEach((id) => tx.objectStore('journal').delete(id));
    await txDone(tx);
  }
  async function listJournal(limit = 10) {
    const d = await syncDb();
    const list = await reqP(d.transaction('journal').objectStore('journal').getAll());
    return list.sort((a, b) => b.at - a.at).slice(0, limit)
      .map((e) => ({ id: e.id, at: e.at, kind: e.kind, counts: e.counts || {}, undone: !!e.undone, size: e.size || 0 }));
  }
  // 記録した同期で受け取った分を、書き換える前の中身に戻す。
  //   dbs：戻すアプリ（省略ですべて）
  //   mode：'check'（数えるだけ）/ 'unchangedOnly'（その後に変えていないものだけ戻す）/ 'all'（変えていても戻す）
  // 戻したこと自体が「この端末の変更」になり、次の同期でほかの端末にも届く
  async function undoJournal(id, { dbs, mode = 'check' } = {}) {
    const d = await syncDb();
    const entry = await reqP(d.transaction('journal').objectStore('journal').get(id));
    if (!entry) throw new SyncError('同期の記録が見つかりません（古い記録は自動で消えます）');
    if (entry.undone) throw new SyncError('この同期は、すでに取り消してあります');
    const targets = entry.items.filter((it) => !dbs || dbs.includes(it.db));
    const byDb = new Map();
    targets.forEach((it) => { if (!byDb.has(it.db)) byDb.set(it.db, []); byDb.get(it.db).push(it); });
    const versions = await localDbVersions();
    // 指紋は同期の時と同じ作り方にする（画像の名前は同期の鍵で作る）
    const keys = await getKeys();
    const hash = keys ? (b) => hmacHex(keys.nameKey, b) : sha256Hex;
    const out = { restored: 0, modified: 0, skipped: 0, dbs: [] };
    for (const [dbName, items] of byDb) {
      const rule = RULE_BY_NAME.get(dbName);
      if (!rule || !versions.has(dbName)) { out.skipped += items.length; continue; }
      const db = await openExistingDb(dbName);
      try {
        // その後に変えたかどうか：同期の直後の指紋と、今の指紋を比べる
        const storeNames = [...new Set(items.map((it) => it.store))].filter((n) => db.objectStoreNames.contains(n));
        if (!storeNames.length) { out.skipped += items.length; continue; }
        const rtx = db.transaction(storeNames);
        const current = [];
        for (const it of items) {
          if (!storeNames.includes(it.store)) { current.push(null); continue; }
          current.push(await reqP(rtx.objectStore(it.store).get(it.key)));
        }
        const plan = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!storeNames.includes(it.store)) { out.skipped++; continue; }
          const cur = current[i];
          let fpNow = null;
          if (cur !== undefined) {
            try { fpNow = await fingerprint(await encodeValue(project(rule, it.store, it.key, cur, it.kp), { hash, blobs: new Map() })); } catch (err) { fpNow = '?'; }
          }
          // 同期の後に変えたか：削除を受け取ったもの → 今もないか／それ以外 → 同期の直後と同じ中身か
          const modified = it.afterFp === null ? cur !== undefined : (cur === undefined || fpNow !== it.afterFp);
          if (modified) out.modified++;
          if (modified && mode !== 'all') continue;
          plan.push({ it, cur });
        }
        if (mode === 'check') { out.restored += plan.length; continue; }
        if (!plan.length) continue;
        const wtx = db.transaction(storeNames, 'readwrite');
        const done = txDone(wtx);
        for (const { it, cur } of plan) {
          const os = wtx.objectStore(it.store);
          if (rule.only) {
            // 端末ごとの項目（壁紙など）は今のまま残し、同期する項目だけを戻す
            const fields = rule.only[it.store] && rule.only[it.store][it.key];
            if (!fields) continue;
            const v = isPlainObject(cur) ? { ...cur } : (typeof it.kp === 'string' ? { [it.kp]: it.key } : {});
            fields.forEach((f) => { if (isPlainObject(it.before) && it.before[f] !== undefined) v[f] = it.before[f]; else delete v[f]; });
            os.put(v); // 「変えたよ」の印を付ける（次の同期で送る）
          } else if (it.before === undefined) {
            os.delete(it.key);
          } else if (it.kp === null) {
            os.put(it.before, it.key);
          } else {
            os.put(it.before);
          }
        }
        await done;
        out.restored += plan.length;
        out.dbs.push(dbName);
      } finally {
        db.close();
      }
    }
    if (mode !== 'check') {
      if (!dbs || dbs.length >= Object.keys(entry.counts || {}).length) {
        entry.undone = true;
        entry.undoneAt = Date.now();
      } else {
        entry.items = entry.items.filter((it) => !dbs.includes(it.db));
        Object.keys(entry.counts || {}).forEach((k) => { if (dbs.includes(k)) delete entry.counts[k]; });
      }
      const tx = d.transaction(['journal', 'conflicts'], 'readwrite');
      tx.objectStore('journal').put(entry);
      // 「控えに戻す」を取り消したら、控えの側にも残す（一覧・違いの画面に「取り消した」と出す）
      if (entry.undone && entry.kind === 'conflict' && entry.conflictId) {
        const cr = tx.objectStore('conflicts').get(entry.conflictId);
        cr.onsuccess = () => { if (cr.result) tx.objectStore('conflicts').put({ ...cr.result, restoreUndoneAt: Date.now() }); };
      }
      await txDone(tx);
      await addLog('info', `同期の記録から戻しました：${out.restored}件（${out.dbs.map(ruleLabel).join('・')}）`);
    }
    return out;
  }

  // 競合の控えの中身に戻す（2026-10-10）。
  //   mode：'check'（調べるだけ）/ 'apply'（戻す）
  //   戻り値：{ already（もう控えと同じ中身）, missing（今はデータがない）, changedSince（競合の後に変わった。古い控えは null＝分からない） }
  // 戻す前の中身は、先に「同期の記録」（kind: 'conflict'）に残す（そこから取り消せる。残せなければ戻さない）。
  // 書き込みは通常の put なので「変えたよ」の印が付き、次の同期でほかの端末にも届く
  async function restoreConflict(id, { mode = 'check' } = {}) {
    const d = await syncDb();
    const c = await reqP(d.transaction('conflicts').objectStore('conflicts').get(id));
    if (!c) throw new SyncError('競合の控えが見つかりません（30日たつと自動で消えます）');
    const rule = RULE_BY_NAME.get(c.db);
    if (!rule) throw new SyncError('このアプリは、今は同期の対象ではありません');
    if (!(await localDbVersions()).has(c.db)) throw new SyncError(`${rule.label}のデータがこの端末にありません（アプリを一度開いてから、もう一度試してください）`);
    const keys = await getKeys();
    const hash = keys ? (b) => hmacHex(keys.nameKey, b) : sha256Hex; // 指紋は同期の時と同じ作り方にする（取り消しの判定に使う）
    const db = await openExistingDb(c.db);
    try {
      if (!db.objectStoreNames.contains(c.store)) throw new SyncError(`${rule.label}に、戻す先の場所（${c.store}）がありません`);
      const rtx = db.transaction(c.store);
      const kp = rtx.objectStore(c.store).keyPath;
      const cur = await reqP(rtx.objectStore(c.store).get(c.key));
      const fpOf = async (v) => (v === undefined ? null : fingerprint(await encodeValue(project(rule, c.store, c.key, v, kp), { hash, blobs: new Map() })));
      const fpNow = await fpOf(cur);
      const legacy = !Object.prototype.hasOwnProperty.call(c, 'winnerDeleted');
      let changedSince = null;
      if (!legacy) changedSince = c.winnerDeleted ? cur !== undefined : (cur === undefined || fpNow !== await fpOf(c.winner));
      // 書き込む中身。端末ごとの項目（壁紙など）は今のまま残し、同期する項目だけを控えに戻す
      let v;
      if (rule.only) {
        const fields = rule.only[c.store] && rule.only[c.store][c.key];
        if (!fields) throw new SyncError('このデータは戻せません（同期する項目がありません）');
        v = isPlainObject(cur) ? { ...cur } : (typeof kp === 'string' ? { [kp]: c.key } : {});
        fields.forEach((f) => { if (isPlainObject(c.value) && c.value[f] !== undefined) v[f] = c.value[f]; else delete v[f]; });
      } else {
        v = c.value;
        if (typeof kp === 'string' && isPlainObject(v) && v[kp] === undefined) v = { ...v, [kp]: c.key };
      }
      const afterFp = await fpOf(v);
      const already = fpNow !== null && fpNow === afterFp;
      const info = { already, missing: cur === undefined, changedSince };
      if (mode === 'check' || already) return info;
      // 先に、戻す前の中身を同期の記録に残す（残せなければ、ここで止まる）
      const item = { db: c.db, store: c.store, key: c.key, kp, before: cur, op: 'put', afterFp };
      const jtx = d.transaction('journal', 'readwrite');
      const jreq = jtx.objectStore('journal').add({ at: Date.now(), kind: 'conflict', items: [item], counts: { [c.db]: 1 }, size: estimateSize(cur), undone: false, conflictId: c.id });
      await txDone(jtx);
      const journalId = jreq.result;
      try {
        const wtx = db.transaction(c.store, 'readwrite');
        const done = txDone(wtx);
        if (kp === null) wtx.objectStore(c.store).put(v, c.key);
        else wtx.objectStore(c.store).put(v);
        await done;
      } catch (err) {
        // 書き込めなかったら、残した記録も消す（取り消すものがない記録を残さない）
        try { const t = d.transaction('journal', 'readwrite'); t.objectStore('journal').delete(journalId); await txDone(t); } catch (e) { /* 消せなくても害はない */ }
        throw err;
      }
      const ctx2 = d.transaction('conflicts', 'readwrite');
      ctx2.objectStore('conflicts').put({ ...c, restoredAt: Date.now(), restoredJournal: journalId });
      await txDone(ctx2);
      await pruneJournal();
      await addLog('info', `競合の控えに戻しました：${rule.label}（${c.store}）`);
      return { ...info, journalId };
    } finally {
      db.close();
    }
  }

  // 重複の候補：IDと日時を除いた中身が同じで、IDが違うレコード（ストアごと）
  const SIG_IGNORE = ['id', 'createdAt', 'updatedAt', 'updated'];
  async function contentSig(encoded, keyPath) {
    if (!isPlainObject(encoded)) return null;
    const o = { ...encoded };
    SIG_IGNORE.forEach((f) => { delete o[f]; });
    if (typeof keyPath === 'string') delete o[keyPath];
    if (!Object.keys(o).length) return null;
    return sha256Hex(te.encode(canonical(o)));
  }
  async function countLikelyDuplicates(scan, best) {
    const local = new Set();
    for (const [id, c] of scan.recs) {
      if (best.has(id)) continue;
      const sig = await contentSig(c.encoded, (scan.schema[c.store] || {}).keyPath);
      if (sig) local.add(c.store + '|' + sig);
    }
    let n = 0;
    for (const [id, r] of best) {
      if (r.deleted || scan.recs.has(id)) continue;
      const sig = await contentSig(r.value, (scan.schema[r.store] || {}).keyPath);
      if (sig && local.has(r.store + '|' + sig)) n++;
    }
    return n;
  }

  async function purgeConflicts() {
    const d = await syncDb();
    const tx = d.transaction('conflicts', 'readwrite');
    const keys = await reqP(tx.objectStore('conflicts').index('at').getAllKeys(IDBKeyRange.upperBound(Date.now() - CONFLICT_KEEP_MS)));
    keys.forEach((k) => tx.objectStore('conflicts').delete(k));
    await txDone(tx);
  }
  async function countConflicts() {
    const d = await syncDb();
    return reqP(d.transaction('conflicts').objectStore('conflicts').count());
  }
  // 競合の控えの一覧（新しい順）・1件・ある時刻より後にできたもの（「違いを見る」で使う。2026-10-10）
  async function listConflicts() {
    const d = await syncDb();
    const list = await reqP(d.transaction('conflicts').objectStore('conflicts').getAll());
    return list.sort((a, b) => b.at - a.at);
  }
  async function getConflict(id) {
    const d = await syncDb();
    return reqP(d.transaction('conflicts').objectStore('conflicts').get(id));
  }
  async function conflictIdsSince(t) {
    const d = await syncDb();
    const list = await reqP(d.transaction('conflicts').objectStore('conflicts').index('at').getAll(IDBKeyRange.lowerBound(t)));
    return list.sort((a, b) => b.at - a.at).map((c) => c.id);
  }
  // アプリのDBにある、今のデータ（勝った方の中身を残していない古い控えは、今のデータと見比べる）
  async function currentRecord(dbName, store, key) {
    let db;
    try { db = await openExistingDb(dbName); } catch (err) { return { missing: true }; }
    try {
      if (!db.objectStoreNames.contains(store)) return { missing: true };
      const v = await reqP(db.transaction(store).objectStore(store).get(key));
      return v === undefined ? { missing: true } : { value: v };
    } finally { db.close(); }
  }

  // ===================== 違いの見比べ（2026-10-10） =====================
  // 行（または文字）の並びの違いを、Myersの差分法（diff コマンドと同じ考え方）で求める。
  // 戻り値：[{ t: '=' | '-' | '+', v }]（'-' は a にだけ、'+' は b にだけある）。
  // 前後の同じ部分は先に除く。違いが多すぎるとき（maxD を超える）は、間をまるごと「消して足した」扱いにする（重くしないため）
  function diffSeq(a, b, maxD = 1000) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const out = [];
    for (let i = 0; i < s; i++) out.push({ t: '=', v: a[i] });
    const mid = myersDiff(a.slice(s, ea), b.slice(s, eb), maxD);
    if (mid) out.push(...mid);
    else {
      for (let i = s; i < ea; i++) out.push({ t: '-', v: a[i] });
      for (let i = s; i < eb; i++) out.push({ t: '+', v: b[i] });
    }
    for (let i = ea; i < a.length; i++) out.push({ t: '=', v: a[i] });
    return out;
  }
  function myersDiff(a, b, maxD) {
    const n = a.length, m = b.length;
    if (!n) return b.map((v) => ({ t: '+', v }));
    if (!m) return a.map((v) => ({ t: '-', v }));
    const max = Math.min(n + m, maxD);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = false;
    outer:
    for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = true; break outer; }
      }
    }
    if (!found) return null;
    // 終わりから始めへたどって、手順を組み立てる
    const ops = [];
    let x = n, y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const tv = trace[d];
      const k = x - y;
      const prevK = (k === -d || (k !== d && tv[off + k - 1] < tv[off + k + 1])) ? k + 1 : k - 1;
      const prevX = tv[off + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { ops.push({ t: '=', v: a[x - 1] }); x--; y--; }
      if (d > 0) {
        if (x === prevX) ops.push({ t: '+', v: b[y - 1] });
        else ops.push({ t: '-', v: a[x - 1] });
      }
      x = prevX; y = prevY;
    }
    return ops.reverse();
  }

  // ===================== バックアップ（暗号化しない書き出し・復元） =====================
  // 同期の対象のDBを、ストア丸ごと（端末ごとの項目も含めて）書き出す
  async function buildBackup() {
    const versions = await localDbVersions();
    const out = { format: BACKUP_FORMAT, formatVersion: 1, appBuild: SYNC_APP_BUILD, exportedAt: new Date().toISOString(), dbs: {}, blobs: {} };
    const blobs = new Map();
    const hash = sha256Hex;
    for (const rule of DB_RULES) {
      if (!versions.has(rule.name)) continue;
      const db = await openExistingDb(rule.name);
      try {
        const storeNames = Array.from(db.objectStoreNames);
        const schema = readSchema(db, storeNames);
        const stores = {};
        for (const n of storeNames) {
          const tx = db.transaction(n);
          const os = tx.objectStore(n);
          const [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
          stores[n] = [];
          for (let i = 0; i < keys.length; i++) {
            const ctx = { hash, blobs };
            stores[n].push({ key: keys[i], value: await encodeValue(values[i], ctx) });
          }
        }
        out.dbs[rule.name] = { version: db.version, schema, stores };
      } finally { db.close(); }
    }
    blobs.forEach((b, h) => { out.blobs[h] = bytesToB64(b); });
    return new Blob([JSON.stringify(out)], { type: 'application/json' });
  }
  function parseBackup(obj) {
    if (!isPlainObject(obj) || obj.format !== BACKUP_FORMAT) throw new SyncError('SIDE-OPSの全データのバックアップではありません');
    if (typeof obj.formatVersion !== 'number' || obj.formatVersion > 1) throw new SyncError('新しい版のSIDE-OPSで作られたバックアップです。SIDE-OPSを再読み込みして更新してください');
    if (!isPlainObject(obj.dbs) || !isPlainObject(obj.blobs)) throw new SyncError('バックアップが壊れています');
    const summary = [];
    for (const [name, b] of Object.entries(obj.dbs)) {
      if (!RULE_BY_NAME.has(name)) throw new SyncError('バックアップに知らないDBが含まれています（' + name.slice(0, 40) + '）');
      if (!isPlainObject(b) || !Number.isInteger(b.version) || !validSchema(b.schema) || !isPlainObject(b.stores)) throw new SyncError('バックアップが壊れています（' + ruleLabel(name) + '）');
      let count = 0;
      for (const [sn, list] of Object.entries(b.stores)) {
        if (!b.schema[sn] || !Array.isArray(list)) throw new SyncError('バックアップが壊れています（' + ruleLabel(name) + '）');
        count += list.length;
      }
      summary.push({ name, label: ruleLabel(name), version: b.version, count });
    }
    return summary;
  }
  // DBごとに、ストアを空にしてから書き戻す（1DB＝1トランザクション）
  async function restoreBackup(obj) {
    const summary = parseBackup(obj);
    const versions = await localDbVersions();
    const blobCache = new Map();
    const bytesOf = (h) => {
      if (!blobCache.has(h)) {
        if (typeof obj.blobs[h] !== 'string') throw new SyncError('バックアップの画像が見つかりません');
        blobCache.set(h, b64ToBytes(obj.blobs[h]));
      }
      return blobCache.get(h);
    };
    const done = [];
    for (const s of summary) {
      const b = obj.dbs[s.name];
      const rule = RULE_BY_NAME.get(s.name);
      const local = versions.get(s.name);
      if (local === undefined ? b.version !== rule.version : b.version !== local) {
        done.push(`${s.label}：DBの版が違うため復元しませんでした`);
        continue;
      }
      const db = local === undefined ? await createDbFromSchema(s.name, b.version, b.schema) : await openExistingDb(s.name);
      try {
        const storeNames = Object.keys(b.stores).filter((n) => db.objectStoreNames.contains(n));
        const prepared = storeNames.map((n) => ({ n, rows: b.stores[n].map((row) => ({ key: row.key, value: decodeValue(row.value, bytesOf) })) }));
        const tx = db.transaction(storeNames, 'readwrite');
        const fin = txDone(tx);
        try {
          for (const { n, rows } of prepared) {
            const os = tx.objectStore(n);
            os.clear();
            rows.forEach((r) => (os.keyPath === null ? os.put(r.value, r.key) : os.put(r.value)));
          }
        } catch (err) { try { tx.abort(); } catch (e) { /* すでに終了 */ } throw err; }
        await fin;
        done.push(`${s.label}：${s.count}件`);
      } finally { db.close(); }
    }
    await addLog('info', 'バックアップから復元：' + done.join(' / '));
    return done;
  }
  async function exportConflicts() {
    const d = await syncDb();
    const list = await reqP(d.transaction('conflicts').objectStore('conflicts').getAll());
    const blobs = new Map();
    const rows = [];
    for (const c of list) {
      const row = { ...c, value: await encodeValue(c.value, { hash: sha256Hex, blobs }) };
      if (c.winner !== undefined && c.winner !== null) row.winner = await encodeValue(c.winner, { hash: sha256Hex, blobs }); // 勝った方の中身（2026-10-10から）
      rows.push(row);
    }
    const out = { format: 'sideops-sync-conflicts', exportedAt: new Date().toISOString(), conflicts: rows, blobs: {} };
    blobs.forEach((b, h) => { out.blobs[h] = bytesToB64(b); });
    return new Blob([JSON.stringify(out)], { type: 'application/json' });
  }

  // ===================== 未送信の判定・ほかの端末の新しいデータの確認 =====================
  // 未送信のDB：「変えたよ」の印が、前回見直した時刻より新しいDB。
  // 本体の設定は、端末ごとの項目（壁紙・透過率）だけを変えたときにも印が付くので、同期する項目が
  // 本当に変わったかを確かめる（1件だけ読むので軽い）
  async function unsentDbs() {
    const keys = await getKeys();
    if (!keys) return [];
    const scannedRec = (await metaGet('scanned')) || { dbs: {} };
    const prefs = await getPrefs();
    const marks = readDirtyMarks();
    const out = [];
    for (const rule of DB_RULES) {
      if (prefs.disabled[rule.name]) continue;
      const m = marks[rule.name];
      if (!m || m < (scannedRec.dbs[rule.name] || 0)) continue;
      if (rule.only && !(await onlyFieldsChanged(rule, keys))) continue;
      out.push(rule);
    }
    return out;
  }
  async function onlyFieldsChanged(rule, keys) {
    try {
      if (!(await localDbVersions()).has(rule.name)) return false;
      const db = await openExistingDb(rule.name);
      try {
        const scan = await scanDb(rule, db, (b) => hmacHex(keys.nameKey, b));
        const d = await syncDb();
        const st = await reqP(d.transaction('records').objectStore('records').index('db').getAll(rule.name));
        const stMap = new Map(st.map((s) => [s.id, s]));
        for (const [id, c] of scan.recs) { const s = stMap.get(id); if (!s || s.deleted || s.fp !== c.fp) return true; }
        return st.some((s) => !s.deleted && !scan.recs.has(s.id));
      } finally { db.close(); }
    } catch (err) { return true; } // 分からなければ「未送信あり」として扱う（取りこぼさない側に倒す）
  }
  // ほかの端末が、前回この端末が取り込んだ後に新しいデータを送ったか（端末の目次の版の印だけを見る。軽い）
  async function checkRemote(backend) {
    const keys = await getKeys();
    const manifest = await readManifest(backend);
    if (!keys || !manifest || manifest.spaceId !== keys.spaceId || manifest.keyId !== keys.keyId) return { state: 'needSync', newer: [] };
    const dev = await getDevice();
    const names = fileNames(keys);
    const own = await names.device(dev.id);
    const seen = await metaGet('seen');
    const sf = seen && seen.spaceId === manifest.spaceId && seen.kind === backend.kind && isPlainObject(seen.files) ? seen.files : {};
    const newer = [];
    for (const n of await backend.list()) {
      if (!n.startsWith('d_') || n === own) continue;
      const st = typeof backend.stamp === 'function' ? backend.stamp(n) : '';
      if (st && sf[n] && sf[n].stamp === st) continue;
      const info = await readJsonFile(backend, keys, manifest.spaceId, n);
      if (!isPlainObject(info)) continue;
      newer.push({ name: String(info.deviceName || '別の端末').slice(0, 40), at: info.lastWriteAt || info.writtenAt || '' });
    }
    return { state: 'ready', newer };
  }

  // ===================== 同期してよい状態かの確認 =====================
  function stageBusy() {
    const stage = document.getElementById('stageEl');
    if (stage && stage.classList.contains('is-open')) return 'open';
    if (document.querySelector('#stageBody iframe')) return 'retiring';
    return '';
  }
  async function waitStageIdle() {
    const until = Date.now() + STAGE_RETIRE_WAIT_MS;
    while (Date.now() < until) {
      const b = stageBusy();
      if (b === 'open') return false;
      if (!b) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !stageBusy();
  }
  // 他のタブでSIDE-OPSを開いていないか（他のタブは古いデータを持ったまま上書きしうる）
  const TAB_ID = randomHex(8);
  let channel = null;
  try {
    channel = new BroadcastChannel('sideops-sync');
    channel.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === 'ping' && m.from !== TAB_ID) channel.postMessage({ type: 'pong', to: m.from, from: TAB_ID });
    };
  } catch (err) { channel = null; }
  function otherTabsOpen() {
    if (!channel) return Promise.resolve(false);
    return new Promise((resolve) => {
      let found = false;
      const listen = (ev) => { if (ev.data && ev.data.type === 'pong' && ev.data.to === TAB_ID) found = true; };
      channel.addEventListener('message', listen);
      channel.postMessage({ type: 'ping', from: TAB_ID });
      setTimeout(() => { channel.removeEventListener('message', listen); resolve(found); }, 400);
    });
  }
  async function withLock(fn) {
    if (!navigator.locks) return fn();
    let ran = false;
    const result = await navigator.locks.request('sideops-sync', { ifAvailable: true }, async (lock) => {
      if (!lock) return undefined;
      ran = true;
      return fn();
    });
    if (!ran) throw new SyncError('別のタブで同期中です。終わってからもう一度試してください');
    return result;
  }
  async function precheck() {
    // 2つの確認は並べて行う（ほかのタブの確認は返事を0.4秒待つので、順番に待つと遅くなる。2026-10-08）
    const [idle, others] = await Promise.all([waitStageIdle(), otherTabsOpen()]);
    if (!idle) throw new SyncError('開いているアプリを閉じてから同期してください');
    if (others) throw new SyncError('SIDE-OPSを開いている他のタブ（ウィンドウ）を閉じてから同期してください');
  }

  // ===================== 画面 =====================
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function readFileJson(file) {
    return file.text().then((t) => {
      try { return JSON.parse(t); } catch (err) { throw new SyncError('ファイルを読めませんでした（JSONではありません）'); }
    });
  }

  function initUi() {
    const $ = (id) => document.getElementById(id);
    const overlay = $('syncOverlay');
    const openBtn = $('cloudSyncBtn');
    if (!overlay || !openBtn) return;
    const statusEl = $('syncStatus');
    const resultEl = $('syncResult');
    const dbListEl = $('syncDbList');
    const journalEl = $('syncJournal');
    const deviceNameInput = $('syncDeviceName');
    const pkgInput = $('syncPackageInput');
    const backupInput = $('syncBackupInput');
    const MAIN_DBS = ['sideops_launcher', 'sideops_settings']; // 本体が画面に持っているDB（受け取ったら再読み込みが要る）
    const INTENT_KEY = 'sideops_sync_intent'; // ログインに出る前の目的（'check'：確認だけ／'sync'：同期）
    const DISMISS_KEY = 'sideops_sync_unsent_dismissed';
    const hook = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && window.__SIDEOPS_SYNC_TEST__ ? window.__SIDEOPS_SYNC_TEST__ : {};
    const LAST_HIDDEN_KEY = 'sideops_sync_last_hidden'; // 画面を最後に離れた時刻（ページを開き直したときに、離れていた時間をログに残す）
    const AWAY_MS = hook.awayMs || 10 * 60 * 1000;        // これ以上離れてから戻ったら、開いたときと同じ扱い
    const PUSH_EVERY_MS = hook.pushEveryMs || 30 * 60 * 1000; // アプリを開いたままの作業で「送るだけ」をする間隔
    const FULL_SCAN_MS = 24 * 60 * 60 * 1000;            // 1日1回は、印に関係なくすべてを見直す
    let needReload = false;
    let lastPackage = null;

    openBtn.disabled = false;
    openBtn.title = '同期（複数の端末でデータを使う）';
    const fmt = (t) => (t ? new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'なし');

    function setBusy(b) {
      overlay.querySelectorAll('[data-sync-action]').forEach((el) => { el.disabled = b; });
      overlay.classList.toggle('is-busy', b);
      if (!b) { applyCloudAvailability(); refreshCloud(); }
    }

    // ===================== 同期の状態を見せるモーダル（同期中・結果・ログイン切れの確認） =====================
    // ☁の画面の一番下ではなく、画面の中央に重ねて出す（見落とさないように）
    const prog = $('syncProgress');
    const progTitle = $('syncProgressTitle');
    const progStepEl = $('syncProgressStep');
    const progActs = $('syncProgressActions');
    function progOpen(title) {
      progTitle.textContent = title;
      progStepEl.textContent = '';
      resultEl.textContent = '';
      resultEl.className = 'sync-result';
      progActs.textContent = '';
      prog.classList.add('is-open');
    }
    function progStep(text) { progStepEl.textContent = text ? text + '…' : ''; }
    function progActions(buttons) {
      progActs.textContent = '';
      for (const b of buttons) {
        const el = document.createElement('button');
        el.className = 'btn' + (b.cls ? ' ' + b.cls : '');
        el.textContent = b.label;
        if (b.id) el.id = b.id;
        el.addEventListener('click', b.onClick);
        progActs.appendChild(el);
      }
    }
    function progClose() { prog.classList.remove('is-open'); }
    function showResult(lines, kind) {
      resultEl.textContent = '';
      resultEl.className = 'sync-result' + (kind ? ' is-' + kind : '');
      lines.forEach((l) => {
        const div = document.createElement('div');
        div.textContent = l;
        resultEl.appendChild(div);
      });
    }
    function appendButton(label, onClick, cls) {
      const b = document.createElement('button');
      b.className = 'btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.addEventListener('click', onClick);
      resultEl.appendChild(b);
    }

    // ===================== ヘッダーの下の帯（裏で同期しているとき・未送信・失敗） =====================
    const banner = (() => {
      const el = $('syncBanner');
      const text = $('syncBannerText');
      const acts = $('syncBannerActions');
      let timer = 0;
      let kindNow = '';
      function place() {
        const h = document.querySelector('header.top');
        el.style.top = Math.max(6, (h ? h.getBoundingClientRect().bottom : 0) + 6) + 'px';
      }
      return {
        show({ text: t, kind = 'busy', actions = [], hideMs = 0 }) {
          clearTimeout(timer);
          kindNow = kind;
          place();
          text.textContent = t;
          acts.textContent = '';
          for (const a of actions) {
            const b = document.createElement('button');
            b.className = 'btn' + (a.cls ? ' ' + a.cls : '');
            b.textContent = a.label;
            b.addEventListener('click', a.onClick);
            acts.appendChild(b);
          }
          el.className = 'sync-banner is-open is-' + kind;
          if (hideMs) timer = setTimeout(() => this.hide(kind), hideMs);
        },
        hide(kind) {
          if (kind && kind !== kindNow) return;
          clearTimeout(timer);
          kindNow = '';
          el.className = 'sync-banner';
        },
        get kind() { return kindNow; },
      };
    })();

    // ===================== ☁の画面の状態の欄 =====================
    async function refresh() {
      try {
        const dev = await getDevice();
        const keys = await getKeys();
        const status = (await metaGet('status')) || {};
        const prefs = await getPrefs();
        const conflicts = await countConflicts();
        const unsent = await unsentDbs();
        deviceNameInput.value = dev.name;
        const lines = [];
        // このページの版（古い版のまま開いていないかを確かめられるように。2026-10-08）
        lines.push(`このページの版：${SYNC_APP_BUILD}`);
        lines.push(keys ? `同期の鍵：あり（ID ${keys.keyId.slice(0, 8)}）` : '同期の鍵：なし（まだ同期していません）');
        lines.push('最後の同期：' + fmt(status.lastSyncAt) + (status.lastSummary ? `（${status.lastSummary}）` : ''));
        (status.devices || []).forEach((d) => lines.push(`ほかの端末：${d.name}（最終送信 ${fmt(d.at)}）`));
        if (keys) lines.push('この端末の未送信：' + (unsent.length ? `あり（${unsent.map((r) => r.label).join('・')}）` : 'なし'));
        if (conflicts) lines.push(`競合の控え：${conflicts}件（30日で自動的に消えます）`);
        statusEl.textContent = lines.join('\n');
        await refreshRunlog(); // 同期のログのまとめ（この後の欄が読めなくても、先に出しておく）
        dbListEl.textContent = '';
        for (const rule of DB_RULES) {
          const label = document.createElement('label');
          label.className = 'sync-db-item';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !prefs.disabled[rule.name];
          cb.dataset.syncAction = 'toggle';
          cb.addEventListener('change', async () => {
            const p = await getPrefs();
            if (cb.checked) delete p.disabled[rule.name]; else p.disabled[rule.name] = true;
            if (cb.checked && rule.sensitive) delete p.sensitiveOk[rule.name]; // もう一度確認してから送る
            await metaPut(p);
          });
          const span = document.createElement('span');
          span.textContent = rule.label + (rule.sensitive ? '（顧客データを含む）' : '');
          label.append(cb, span);
          dbListEl.appendChild(label);
        }
        await refreshJournal();
        await refreshConflicts();
        await refreshCloud();
      } catch (err) {
        statusEl.textContent = '同期の状態を読めませんでした：' + (err && err.message);
      }
    }

    // ☁を押したとき：クラウドにつないでいれば、そのまま同期する（ログインが切れていればログインから）
    async function open(opts) {
      overlay.classList.add('is-open');
      refresh();
      if ((opts && opts.autoSync === false) || overlay.classList.contains('is-busy')) return;
      const c = await cloudMeta();
      if (c.connected && providers[c.provider] && providers[c.provider].configured()) run(cloudSyncFlow, { fromOpen: true, title: `${providers[c.provider].label}と同期しています` });
    }
    function close() {
      if (overlay.classList.contains('is-busy')) return;
      overlay.classList.remove('is-open');
      progClose();
      closeDiff();
      if (needReload) location.reload(); // ランチャー・本体の設定を受け取ったら、画面の表示を最新にする
    }
    openBtn.addEventListener('click', () => open());
    $('syncCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || $('syncDialog').classList.contains('is-open')) return;
      if (diffEl && diffEl.classList.contains('is-open')) { closeDiff(); return; } // 違いを見る画面を先に閉じる
      if (prog.classList.contains('is-open')) { if (!overlay.classList.contains('is-busy') && progActs.querySelector('#syncProgressOk')) progActs.querySelector('#syncProgressOk').click(); return; }
      if (overlay.classList.contains('is-open')) close();
    });

    // ---- ダイアログ（確認・パスフレーズ入力） ----
    const dlg = $('syncDialog');
    const dlgMsg = $('syncDialogMsg');
    const dlgPass = $('syncDialogPass');
    const dlgPass2 = $('syncDialogPass2');
    const dlgErr = $('syncDialogErr');
    const dlgOk = $('syncDialogOk');
    const dlgCancel = $('syncDialogCancel');
    // 確認・パスフレーズ入力のダイアログ。フールプルーフ：
    //   ・確かめている間（パスフレーズの照合は1秒ほどかかる）は OK・やめる を押せなくする（二度押し防止）
    //   ・古いダイアログの後始末が、次に開いたダイアログを閉じてしまわないよう、開くたびに番号を振る
    let dialogSeq = 0;
    function dialog({ message, pass = 0, okLabel = 'OK', cancelLabel = 'やめる', danger = false, validate }) {
      return new Promise((resolve) => {
        const my = ++dialogSeq;
        let validating = false;
        dlgMsg.textContent = message;
        dlgErr.textContent = '';
        dlgPass.value = ''; dlgPass2.value = '';
        dlgPass.hidden = pass < 1; dlgPass2.hidden = pass < 2;
        dlgOk.textContent = okLabel;
        dlgCancel.textContent = cancelLabel;
        dlgOk.className = 'btn ' + (danger ? 'danger' : 'primary');
        dlgOk.disabled = false; dlgCancel.disabled = false;
        dlg.classList.add('is-open');
        if (pass) setTimeout(() => dlgPass.focus(), 30);
        const finish = (v) => {
          if (my !== dialogSeq) return; // すでに次のダイアログが開いている
          dlg.classList.remove('is-open');
          dlgOk.onclick = dlgCancel.onclick = null;
          dlgPass.onkeydown = dlgPass2.onkeydown = null;
          dlgPass.value = ''; dlgPass2.value = '';
          resolve(v);
        };
        dlgOk.onclick = async () => {
          if (validating) return;
          if (!pass) { finish(true); return; }
          const p = dlgPass.value;
          if (pass >= 2 && p !== dlgPass2.value) { dlgErr.textContent = '2回の入力が一致しません'; return; }
          let msg = '';
          if (validate) {
            validating = true;
            dlgOk.disabled = true; dlgCancel.disabled = true;
            try { msg = await validate(p); } finally {
              validating = false;
              dlgOk.disabled = false; dlgCancel.disabled = false;
            }
          }
          if (msg) { dlgErr.textContent = msg; return; }
          finish(p);
        };
        dlgCancel.onclick = () => finish(pass ? null : false);
        const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); dlgOk.click(); } };
        dlgPass.onkeydown = enter; dlgPass2.onkeydown = enter;
      });
    }
    const confirmSensitive = (rule) => dialog({
      message: `${rule.label}には購入者（第三者）の個人情報が含まれます。暗号化したうえで同期ファイルに入れます。同期しますか？\n（「やめる」を選ぶと、${rule.label}は同期しない設定になります）`,
      okLabel: '同期する',
    });

    // その端末で初めて同期する前に、全データのバックアップを書き出す
    async function firstBackupIfNeeded() {
      const prefs = await getPrefs();
      if (prefs.firstBackupDone) return true;
      const ok = await dialog({ message: 'この端末で初めて同期します。念のため、先にこの端末の全データをバックアップとして保存します。\nバックアップは暗号化されていません（顧客データも含みます）。安全な場所に保管してください。', okLabel: '保存して続ける' });
      if (!ok) return false;
      downloadBlob(await buildBackup(), `sideops-backup-${stamp()}.json`);
      prefs.firstBackupDone = true;
      await metaPut(prefs);
      return true;
    }

    function reportLines(report) {
      const lines = summarizeReport(report);
      if (!lines.length) return ['変更はありませんでした（ほかの端末と同じ内容です）'];
      if (report.results.some((r) => r.pulled || r.removed || r.pushed)) {
        lines.push('※受け取り＝ほかの端末の変更を、この端末に反映した件数／送り出し＝この端末の変更を送った件数（中身がまったく同じデータは数えません）');
      }
      if (report.firstTime) lines.push('※初めて同期したアプリは、この端末にしかなかったデータを「送り出し（追加）」として数えています');
      return lines;
    }
    const CONFLICT_LINE = (n) => `両方の端末で変えていたデータが${n}件ありました。新しい方を採用し、もう一方は「競合の控え」に残しました（「違いを見る」で、どこが違うかを確かめられます）`;
    const RELOAD_LINE = '受け取ったデータは、この端末に保存済みです。ランチャー・本体の設定の表示を最新にするため、閉じると再読み込みします';
    const SAVED_LINE = '受け取ったデータは、この端末に保存済みです（アプリを開くと反映されています）';
    const RELOAD_BUTTON = '今すぐ画面を最新にする';
    const touchesMain = (dbs) => (dbs || []).some((n) => MAIN_DBS.includes(n));
    // 結果の行を作る（手動・自動で共通）
    function resultLinesFor(report, head) {
      const lines = [head, ...reportLines(report)];
      if (report.conflicts) lines.push(CONFLICT_LINE(report.conflicts));
      if (report.applied) lines.push(touchesMain(report.appliedDbs) ? RELOAD_LINE : SAVED_LINE);
      if (report.timing) lines.push(timingLine(report.timing));
      return lines;
    }
    // かかった時間の内訳（2026-10-08。同期が遅いと感じたときに、通信と見直しのどちらに時間がかかったかを見る）
    function timingLine(t) {
      const s = (ms) => (Math.max(0, ms) / 1000).toFixed(1);
      const scan = Object.values(t.scan || {}).reduce((a, b) => a + b, 0);
      return `※かかった時間：${s(t.total)}秒（通信 ${s(t.net)}秒・${t.netCount}回／データの見直し ${s(scan)}秒）`;
    }

    async function finishSync(backend, manifest, report) {
      lastPackage = { blob: packageBlob(backend, manifest.spaceId), name: `sideops-sync-${stamp()}.json` };
      downloadBlob(lastPackage.blob, lastPackage.name);
      if (touchesMain(report.appliedDbs)) needReload = true;
      showResult(resultLinesFor(report, '同期しました。新しい同期ファイルを保存しました（' + lastPackage.name + '）。'), 'ok');
      appendButton('同期ファイルをもう一度保存', () => downloadBlob(lastPackage.blob, lastPackage.name));
      if (needReload) appendButton(RELOAD_BUTTON, () => location.reload(), 'primary');
      await refresh();
    }

    // ---- 手動の操作：中央のモーダルで、終わるまで待ってもらう ----
    // 1分以上かかったら「待つ／裏で続ける」を出す。裏で続けたら、結果は上の帯で知らせる
    const userFacing = (err) => err instanceof SyncError || !!(err && err.userFacing);
    let runCtx = null;
    async function run(task, { fromOpen = false, title = '処理しています' } = {}) {
      if (overlay.classList.contains('is-busy')) return;
      setBusy(true);
      const ctx = { fromOpen, background: false };
      runCtx = ctx;
      const startedAt = Date.now(); // この操作の間にできた競合の控えを、あとで「違いを見る」に出す
      progOpen(title);
      progStep('準備しています');
      // 自動の同期の途中なら、終わるのを待ってから始める（同時に2つ走らせない）
      if (autoPromise) {
        progStep('自動の同期が終わるのを待っています');
        try { await autoPromise; } catch (err) { /* 自動の側で表示済み */ }
      }
      const slow = setTimeout(() => {
        if (ctx.background) return;
        progStep('時間がかかっています');
        progActions([
          { label: '待つ', onClick: () => progActions([]) },
          { label: '裏で続ける', onClick: () => { ctx.background = true; progClose(); banner.show({ text: '☁ 同期を裏で続けています…', kind: 'busy' }); } },
        ]);
      }, 60 * 1000);
      try {
        await task();
      } catch (err) {
        if (userFacing(err)) console.warn('同期を中止しました：' + err.message); // 想定内（利用者に理由を表示する）
        else console.error(err);
        showResult([userFacing(err) ? err.message : '同期に失敗しました：' + (err && err.message)], 'error');
        if (!userFacing(err)) addLog('error', err && err.stack ? err.stack : String(err));
      } finally {
        clearTimeout(slow);
        setBusy(false);
        await updateUnsent(); // 未送信と☁の印を、すぐに最新にする（遅らせると、同期の後も「未送信」の印が残って見える）
      }
      progStep('');
      const kind = resultEl.classList.contains('is-error') ? 'error' : resultEl.classList.contains('is-ok') ? 'ok' : '';
      progTitle.textContent = kind === 'error' ? 'うまくいきませんでした' : kind === 'ok' ? '完了しました' : progTitle.textContent;
      let fresh = [];
      try { fresh = await conflictIdsSince(startedAt); } catch (err) { /* 数えられなくても、結果は出す */ }
      if (ctx.background) {
        const first = resultEl.firstChild ? resultEl.firstChild.textContent : '';
        if (fresh.length && kind !== 'error') {
          banner.show({ text: '☁ ' + first + `（両方の端末で変えていたデータが${fresh.length}件）`, kind: 'conflict', actions: [
            { label: '違いを見る', cls: 'primary', onClick: () => { banner.hide(); openConflicts(fresh.length === 1 ? fresh[0] : null); } },
            { label: '閉じる', onClick: () => banner.hide() },
          ] });
        } else {
          banner.show({ text: (kind === 'error' ? '☁ ' : '☁ ') + first, kind: kind === 'error' ? 'error' : 'ok', hideMs: kind === 'error' ? 0 : 5000, actions: kind === 'error' ? [{ label: '閉じる', onClick: () => banner.hide() }] : [] });
        }
        if (needReload && !stageBusy()) location.reload();
        return;
      }
      // ☁を押して始まった同期は、OKで☁の画面ごと閉じる（いつもの使い方を1回で終わらせる）。
      // 「ログを見る」は、☁の画面を残して同期のログの欄を見せる（OKで閉じるとログを見られなかったため。2026-10-10）
      const acts = [];
      // 両方の端末で変えていたデータがあれば「違いを見る」（1件ならそのまま開く。2026-10-10）
      if (fresh.length) acts.push({ id: 'syncProgressDiff', label: '違いを見る', onClick: () => { progClose(); showConflicts(fresh.length === 1 ? fresh[0] : null); } });
      if (ctx.fromOpen) acts.push({ id: 'syncProgressLog', label: 'ログを見る', onClick: () => { progClose(); showRunlog(); } });
      acts.push({ id: 'syncProgressOk', label: 'OK', cls: 'primary', onClick: () => { progClose(); if (ctx.fromOpen) close(); } });
      progActions(acts);
    }

    // ===================== クラウド（OneDrive・Googleドライブ） =====================
    // 保存先は js/sync-onedrive.js・js/sync-gdrive.js が window.SideOpsSyncProviders に登録する。
    // 1台の端末が同期に使うクラウドは1つだけ（切り替えるときは、接続を解除してから選び直す）
    const providers = window.SideOpsSyncProviders || {};
    const providerList = Object.values(providers).sort((x, y) => (x.order || 9) - (y.order || 9));
    const cloudSel = $('syncCloudProvider');
    const cloudBtn = $('syncCloudBtn');
    const cloudOffBtn = $('syncCloudOffBtn');
    const cloudAuto = $('syncCloudAuto');
    const cloudStatus = $('syncCloudStatus');
    const cloudNote = $('syncCloudNote');
    const anyCloudReady = () => providerList.some((p) => p.configured());
    async function cloudMeta() {
      const m = await metaGet('cloud');
      return { key: 'cloud', provider: '', connected: false, auto: true, ...(m || {}) };
    }
    async function connectedProvider() {
      const c = await cloudMeta();
      const p = c.connected ? providers[c.provider] : null;
      return p && p.configured() ? { p, c } : null;
    }
    function buildProviderOptions() {
      if (!cloudSel || cloudSel.options.length) return;
      for (const p of providerList) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label + (p.configured() ? '' : '（準備中）');
        o.disabled = !p.configured();
        cloudSel.appendChild(o);
      }
      const first = providerList.find((p) => p.configured());
      if (first) cloudSel.value = first.id;
    }
    // この端末で使う保存先：つないでいればそれ。なければ選択欄で選んでいるもの
    async function currentProvider() {
      const c = await cloudMeta();
      if (c.connected && providers[c.provider]) return providers[c.provider];
      buildProviderOptions();
      return (cloudSel && providers[cloudSel.value]) || providerList.find((p) => p.configured()) || null;
    }
    function applyCloudAvailability() {
      if (!cloudSel || anyCloudReady()) return;
      [cloudSel, cloudBtn, cloudOffBtn, cloudAuto].forEach((el) => { if (el) el.disabled = true; });
    }

    // ☁ボタンの印：同期済み（cyan）／ログインが必要・しばらく同期していない・未送信（amber）／失敗（magenta）／同期中
    let indicatorError = false;
    let unsentNow = [];
    async function updateIndicator(state) {
      try {
        if (state === 'error') indicatorError = true;
        if (state === 'ok') indicatorError = false;
        const c = await cloudMeta();
        const p = c.connected ? providers[c.provider] : null;
        const login = p && p.configured() ? await p.status() : 'off';
        const status = await metaGet('status');
        openBtn.classList.remove('sync-ok', 'sync-warn', 'sync-error', 'sync-busy');
        let cls = '';
        let title = '同期（複数の端末でデータを使う）';
        const last = fmt(status && status.lastSyncAt);
        const stale = status && status.lastSyncAt && Date.now() - status.lastSyncAt > STALE_SYNC_MS;
        if (state === 'busy') { cls = 'sync-busy'; title = '同期しています…'; }
        else if (indicatorError) { cls = 'sync-error'; title = '前回の同期に失敗しました（押して確認）'; }
        else if (p && login === 'login') { cls = 'sync-warn'; title = `${p.label}のログインが必要です（押すと同期します）`; }
        else if (p && unsentNow.length) { cls = 'sync-warn'; title = `未送信の変更があります（${unsentNow.map((r) => r.label).join('・')}）`; }
        else if (stale) { cls = 'sync-warn'; title = `しばらく同期していません（最後の同期：${last}）`; }
        else if (p) { cls = 'sync-ok'; title = `${p.label}と同期しています（最後の同期：${last}）`; }
        if (cls) openBtn.classList.add(cls);
        openBtn.title = title;
      } catch (err) { /* 印が出せなくても同期には影響しない */ }
    }

    async function refreshCloud() {
      if (!cloudStatus) return;
      buildProviderOptions();
      const c = await cloudMeta();
      cloudAuto.checked = c.auto;
      if (!anyCloudReady()) {
        cloudStatus.textContent = '準備中です（OneDriveのアプリ登録待ち）';
        applyCloudAvailability();
        return;
      }
      if (c.connected && providers[c.provider]) cloudSel.value = c.provider;
      const p = await currentProvider();
      cloudNote.textContent = p ? p.note : '';
      cloudSel.disabled = c.connected || overlay.classList.contains('is-busy'); // つないでいる間は選び直せない（2つのクラウドへ同時に同期しないため）
      cloudOffBtn.disabled = !c.connected || overlay.classList.contains('is-busy');
      if (!c.connected || !providers[c.provider]) { cloudStatus.textContent = 'まだ接続していません'; return; }
      const login = await providers[c.provider].status();
      cloudStatus.textContent = `${providers[c.provider].label}に接続中` + (login === 'ready' ? '（ログイン済み）' : '（ログインが切れています。「同期する」を押すとログインし直します）');
    }
    if (cloudSel) cloudSel.addEventListener('change', () => { refreshCloud(); });

    // クラウドで同期する（手動）
    // 手動の同期（☁）。かかった時間を同期のログに残す
    async function cloudSyncFlow() {
      const L = startRunLog('manual', 'manual', { scanAll: true });
      try {
        await cloudSyncFlowInner(L);
      } catch (err) {
        L.fail(err);
        throw err;
      } finally {
        await L.end();
        refreshRunlog();
      }
    }
    async function cloudSyncFlowInner(L) {
      const p = await currentProvider();
      if (!p || !p.configured()) throw new SyncError('クラウドの設定（アプリの登録）がまだありません');
      if (p.loginLeavesPage) {
        // ログインでページを離れる方式（OneDrive）：離れる前に、アプリやほかのタブを閉じているか確かめる
        await precheck();
        progStep(`${p.label}を確認しています`);
        if (!(await p.ensureToken({ interactive: false }))) {
          progStep(`${p.label}のログイン画面へ移ります。ログインすると、戻ってきて同期の続きをします`);
          sessionStorage.setItem(INTENT_KEY, 'sync');
          await p.ensureToken({ interactive: true }); // ページを離れる
          return;
        }
      } else if (!(await p.ensureToken({ interactive: false }))) {
        // ポップアップでログインする方式（Googleドライブ）：押した直後に開く必要があるので、先にログインする
        progStep(`${p.label}にログインしています`);
        await p.ensureToken({ interactive: true });
      }
      await withLock(async () => {
        // ログインでページを離れる方式は、上で確かめたばかりなので省く（ほかのタブの確認は0.4秒待つ。2026-10-08）
        if (!p.loginLeavesPage) await precheck();
        L.lap('check');
        progStep(`${p.label}を確認しています`);
        const backend = p.createBackend();
        let info = await inspect(backend);
        if (info.state === 'empty') {
          // クラウドにまだ同期がない：この端末の同期（同期ファイルなどで使っていたもの）を置くか、新しく作る
          let manifest;
          if (await getKeys()) {
            const m = await metaGet('manifest');
            manifest = m && m.value;
            if (!manifest) throw new SyncError('同期の設定が見つかりません。「この端末を忘れる」を実行してからやり直してください');
            const ok = await dialog({ message: `${p.label}にはまだ同期がありません。この端末で使っている同期（今のパスフレーズ）を、${p.label}に置きます。\nほかの端末は、同じパスフレーズのまま${p.label}で同期できます。`, okLabel: '置く' });
            if (!ok) { showResult(['やめました'], ''); return; }
            if (!(await firstBackupIfNeeded())) { showResult(['やめました'], ''); return; }
          } else {
            const pass = await dialog({
              message: `同期用のパスフレーズを決めてください（${PASSPHRASE_MIN}文字以上）。\n忘れると${p.label}のデータは誰にも開けません。ほかの端末で同期を始めるときに入力します。`,
              pass: 2, okLabel: '決定', validate: checkPassphraseRule,
            });
            if (pass === null) { showResult(['やめました'], ''); return; }
            if (!(await firstBackupIfNeeded())) { showResult(['やめました'], ''); return; }
            progStep('鍵を作っています');
            manifest = await createSpace(pass);
          }
          await backend.write(MANIFEST_NAME, te.encode(JSON.stringify(manifest)));
          info = await inspect(backend);
        }
        if (info.state === 'otherSpace') {
          const ok = await dialog({ message: `この端末は、別のパスフレーズで作った同期を使っています。${p.label}の同期に切り替えますか？\n（この端末のデータは消えません。切り替えた後は、この端末のデータと${p.label}のデータを合流させます）`, okLabel: '切り替える', danger: true });
          if (!ok) { showResult(['やめました'], ''); return; }
          await forgetDevice();
          info = await inspect(backend);
        }
        if (info.state === 'needsPassphrase') {
          const pass = await dialog({
            message: '同期のパスフレーズを入力してください（最初の端末で決めたもの）',
            pass: 1, okLabel: '開く',
            validate: async (pp) => {
              try { dlgErr.textContent = '確認しています…'; await unlock(info.manifest, pp); return ''; } catch (err) { return userFacing(err) ? err.message : '確認に失敗しました'; }
            },
          });
          if (pass === null) { showResult(['やめました'], ''); return; }
        }
        if (!(await firstBackupIfNeeded())) { showResult(['やめました'], ''); return; }
        L.lap('prepare'); // 確認・（初めてなら）パスフレーズなどのやり取り
        const report = await syncWith(backend, { confirmSensitive, scanAll: true, onProgress: progStep, canApply: () => !stageBusy() });
        L.lap('sync');
        L.report(report);
        await metaPut({ ...(await cloudMeta()), provider: p.id, connected: true });
        await p.persist(); // 鍵ができた後に、更新用トークンを暗号化して保存する（OneDrive）
        L.lap('persist');
        if (touchesMain(report.appliedDbs)) needReload = true;
        showResult(resultLinesFor(report, `${p.label}と同期しました。`), 'ok');
        if (needReload) appendButton(RELOAD_BUTTON, () => location.reload(), 'primary');
        updateIndicator('ok');
        await refresh();
      });
    }
    if (cloudBtn) cloudBtn.addEventListener('click', () => run(cloudSyncFlow, { title: '同期しています' }));
    if (cloudOffBtn) cloudOffBtn.addEventListener('click', () => run(async () => {
      const c = await cloudMeta();
      const p = providers[c.provider];
      const label = p ? p.label : 'クラウド';
      const ok = await dialog({ message: `${label}との接続を解除します。この端末では自動の同期もしなくなり、覚えているログインも消します。\n${label}上のデータと、この端末のデータは消えません。`, okLabel: '解除する', danger: true });
      if (!ok) { showResult(['やめました'], ''); return; }
      if (p) await p.signOut();
      await metaPut({ ...c, connected: false });
      showResult([`${label}との接続を解除しました`], 'ok');
      await refresh();
    }, { title: '接続を解除' }));
    if (cloudAuto) cloudAuto.addEventListener('change', async () => {
      const c = await cloudMeta();
      await metaPut({ ...c, auto: cloudAuto.checked });
    });

    // ===================== 自動の同期（ログイン中だけ。確認が必要な場面では何もしない） =====================
    // いつ：開いたとき／しばらく離れて戻ったとき（受け取り）・アプリを閉じたとき／画面を離れるとき（未送信があれば送る）・
    //       アプリを開いたまま30分（未送信があれば「送るだけ」）
    let autoRunning = false;
    let reloadPending = false;
    let hiddenAt = 0;
    function otherModalOpen() {
      return !!document.querySelector('.settings-overlay.is-open, .launcher-modal-overlay.is-open, .launcher-confirm-overlay.is-open');
    }
    function reloadSoon() {
      if (reloadPending) return;
      reloadPending = true;
      banner.show({ text: '☁ ランチャー・本体の設定の変更を受け取りました（保存済み）。画面の表示を最新にします', kind: 'ok' });
      const tryReload = () => {
        if (!stageBusy() && !otherModalOpen()) location.reload();
        else setTimeout(tryReload, 2000);
      };
      setTimeout(tryReload, 2000);
    }
    async function fullScanDue() {
      const s = (await metaGet('status')) || {};
      return !s.lastFullScanAt || Date.now() - s.lastFullScanAt > FULL_SCAN_MS;
    }
    // 自動の同期の本体。showBanner のときは、上の帯で進み具合と結果を知らせる
    let autoPromise = null;
    function autoRun(cp, hooks = {}) {
      if (autoRunning || reloadPending || overlay.classList.contains('is-busy')) {
        // 走らせなかったことも残す（きっかけが重なっている回数を見るため）
        addRunLog({ kind: 'auto', trigger: hooks.trigger || '', result: 'skip', skip: autoRunning ? 'running' : reloadPending ? 'reloading' : 'manualBusy', ms: {} });
        return Promise.resolve(null);
      }
      autoPromise = autoRunInner(cp, hooks).finally(() => { autoPromise = null; });
      return autoPromise;
    }
    async function autoRunInner(cp, hooks) {
      const { p } = cp;
      autoRunning = true;
      const say = (text, kind = 'busy', extra = {}) => { if (hooks.showBanner) banner.show({ text, kind, ...extra }); };
      const L = startRunLog('auto', hooks.trigger, { pushOnly: !!hooks.pushOnly, scanAll: !!hooks.scanAll, freshBlobs: !!hooks.freshBlobs });
      if (hooks.tokenMs) L.e.ms.startCheck = hooks.tokenMs; // 開いたときの同期の前の、ログインの確かめ
      try {
        // ログインの確認と、ほかのタブの確認（返事を0.4秒待つ）は並べて行う（2026-10-08）
        const [token, others] = await Promise.all([p.ensureToken({ interactive: false }), otherTabsOpen()]);
        L.lap('check');
        if (!token) { L.skip('notLoggedIn'); updateIndicator(); return null; } // 自動ではログインし直さない
        if (others) { L.skip('otherTabs'); return null; }
        updateIndicator('busy');
        say(hooks.pushOnly ? `☁ ${p.label}へ送っています（アプリは開いたまま）…` : `☁ ${p.label}と同期しています…`);
        const report = await withLock(async () => {
          L.lap('lock');
          const backend = p.createBackend();
          const info = await inspect(backend);
          L.lap('inspect');
          if (info.state !== 'ready') throw new SyncError(`${p.label}の同期を確認してください（☁から同期してください）`);
          const r = await syncWith(backend, {
            ...hooks,
            onProgress: (t) => say(`☁ ${t}…`),
            canApply: () => !stageBusy(),
          });
          L.lap('sync');
          return r;
        });
        L.report(report);
        await p.persist();
        L.lap('persist');
        updateIndicator('ok');
        const inN = report.results.reduce((a, r) => a + r.inAdd + r.inChange + r.inDel, 0);
        const outN = report.results.reduce((a, r) => a + r.outAdd + r.outChange + r.outDel, 0);
        const msg = hooks.pushOnly ? `☁ 送りました（${outN}件）` : (inN || outN ? `☁ 同期しました（受け取り${inN}件・送り出し${outN}件）` : '☁ 最新です');
        say(msg, 'ok', { hideMs: 4000 });
        // 両方の端末で変えていたデータがあれば、帯で知らせて「違いを見る」を出す（帯を出さないきっかけでも出す。2026-10-10）
        if (report.conflicts && !hooks.pushOnly) {
          const ids = report.conflictIds || [];
          banner.show({ text: `☁ 両方の端末で変えていたデータが${report.conflicts}件ありました。新しい方を採用し、もう一方を控えました`, kind: 'conflict', actions: [
            { label: '違いを見る', cls: 'primary', onClick: () => { banner.hide(); openConflicts(ids.length === 1 ? ids[0] : null); } },
            { label: '閉じる', onClick: () => banner.hide() },
          ] });
        }
        if (touchesMain(report.appliedDbs)) reloadSoon();
        return report;
      } catch (err) {
        L.fail(err);
        if (userFacing(err)) console.warn('自動の同期を中止しました：' + err.message);
        else { console.error(err); addLog('error', err && err.stack ? err.stack : String(err)); }
        const loginLost = err && err.code === 'login';
        updateIndicator(loginLost ? undefined : 'error');
        if (hooks.showBanner) {
          banner.show({ text: '☁ 同期できませんでした：' + (err && err.message), kind: 'error', actions: [
            { label: 'もう一度', onClick: () => { banner.hide(); open(); } },
            { label: '閉じる', onClick: () => banner.hide() },
          ] });
        }
        return null;
      } finally {
        autoRunning = false;
        L.lap('after');
        await updateUnsent();
        L.lap('unsent');
        await L.end();
        if (overlay.classList.contains('is-open')) refreshRunlog();
      }
    }

    // ---- 開いた直後の同期の間は、アプリを開くのを待ってもらう（main.js の openStage から呼ばれる） ----
    let gate = null;
    window.SideOpsSyncGate = (openLater) => {
      if (!gate) return false;
      if (!gate.pending) gate.heldAt = performance.now(); // 待ってもらい始めた時刻（同期のログ用）
      gate.pending = openLater;
      banner.show({ text: '☁ ほかの端末の変更を受け取っています。終わったらアプリを開きます', kind: 'busy', actions: [{ label: '待たずに開く', onClick: () => releaseGate(true, 'skip') }] });
      return true;
    };
    function releaseGate(openNow, how = 'synced') {
      const g = gate;
      gate = null;
      // アプリを開くのを待ってもらった時間を残す（いちばん体感に響く待ち）
      if (g && g.pending) addRunLog({ kind: 'gate', trigger: g.trigger || '', result: how, ms: { total: Math.round(performance.now() - (g.heldAt || performance.now())) } });
      if (g && g.pending && openNow && !reloadPending) g.pending();
    }

    // 開いたとき（しばらく離れて戻ったときも）：ログイン中なら裏で受け取る。ログインが切れていたら、まず確かめる
    // trigger：'open'（ページを開いた）・'return'（しばらく離れて戻った）
    async function startupSync(trigger = 'open') {
      const cp = await connectedProvider();
      if (!cp || !cp.c.auto || stageBusy() || overlay.classList.contains('is-busy')) return;
      // 覚えているログインが本当に使えるかは、取り直してみるまで分からない。だめなら、ここで止めて確かめる
      const t0 = performance.now();
      let usable = (await cp.p.status()) === 'ready';
      if (usable) { try { usable = await cp.p.ensureToken({ interactive: false }); } catch (err) { usable = false; } }
      if (!usable) {
        addRunLog({ kind: 'auto', trigger, result: 'skip', skip: 'loginGate', ms: { total: Math.round(performance.now() - t0) } });
        await showLoginGate(cp.p);
        return;
      }
      gate = { pending: null, trigger };
      try {
        const due = await fullScanDue();
        await autoRun(cp, { showBanner: true, scanAll: due, freshBlobs: due, trigger, tokenMs: Math.round(performance.now() - t0) });
      } finally {
        releaseGate(true);
      }
    }

    // ログインが切れていたとき：いったん止めて、同期してから作業するか、そのまま作業するかを選んでもらう
    async function showLoginGate(p) {
      const status = (await metaGet('status')) || {};
      const unsent = await unsentDbs();
      progOpen(`${p.label}のログインが切れています`);
      showResult([
        `前回の同期：${fmt(status.lastSyncAt)}`,
        `この端末の未送信：${unsent.length ? 'あり（' + unsent.map((r) => r.label).join('・') + '）' : 'なし'}`,
        'ほかの端末に新しいデータがあるかは、ログインすると確認できます（たいていパスワードの入力なしで戻ってきます）。',
      ], '');
      progActions([
        { id: 'syncGateLogin', label: 'ログインして確認', cls: 'primary', onClick: () => loginAndCheck(p) },
        { id: 'syncGateSkip', label: '同期せずに作業する', onClick: () => { progClose(); updateIndicator(); scheduleUnsent(); } },
      ]);
    }
    async function loginAndCheck(p) {
      progActions([]);
      progStep('ログインしています');
      try {
        if (p.loginLeavesPage) await precheck();
        sessionStorage.setItem(INTENT_KEY, 'check');
        if (await p.ensureToken({ interactive: true })) await afterLoginCheck(p); // ポップアップ型はここへ戻る。ページを離れる型は戻ってから続ける
      } catch (err) {
        progStep('');
        showResult([userFacing(err) ? err.message : 'ログインに失敗しました'], 'error');
        progActions([{ id: 'syncProgressOk', label: '閉じる', onClick: progClose }]);
      }
    }
    // ログインしてから：ほかの端末が新しいデータを送っていれば知らせて選んでもらう。なければそのまま閉じる
    async function afterLoginCheck(p) {
      sessionStorage.removeItem(INTENT_KEY);
      progOpen('ほかの端末の変更を確かめています');
      progStep('確認しています');
      let r;
      try {
        r = await checkRemote(p.createBackend());
      } catch (err) {
        progStep('');
        showResult([userFacing(err) ? err.message : '確認に失敗しました'], 'error');
        progActions([{ id: 'syncProgressOk', label: '閉じる', onClick: progClose }]);
        return;
      }
      progStep('');
      updateIndicator();
      if (r.state !== 'ready' || r.newer.length) {
        progTitle.textContent = 'ほかの端末に新しいデータがあります';
        showResult(r.state !== 'ready' ? ['同期の状態を確かめる必要があります。同期すると確かめられます。']
          : r.newer.map((d) => `${d.name}：${fmt(d.at)} に送ったデータがあります（クラウドの方が新しい）`), '');
        progActions([
          { id: 'syncGateSync', label: '同期する（おすすめ）', cls: 'primary', onClick: () => { progClose(); open(); } },
          { id: 'syncGateSkip', label: '同期せずに作業する', onClick: () => { progClose(); scheduleUnsent(); } },
        ]);
        return;
      }
      progTitle.textContent = '最新です';
      showResult(['ほかの端末に新しいデータはありません'], 'ok');
      progActions([{ id: 'syncProgressOk', label: 'OK', cls: 'primary', onClick: progClose }]);
      setTimeout(() => { if (progTitle.textContent === '最新です') progClose(); }, 1500);
      // この端末に未送信があれば、裏で送っておく
      const cp = await connectedProvider();
      if (cp && (await unsentDbs()).length) autoRun(cp, { showBanner: true, trigger: 'afterLogin' });
    }

    // ---- 未送信の表示：☁に印。ログインが切れているなど自動で送れないときは、帯で知らせる ----
    let unsentTimer = 0;
    function scheduleUnsent() { clearTimeout(unsentTimer); unsentTimer = setTimeout(updateUnsent, 800); }
    async function updateUnsent() {
      try {
        const cp = await connectedProvider();
        unsentNow = cp ? await unsentDbs() : [];
        updateIndicator();
        if (!unsentNow.length) { banner.hide('unsent'); return; }
        if (cp.c.auto && (await cp.p.status()) === 'ready') return; // 自動で送れるときは帯を出さない
        if (stageBusy()) return; // 作業中は帯で邪魔しない（☁の印だけ）
        const marks = readDirtyMarks();
        const newest = Math.max(...unsentNow.map((rl) => marks[rl.name] || 0));
        const dismissed = Number(localStorage.getItem(DISMISS_KEY) || 0);
        if (dismissed >= newest) return; // 「あとで」を押した後、新しい変更がなければ出さない
        if (banner.kind === 'busy' || banner.kind === 'error') return;
        banner.show({
          kind: 'unsent',
          text: `☁ 未送信の変更があります（${unsentNow.map((rl) => rl.label).join('・')}）`,
          actions: [
            { label: '今すぐ同期', cls: 'primary', onClick: () => { banner.hide(); open(); } },
            { label: 'あとで', onClick: () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (err) { /* 無視 */ } banner.hide(); } },
          ],
        });
      } catch (err) { /* 表示できなくても作業には影響しない */ }
    }
    onLocalChange = () => scheduleUnsent();
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith(DIRTY_PREFIX)) scheduleUnsent(); });

    // ---- 自動の同期のきっかけ ----
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        try { localStorage.setItem(LAST_HIDDEN_KEY, String(hiddenAt)); } catch (err) { /* 残せなくても動く */ }
        // 画面を離れるとき：未送信があれば送る（スマホでは途中で止められることがある。その分は次回送る）
        const cp = await connectedProvider();
        if (cp && cp.c.auto && !stageBusy() && (await unsentDbs()).length) autoRun(cp, { trigger: 'hidden' });
        return;
      }
      // しばらく離れて戻ったとき：開いたときと同じ扱い（ほかの端末で作業していたかもしれない）
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      if (away >= Math.min(30 * 1000, AWAY_MS)) addRunLog({ kind: 'away', trigger: away >= AWAY_MS ? 'return' : '', result: '', ms: { total: away } }); // 離れていた時間（30秒以上）
      if (hiddenAt && away >= AWAY_MS) startupSync('return');
      else scheduleUnsent();
      hiddenAt = 0;
    });
    const stageEl = document.getElementById('stageEl');
    if (stageEl) {
      let wasOpen = stageEl.classList.contains('is-open');
      new MutationObserver(() => {
        const nowOpen = stageEl.classList.contains('is-open');
        if (wasOpen && !nowOpen) {
          // アプリを閉じたとき：保存し終えるのを待って、未送信があれば送る
          setTimeout(async () => {
            const cp = await connectedProvider();
            if (cp && cp.c.auto && !stageBusy() && (await unsentDbs()).length) autoRun(cp, { showBanner: true, trigger: 'stageClose' });
            else scheduleUnsent();
          }, STAGE_RETIRE_WAIT_MS + 500);
        }
        wasOpen = nowOpen;
      }).observe(stageEl, { attributes: true, attributeFilter: ['class'] });
    }
    // アプリを開いたまま長く作業しているとき：30分ごとに「送るだけ」（受け取りはアプリを閉じた後）
    setInterval(async () => {
      if (document.visibilityState !== 'visible' || stageBusy() !== 'open') return;
      const cp = await connectedProvider();
      if (!cp || !cp.c.auto) return;
      const s = (await metaGet('status')) || {};
      if (Date.now() - (s.lastPushAt || 0) < PUSH_EVERY_MS) return;
      if (!(await unsentDbs()).length) return;
      autoRun(cp, { pushOnly: true, showBanner: true, trigger: 'push30' });
    }, hook.pushCheckMs || 60 * 1000);

    // ===================== 同期のログ（かかった時間）（2026-10-08） =====================
    const runlogEl = $('syncRunlog');
    const TRIGGER_LABEL = { open: '開いたとき', return: '戻ったとき', hidden: '離れるとき', stageClose: 'アプリを閉じたとき', push30: '30分ごと', afterLogin: 'ログインの後', manual: '☁を押した' };
    const sec = (ms) => (Math.max(0, ms || 0) / 1000).toFixed(1);
    // この端末の、ここ24時間のまとめ
    async function refreshRunlog() {
      if (!runlogEl) return;
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const list = (await listRunLog()).filter((e) => e.at >= since);
      const runs = list.filter((e) => (e.kind === 'auto' || e.kind === 'manual') && e.result !== 'skip');
      if (!list.length) { runlogEl.textContent = 'まだログはありません'; return; }
      const total = runs.reduce((a, e) => a + (e.ms.total || 0), 0);
      const longest = runs.reduce((m, e) => ((e.ms.total || 0) > ((m && m.ms.total) || 0) ? e : m), null);
      const lines = [`ここ24時間：同期${runs.length}回・合計${sec(total)}秒${runs.length ? `・1回あたり${sec(total / runs.length)}秒` : ''}${longest ? `・いちばん長い${sec(longest.ms.total)}秒（${TRIGGER_LABEL[longest.trigger] || longest.trigger || '?'}）` : ''}`];
      const by = {};
      runs.forEach((e) => { const k = e.trigger || '?'; (by[k] = by[k] || { n: 0, ms: 0 }); by[k].n++; by[k].ms += e.ms.total || 0; });
      if (Object.keys(by).length) lines.push('きっかけ：' + Object.entries(by).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${TRIGGER_LABEL[k] || k} ${v.n}回（${sec(v.ms)}秒）`).join('・'));
      const skips = list.filter((e) => e.result === 'skip').length;
      const pages = list.filter((e) => e.kind === 'page');
      const discarded = pages.filter((e) => e.discarded).length;
      const gates = list.filter((e) => e.kind === 'gate');
      lines.push(`ページの読み込み${pages.length}回${discarded ? `（うち、ブラウザが裏で閉じたのを開き直し${discarded}回）` : ''}・アプリを開くのを待った${gates.length}回（${sec(gates.reduce((a, e) => a + (e.ms.total || 0), 0))}秒）・見送り${skips}回`);
      // 直近の5回の内訳（全体／通信／データの見直し）
      const recent = runs.slice(-5).reverse();
      if (recent.length) {
        lines.push('直近の同期：');
        recent.forEach((e) => {
          const t = e.t || {};
          const scan = Object.values(t.scan || {}).reduce((a, b) => a + b, 0);
          const d = new Date(e.at);
          const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          lines.push(`　${hm} ${TRIGGER_LABEL[e.trigger] || e.trigger || '?'}：${sec(e.ms.total)}秒${t.total !== undefined ? `（通信 ${sec(t.net)}秒・${t.netCount}回／見直し ${sec(scan)}秒）` : ''}${e.result === 'error' ? '　失敗' : ''}`);
        });
      }
      runlogEl.textContent = lines.join('\n');
    }
    // 同期の結果の「ログを見る」：☁の画面に残って、同期のログの欄まで送る（今の同期の分も入れて出し直す）
    async function showRunlog() {
      if (!runlogEl) return;
      try { await refreshRunlog(); } catch (err) { console.warn('同期のログを読めませんでした', err); } // 読めなくても欄までは送る
      const row = runlogEl.closest('.settings-row') || runlogEl;
      row.scrollIntoView({ block: 'start' });
    }
    // 書き出し：この端末のログと、OneDriveに置かれたほかの端末のログを1つのファイルにする。
    // OneDriveにつないでいれば、この端末のログも暗号化して置く（ほかの端末で書き出したときに入るように）
    async function exportRunLogs() {
      const dev = await getDevice();
      const me = { deviceName: dev.name, device: String(dev.id).slice(0, 8), build: SYNC_APP_BUILD, ua: navigator.userAgent, entries: await listRunLog() };
      const out = { format: 'sideops-sync-log', formatVersion: 1, exportedAt: new Date().toISOString(), devices: [me] };
      const notes = [`この端末のログ：${me.entries.length}件`];
      const cp = await connectedProvider();
      const keys = await getKeys();
      if (cp && keys && (await cp.p.status()) === 'ready' && (await cp.p.ensureToken({ interactive: false }))) {
        progStep(`${cp.p.label}にログを置いています`);
        const backend = cp.p.createBackend();
        const info = await inspect(backend);
        if (info.state === 'ready') {
          const spaceId = info.manifest.spaceId;
          const names = fileNames(keys);
          const mine = await names.log(dev.id);
          await writeJsonFile(backend, keys, spaceId, mine, me);
          for (const n of await backend.list()) {
            if (!n.startsWith('l_') || n === mine) continue;
            try {
              const o = await readJsonFile(backend, keys, spaceId, n);
              if (isPlainObject(o) && Array.isArray(o.entries)) { out.devices.push(o); notes.push(`${String(o.deviceName || '別の端末').slice(0, 40)}のログ：${o.entries.length}件`); }
            } catch (err) { notes.push('読めないログがありました'); }
          }
        }
      } else {
        notes.push('（クラウドにつないでいないため、ほかの端末のログは入っていません）');
      }
      downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `sideops-sync-log-${stamp()}.json`);
      return notes;
    }
    $('syncRunlogExportBtn').addEventListener('click', () => run(async () => {
      const notes = await exportRunLogs();
      showResult(['同期のログを書き出しました。', ...notes, 'ファイルはダウンロードのフォルダに入ります。分析に使うときは、このファイルを渡してください（データの中身は入っていません）'], 'ok');
    }, { title: '同期のログを書き出しています' }));
    $('syncRunlogClearBtn').addEventListener('click', () => run(async () => {
      const ok = await dialog({ message: 'この端末の同期のログを消します（同期のデータには影響しません）。', okLabel: '消す', danger: true });
      if (!ok) { showResult(['やめました'], ''); return; }
      await clearRunLog();
      showResult(['この端末の同期のログを消しました'], 'ok');
      await refreshRunlog();
    }, { title: '同期のログを消しています' }));

    // ===================== 競合の控え：一覧と「違いを見る」（2026-10-10） =====================
    // 両方の端末で同じデータを変えていたとき、採用されなかった方（控え）と採用された方を、項目ごとに見比べる。
    // 見るだけ（データは変えない）。文字の項目は行ごとに比べ、少しだけ変えた行は、変えた文字に印を付ける
    const conflictListEl = $('syncConflictList');
    const diffEl = $('syncDiff');
    const diffMeta = $('syncDiffMeta');
    const diffBody = $('syncDiffBody');
    const diffRestoreBtn = $('syncDiffRestore');
    const CONFLICT_SHOW = 20;
    const DIFF_CONTEXT = 2; // 変わった行の前後に出す、同じ行の数
    const FIELD_LABEL = {
      title: 'タイトル', name: '名前', body: '本文', text: '本文', content: '本文', memo: 'メモ', note: 'メモ', notes: 'メモ',
      tags: 'タグ', genre: 'ジャンル', cover: 'カバー', image: '画像', prompt: 'プロンプト', createdAt: '作った日時', updatedAt: '変えた日時', order: '並び順',
    };
    const fieldLabel = (k) => (FIELD_LABEL[k] ? `${FIELD_LABEL[k]}（${k}）` : k);
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    // 一覧に出すデータの名前：タイトル・名前などの文字の項目。なければキー
    function recordName(v, key) {
      if (isPlainObject(v)) {
        for (const k of ['title', 'name', 'label', 'heading', 'text', 'body', 'memo']) {
          if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim().replace(/\s+/g, ' ').slice(0, 40);
        }
      }
      if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 40);
      return 'キー ' + String(typeof key === 'string' ? key : JSON.stringify(key)).slice(0, 40);
    }
    const isImageLike = (v) => (v instanceof Blob && (!v.type || v.type.startsWith('image/'))) || (typeof v === 'string' && v.startsWith('data:image/'));
    // 見比べるための文字にする（画像・バイナリは、種類と大きさだけ）
    function displayText(k, v) {
      if (v === undefined) return null;
      if (typeof v === 'string') return v;
      if (typeof v === 'number' && /(At|Date)$|^at$/.test(k) && v > 1e11 && v < 1e14) return new Date(v).toLocaleString('ja-JP');
      return JSON.stringify(v, (kk, x) => {
        if (x instanceof Blob) return `［${x.type || 'ファイル'}・${x.size}バイト］`;
        if (typeof x === 'string' && x.startsWith('data:') && x.length > 200) return `［${x.slice(5, Math.min(40, Math.max(5, x.indexOf(';'))))}の画像・${x.length}文字］`;
        if (x instanceof ArrayBuffer) return `［バイナリ・${x.byteLength}バイト］`;
        if (ArrayBuffer.isView(x)) return `［バイナリ・${x.byteLength}バイト］`;
        return x;
      }, 2);
    }
    // 同じ中身か（画像は中身の要約で比べる）
    async function sameValue(a, b) {
      if (a === b) return true;
      try {
        const ctx = { hash: sha256Hex, blobs: new Map() };
        return canonical(await encodeValue(a, ctx)) === canonical(await encodeValue(b, ctx));
      } catch (err) {
        return displayText('', a) === displayText('', b);
      }
    }
    // 1行の中で違う文字に印を付ける部品。ほとんど違う行は、印を付けない（行の色だけ）
    function linePieces(cd, side) {
      const shown = cd.filter((c) => c.t === '=' || c.t === side);
      const same = shown.filter((c) => c.t === '=').length;
      const markOn = shown.length > 0 && same / shown.length >= 0.3;
      const out = [];
      for (const c of shown) {
        const mark = markOn && c.t === side;
        const last = out[out.length - 1];
        if (last && last.mark === mark) last.text += c.v;
        else out.push({ text: c.v, mark });
      }
      return out;
    }
    function addDiffLine(box, t, parts) {
      const row = mk('div', 'sync-diff-line' + (t === '-' ? ' is-del' : t === '+' ? ' is-add' : ''));
      row.appendChild(mk('span', 'sync-diff-sign', t === '-' ? '−' : t === '+' ? '＋' : ' '));
      const body = mk('span', 'sync-diff-text');
      for (const p of parts) {
        if (p.mark) body.appendChild(mk('mark', '', p.text));
        else body.appendChild(document.createTextNode(p.text));
      }
      if (!body.textContent) body.textContent = ' '; // 空の行も高さを持たせる
      row.appendChild(body);
      box.appendChild(row);
    }
    // 行の違いを出す。同じ行が続くところは、変わった行の前後だけ出して「同じ行がn行」にまとめる
    function renderDiffLines(ops, box) {
      const keep = new Array(ops.length).fill(false);
      ops.forEach((o, i) => {
        if (o.t === '=') return;
        for (let j = Math.max(0, i - DIFF_CONTEXT); j <= Math.min(ops.length - 1, i + DIFF_CONTEXT); j++) keep[j] = true;
      });
      let i = 0;
      while (i < ops.length) {
        if (!keep[i]) {
          let j = i;
          while (j < ops.length && !keep[j]) j++;
          box.appendChild(mk('div', 'sync-diff-fold', `…同じ行が${j - i}行…`));
          i = j;
          continue;
        }
        if (ops[i].t === '-') {
          let j = i;
          while (j < ops.length && ops[j].t === '-') j++;
          let k = j;
          while (k < ops.length && ops[k].t === '+') k++;
          const dels = ops.slice(i, j), adds = ops.slice(j, k);
          // 消した行と足した行が同じ数で並んでいて、どれも長すぎなければ、行どうしを文字で比べる
          if (dels.length === adds.length && dels.length <= 30 && dels.every((o, x) => o.v.length <= 500 && adds[x].v.length <= 500)) {
            const pairs = dels.map((o, x) => diffSeq(Array.from(o.v), Array.from(adds[x].v), 300));
            pairs.forEach((cd) => addDiffLine(box, '-', linePieces(cd, '-')));
            pairs.forEach((cd) => addDiffLine(box, '+', linePieces(cd, '+')));
            i = k;
            continue;
          }
        }
        addDiffLine(box, ops[i].t, [{ text: ops[i].v, mark: false }]);
        i++;
      }
    }
    let diffUrls = [];
    function diffImageCell(label, v) {
      const cell = mk('div', 'sync-diff-image');
      cell.appendChild(mk('div', 'sync-diff-image-label', label));
      if (v === undefined || v === null || v === '') cell.appendChild(mk('div', 'sync-diff-note', 'なし'));
      else if (isImageLike(v)) {
        const img = document.createElement('img');
        img.alt = label;
        if (typeof v === 'string') img.src = v;
        else { const u = URL.createObjectURL(v); diffUrls.push(u); img.src = u; }
        cell.appendChild(img);
      } else cell.appendChild(mk('div', 'sync-diff-note', String(displayText('', v)).slice(0, 200)));
      return cell;
    }
    function renderDiffField(k, lv, wv, box) {
      const block = mk('div', 'sync-diff-field');
      block.appendChild(mk('div', 'sync-diff-field-name', k === null ? '中身' : fieldLabel(k)));
      if (isImageLike(lv) || isImageLike(wv)) {
        const pair = mk('div', 'sync-diff-images');
        pair.appendChild(diffImageCell('−控え', lv));
        pair.appendChild(diffImageCell('＋採用', wv));
        block.appendChild(pair);
      } else {
        const a = displayText(k || '', lv), b = displayText(k || '', wv);
        if (a === null) block.appendChild(mk('div', 'sync-diff-note', '控えには、この項目がありません'));
        if (b === null) block.appendChild(mk('div', 'sync-diff-note', '採用された方には、この項目がありません'));
        const lines = mk('div', 'sync-diff-lines');
        renderDiffLines(diffSeq(a === null ? [] : a.split(/\r?\n/), b === null ? [] : b.split(/\r?\n/)), lines);
        if (lines.childNodes.length) block.appendChild(lines);
      }
      box.appendChild(block);
    }
    function closeDiff() {
      if (!diffEl) return;
      diffEl.classList.remove('is-open');
      diffUrls.forEach((u) => URL.revokeObjectURL(u));
      diffUrls = [];
    }
    async function openDiff(id) {
      if (!diffEl) return;
      closeDiff();
      diffMeta.textContent = '';
      diffBody.textContent = '読み込んでいます…';
      if (diffRestoreBtn) { diffRestoreBtn.hidden = true; diffRestoreBtn.dataset.conflictId = ''; } // 戻すボタンは、控えを読めたときだけ出す
      diffEl.classList.add('is-open');
      try {
        const c = await getConflict(id);
        diffBody.textContent = '';
        if (!c) { diffBody.appendChild(mk('div', 'sync-diff-note', 'この控えは見つかりません（30日たって消えたか、この端末の同期を解除しました）')); return; }
        if (diffRestoreBtn) { diffRestoreBtn.hidden = false; diffRestoreBtn.dataset.conflictId = c.id; }
        const myId = (await getDevice()).id;
        const who = (by, ver) => by || (typeof ver === 'string' && ver.slice(19) === myId ? 'この端末' : 'ほかの端末');
        const when = (ver) => (typeof ver === 'string' && VER_RE.test(ver) ? `（${fmt(verTime(ver))}に同期）` : ''); // 版の時刻＝その変更を同期で見つけた時刻
        // 勝った方の中身を残していない古い控え（2026-10-10より前）は、今のデータと見比べる
        const legacy = !Object.prototype.hasOwnProperty.call(c, 'winnerDeleted');
        let winner = c.winner, winnerDeleted = !!c.winnerDeleted;
        if (legacy) {
          const cur = await currentRecord(c.db, c.store, c.key);
          winner = cur.value;
          winnerDeleted = !!cur.missing;
        }
        diffMeta.appendChild(mk('div', 'sync-diff-head', `${fmt(c.at)}の同期　${ruleLabel(c.db)}：${recordName(c.value, c.key)}`));
        const legend = mk('div', 'sync-diff-legend');
        const l1 = mk('div', 'sync-diff-line is-del');
        l1.appendChild(mk('span', 'sync-diff-sign', '−'));
        l1.appendChild(mk('span', 'sync-diff-text', `控え（採用されなかった方）：${who(c.loserBy, c.loserVer)}${when(c.loserVer)}`));
        const l2 = mk('div', 'sync-diff-line is-add');
        l2.appendChild(mk('span', 'sync-diff-sign', '＋'));
        l2.appendChild(mk('span', 'sync-diff-text', legacy ? '今のデータ（採用された方。その後に変えていれば、変えた後）' : `採用された方：${who(c.winnerBy, c.winnerVer)}${when(c.winnerVer)}`));
        legend.appendChild(l1);
        legend.appendChild(l2);
        diffMeta.appendChild(legend);
        if (legacy) diffMeta.appendChild(mk('div', 'sync-diff-note', 'この控えは、採用された方の中身を残す前（2026-10-10より前）のものなので、今のデータと見比べています'));
        if (c.restoredAt) diffMeta.appendChild(mk('div', 'sync-diff-note sync-diff-restored', c.restoreUndoneAt
          ? `${fmt(c.restoredAt)}にこの控えの中身に戻し、${fmt(c.restoreUndoneAt)}に取り消しました`
          : `${fmt(c.restoredAt)}に、この控えの中身に戻しました（取り消すときは「同期の記録」から）`));
        if (winnerDeleted) diffMeta.appendChild(mk('div', 'sync-diff-note', legacy ? '今は、このデータはありません（消されています）' : '採用された方では、このデータは消されていました（消した方があとだったため）'));
        const lv = c.value;
        const wv = winnerDeleted ? undefined : winner;
        if (isPlainObject(lv) && (wv === undefined || isPlainObject(wv))) {
          const keys = [];
          const add = (k) => { if (!keys.includes(k)) keys.push(k); };
          ['title', 'name', 'label'].forEach((k) => { if (k in lv || (wv && k in wv)) add(k); });
          Object.keys(lv).forEach(add);
          if (wv) Object.keys(wv).forEach(add);
          const same = [];
          let shown = 0;
          for (const k of keys) {
            const a = lv[k], b = wv ? wv[k] : undefined;
            if (await sameValue(a, b)) { same.push(FIELD_LABEL[k] || k); continue; }
            renderDiffField(k, a, b, diffBody);
            shown++;
          }
          if (!shown) diffBody.appendChild(mk('div', 'sync-diff-note', 'どの項目も同じでした（見た目に出ない違いだけでした）'));
          if (same.length) diffBody.appendChild(mk('div', 'sync-diff-same', `同じだった項目：${same.join('・')}`));
        } else if (await sameValue(lv, wv)) {
          diffBody.appendChild(mk('div', 'sync-diff-note', '中身は同じでした'));
        } else {
          renderDiffField(null, lv, wv, diffBody);
        }
      } catch (err) {
        console.error(err);
        if (diffRestoreBtn) diffRestoreBtn.hidden = true; // 違いを見られないまま戻さない
        diffBody.textContent = '';
        diffBody.appendChild(mk('div', 'sync-diff-note', '違いを出せませんでした：' + (err && err.message)));
      }
    }
    async function refreshConflicts() {
      if (!conflictListEl) return;
      const list = await listConflicts();
      conflictListEl.textContent = '';
      if (!list.length) { conflictListEl.textContent = '競合の控えはありません'; return; }
      const myId = (await getDevice()).id;
      const who = (by, ver) => by || (typeof ver === 'string' && ver.slice(19) === myId ? 'この端末' : 'ほかの端末');
      for (const c of list.slice(0, CONFLICT_SHOW)) {
        const row = mk('div', 'sync-journal-row sync-conflict-row');
        row.dataset.conflictId = c.id;
        row.appendChild(mk('div', 'sync-journal-head', `${fmt(c.at)}　${ruleLabel(c.db)}：${recordName(c.value, c.key)}`));
        row.appendChild(mk('div', 'sync-conflict-sub', `採用：${who(c.winnerBy, c.winnerVer)}${c.winnerDeleted ? '（消した）' : ''}／控え：${who(c.loserBy, c.loserVer)}${c.restoredAt ? `　${fmt(c.restoredAt)}に控えに戻した${c.restoreUndoneAt ? '（取り消した）' : ''}` : ''}`));
        const acts = mk('div', 'sync-journal-actions');
        const b = mk('button', 'btn sync-conflict-diff', '違いを見る');
        b.addEventListener('click', () => openDiff(c.id));
        acts.appendChild(b);
        row.appendChild(acts);
        conflictListEl.appendChild(row);
      }
      if (list.length > CONFLICT_SHOW) conflictListEl.appendChild(mk('div', 'sync-diff-note', `ほかに${list.length - CONFLICT_SHOW}件（「競合の控えを書き出す」で、すべてを書き出せます）`));
    }
    // 結果・帯の「違いを見る」：☁の画面の競合の控えの欄まで送る。1件だけなら、そのまま違いを開く
    async function showConflicts(id) {
      try { await refreshConflicts(); } catch (err) { console.warn('競合の控えを読めませんでした', err); }
      if (conflictListEl) (conflictListEl.closest('.settings-row') || conflictListEl).scrollIntoView({ block: 'start' });
      if (id) await openDiff(id);
    }
    // 帯の「違いを見る」：☁の画面を（同期を始めずに）開いてから
    async function openConflicts(id) {
      await open({ autoSync: false });
      await showConflicts(id);
    }
    if (diffEl) {
      $('syncDiffClose').addEventListener('click', closeDiff);
      diffEl.addEventListener('click', (e) => { if (e.target === diffEl) closeDiff(); });
      if (diffRestoreBtn) diffRestoreBtn.addEventListener('click', () => { if (diffRestoreBtn.dataset.conflictId) restoreFlow(diffRestoreBtn.dataset.conflictId); });
    }
    // 「控えに戻す」（2026-10-10）：確認してから、今のデータを控えの中身で置き換える。
    // 歯止め：アプリ・ほかのタブを閉じているか確かめる／競合の後に変わっていたら知らせる／戻す前の中身を同期の記録に残す（取り消せる）
    function restoreFlow(id) {
      closeDiff(); // 進み具合・確認のダイアログを、違いの画面の下に隠さないように
      run(() => withLock(async () => {
        await precheck();
        const c = await getConflict(id);
        if (!c) throw new SyncError('競合の控えが見つかりません（30日たつと自動で消えます）');
        const name = `${ruleLabel(c.db)}：${recordName(c.value, c.key)}`;
        const same = () => showResult([`「${name}」は、もう控えと同じ中身です（戻す必要はありません）`], '');
        const chk = await restoreConflict(id, { mode: 'check' });
        if (chk.already) { same(); return; }
        const lines = [`「${name}」を、競合の控え（採用されなかった方）の中身に戻します。`];
        if (chk.missing) lines.push('今は、このデータはありません（消されています）。控えの中身で作り直します。');
        if (chk.changedSince) lines.push('※競合の後に、このデータは変わっています。その変更も、控えの中身で置き換わります（「違いを見る」は、競合のときの中身と比べています）。');
        lines.push('戻す前の中身は「同期の記録」に残すので、そこから取り消せます。戻したことは、次の同期でほかの端末にも届きます。');
        const ok = await dialog({ message: lines.join('\n'), okLabel: '控えに戻す', danger: true });
        if (!ok) { showResult(['やめました'], ''); return; }
        const out = await restoreConflict(id, { mode: 'apply' });
        if (out.already) { same(); return; }
        if (touchesMain([c.db])) needReload = true;
        const res = [`控えの中身に戻しました（${name}）`, '戻す前の中身は「同期の記録」に残しました。取り消すときは、そこの「取り消す」を押してください', '戻したことは、次の同期でほかの端末にも届きます'];
        res.push(needReload ? 'ランチャー・本体の設定の表示を最新にするため、閉じると再読み込みします' : 'アプリを開くと反映されています');
        showResult(res, 'ok');
        await refresh();
      }), { title: '競合の控えに戻しています' });
    }

    // ===================== 同期の記録（受け取った変更を戻す） =====================
    async function refreshJournal() {
      if (!journalEl) return;
      const list = await listJournal(8);
      journalEl.textContent = '';
      if (!list.length) { journalEl.textContent = 'まだ記録はありません（ほかの端末の変更を受け取ると、受け取る前の中身が残ります）'; return; }
      for (const e of list) {
        const row = document.createElement('div');
        row.className = 'sync-journal-row' + (e.undone ? ' is-undone' : '');
        const head = document.createElement('div');
        head.className = 'sync-journal-head';
        const apps = Object.entries(e.counts).map(([db, n]) => `${ruleLabel(db)}${n}件`).join('・');
        const what = e.kind === 'conflict' ? '競合の控えに戻した：' : ''; // 「控えに戻す」で残した記録（2026-10-10）
        head.textContent = `${fmt(e.at)}　${what}${apps || '（なし）'}${e.undone ? '　（取り消し済み）' : ''}`;
        row.appendChild(head);
        if (!e.undone && Object.keys(e.counts).length) {
          const acts = document.createElement('div');
          acts.className = 'sync-journal-actions';
          const all = document.createElement('button');
          all.className = 'btn';
          all.dataset.syncAction = 'undo';
          all.textContent = e.kind === 'conflict' ? '取り消す' : 'すべて戻す';
          all.addEventListener('click', () => undoFlow(e, null));
          acts.appendChild(all);
          if (Object.keys(e.counts).length > 1) {
            for (const db of Object.keys(e.counts)) {
              const b = document.createElement('button');
              b.className = 'btn';
              b.dataset.syncAction = 'undo';
              b.textContent = `${ruleLabel(db)}だけ戻す`;
              b.addEventListener('click', () => undoFlow(e, [db]));
              acts.appendChild(b);
            }
          }
          row.appendChild(acts);
        }
        journalEl.appendChild(row);
      }
    }
    function undoFlow(entry, dbs) {
      run(() => withLock(async () => {
        await precheck();
        const target = dbs ? dbs.map(ruleLabel).join('・') : Object.keys(entry.counts).map(ruleLabel).join('・');
        const isConflict = entry.kind === 'conflict';
        const ok = await dialog({
          message: (isConflict ? `${fmt(entry.at)}に競合の控えに戻した${target}のデータを、戻す前の中身にします。` : `${fmt(entry.at)}の同期で受け取った変更（${target}）を、受け取る前の中身に戻します。`)
            + '\n戻したことは、次の同期でほかの端末にも届きます。',
          okLabel: isConflict ? '取り消す' : '戻す', danger: true,
        });
        if (!ok) { showResult(['やめました'], ''); return; }
        const check = await undoJournal(entry.id, { dbs, mode: 'check' });
        let mode = 'unchangedOnly';
        if (check.modified) {
          const all = await dialog({
            message: isConflict ? '控えに戻した後に、このデータを変更しています。\n変更した分も、戻す前の中身にしますか？' : `そのうち${check.modified}件は、同期の後にこの端末で変更しています。\n変更した分も、受け取る前の中身に戻しますか？`,
            okLabel: '変更した分も戻す', cancelLabel: '変更していないものだけ戻す', danger: true,
          });
          mode = all ? 'all' : 'unchangedOnly';
        }
        const out = await undoJournal(entry.id, { dbs, mode });
        if (touchesMain(out.dbs)) needReload = true;
        const lines = [`戻しました：${out.restored}件（${out.dbs.map(ruleLabel).join('・') || 'なし'}）`];
        if (mode === 'unchangedOnly' && check.modified) lines.push(`同期の後に変更していた${check.modified}件は、そのままにしました`);
        lines.push('戻したことは、次の同期でほかの端末にも届きます');
        if (needReload) lines.push('ランチャー・本体の設定の表示を最新にするため、閉じると再読み込みします');
        showResult(lines, 'ok');
        await refresh();
      }), { title: '受け取った変更を戻しています' });
    }

    // ===================== ページを開いたとき =====================
    // ログイン（ページを離れる方式）から戻ったときは、その目的（確認だけ／同期）の続きをする。
    // それ以外は、開いたときの同期をする
    // ページの読み込みを残す（2026-10-08）：ブラウザが裏で閉じた（discard）タブを開き直したのか、
    // 前に画面を離れてからどれだけ経っていたか。開いたときの同期がどれだけ起きているかを見るため
    try {
      const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
      const lastHidden = Number(localStorage.getItem(LAST_HIDDEN_KEY) || 0);
      addRunLog({
        kind: 'page', trigger: nav ? nav.type : '', result: '',
        discarded: !!document.wasDiscarded, standalone: !!(window.matchMedia && window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches),
        ms: { total: Math.round(performance.now()), sinceHidden: lastHidden ? Date.now() - lastHidden : -1 },
      });
    } catch (err) { /* 残せなくても動く */ }
    (async () => {
      let resumed = false;
      for (const p of providerList) {
        let r = null;
        try { r = await p.redirectResult; } catch (err) { r = { error: 'ログインに失敗しました' }; }
        if (!r) continue;
        resumed = true;
        const resume = p.resumeKey && sessionStorage.getItem(p.resumeKey) === p.id;
        if (p.resumeKey) sessionStorage.removeItem(p.resumeKey);
        const intent = sessionStorage.getItem(INTENT_KEY) || 'sync';
        buildProviderOptions();
        if (cloudSel && !(await cloudMeta()).connected) cloudSel.value = p.id;
        if (r.error) {
          sessionStorage.removeItem(INTENT_KEY);
          await open({ autoSync: false });
          progOpen('ログインできませんでした');
          showResult([r.error], 'error');
          progActions([{ id: 'syncProgressOk', label: 'OK', cls: 'primary', onClick: progClose }]);
          continue;
        }
        if (intent === 'check' && (await cloudMeta()).connected) { await afterLoginCheck(p); continue; }
        sessionStorage.removeItem(INTENT_KEY);
        if (resume) {
          await open({ autoSync: false });
          run(cloudSyncFlow, { fromOpen: true, title: `${p.label}と同期しています` });
        }
      }
      applyCloudAvailability();
      updateIndicator();
      if (!resumed) await startupSync('open');
      scheduleUnsent();
    })();

    // ===================== 同期ファイル（手動・クラウドを使わないとき） =====================
    // 「新しく作る」：この端末のデータから同期ファイルを作る（初回はパスフレーズを決める）
    $('syncCreateBtn').addEventListener('click', () => run(() => withLock(async () => {
      await precheck();
      let keys = await getKeys();
      let manifest;
      if (!keys) {
        const p = await dialog({
          message: `同期用のパスフレーズを決めてください（${PASSPHRASE_MIN}文字以上）。\n忘れると同期ファイルは誰にも開けません。ほかの端末で同期を始めるときに入力します。`,
          pass: 2, okLabel: '決定', validate: checkPassphraseRule,
        });
        if (p === null) { showResult(['やめました'], ''); return; }
        if (!(await firstBackupIfNeeded())) { showResult(['やめました'], ''); return; }
        progStep('鍵を作っています');
        manifest = await createSpace(p);
        keys = await getKeys();
      } else {
        const m = await metaGet('manifest');
        manifest = m && m.value;
        if (!manifest) throw new SyncError('同期の設定が見つかりません。「この端末を忘れる」を実行してからやり直してください');
        // 新しく作ると、ほかの端末が書き足した分は入らない（この端末の分だけの同期ファイルになる）
        const ok = await dialog({
          message: 'この端末のデータだけで、同期ファイルを新しく作ります。\nほかの端末で作った（書き足した）同期ファイルが手元にあるなら、そちらを「同期ファイルを読み込む」で読み込んでください。ほかの端末の最新の変更を取りこぼさずに済みます。',
          okLabel: '新しく作る',
        });
        if (!ok) { showResult(['やめました'], ''); return; }
        if (!(await firstBackupIfNeeded())) { showResult(['やめました'], ''); return; }
      }
      const backend = createMemoryBackend();
      await backend.write(MANIFEST_NAME, te.encode(JSON.stringify(manifest)));
      const report = await syncWith(backend, { confirmSensitive, scanAll: true, onProgress: progStep });
      await finishSync(backend, manifest, report);
    }), { title: '同期ファイルを作っています' }));

    // 「同期ファイルを読み込む」：別の端末で作った同期ファイルを取り込み、この端末の分を書き足す
    $('syncImportBtn').addEventListener('click', () => { pkgInput.value = ''; pkgInput.click(); });
    pkgInput.addEventListener('change', () => {
      const file = pkgInput.files && pkgInput.files[0];
      if (!file) return;
      run(() => withLock(async () => {
        await precheck();
        const backend = backendFromPackage(await readFileJson(file));
        let info = await inspect(backend);
        if (info.state === 'empty') throw new SyncError('同期ファイルに設定（manifest）がありません');
        if (info.state === 'otherSpace') {
          const ok = await dialog({ message: 'この端末は、別のパスフレーズで作った同期を使っています。この同期ファイルの同期に切り替えますか？\n（この端末のデータは消えません。切り替えた後は、この端末のデータと同期ファイルのデータを合流させます）', okLabel: '切り替える', danger: true });
          if (!ok) { showResult(['やめました'], ''); return; }
          await forgetDevice();
          info = await inspect(backend);
        }
        if (info.state === 'needsPassphrase') {
          const p = await dialog({
            message: '同期のパスフレーズを入力してください（同期ファイルを作った端末で決めたもの）',
            pass: 1, okLabel: '開く',
            validate: async (pp) => {
              try { dlgErr.textContent = '確認しています…'; await unlock(info.manifest, pp); return ''; } catch (err) { return err instanceof SyncError ? err.message : '確認に失敗しました'; }
            },
          });
          if (p === null) { showResult(['やめました'], ''); return; }
        }
        if (!(await firstBackupIfNeeded())) { showResult(['やめました'], ''); return; }
        const report = await syncWith(backend, { confirmSensitive, scanAll: true, onProgress: progStep });
        await finishSync(backend, info.manifest, report);
      }), { title: '同期ファイルを読み込んでいます' });
    });

    deviceNameInput.addEventListener('change', async () => {
      const dev = await getDevice();
      const name = deviceNameInput.value.trim().slice(0, 40);
      if (!name) { deviceNameInput.value = dev.name; return; }
      dev.name = name;
      await metaPut(dev);
    });

    $('syncBackupBtn').addEventListener('click', () => run(async () => {
      downloadBlob(await buildBackup(), `sideops-backup-${stamp()}.json`);
      showResult(['全データのバックアップを保存しました。暗号化されていないので、安全な場所に保管してください'], 'ok');
    }, { title: 'バックアップを作っています' }));
    $('syncRestoreBtn').addEventListener('click', () => { backupInput.value = ''; backupInput.click(); });
    backupInput.addEventListener('change', () => {
      const file = backupInput.files && backupInput.files[0];
      if (!file) return;
      run(() => withLock(async () => {
        await precheck();
        const obj = await readFileJson(file);
        const summary = parseBackup(obj);
        const when = obj.exportedAt ? new Date(obj.exportedAt).toLocaleString('ja-JP') : '不明';
        const ok = await dialog({
          message: `バックアップ（${when}）で、次のデータを置き換えます。今のデータは消えます。\n` + summary.map((s) => `・${s.label}：${s.count}件`).join('\n')
            + '\n同期を使っている場合、次に同期したときに、この内容がほかの端末にも広がります。',
          okLabel: '置き換える', danger: true,
        });
        if (!ok) { showResult(['やめました'], ''); return; }
        const done = await restoreBackup(obj);
        needReload = true;
        showResult(['復元しました（この端末に保存済み）。画面の表示を最新にするため、閉じると再読み込みします', ...done], 'ok');
        appendButton(RELOAD_BUTTON, () => location.reload(), 'primary');
      }), { title: 'バックアップから復元しています' });
    });
    $('syncConflictsBtn').addEventListener('click', () => run(async () => {
      const n = await countConflicts();
      if (!n) { showResult(['競合の控えはありません'], ''); return; }
      downloadBlob(await exportConflicts(), `sideops-conflicts-${stamp()}.json`);
      showResult([`競合の控え${n}件を書き出しました（暗号化されていません）`], 'ok');
    }, { title: '競合の控えを書き出しています' }));
    $('syncForgetBtn').addEventListener('click', () => run(() => withLock(async () => {
      const ok = await dialog({ message: 'この端末の同期を解除します。覚えている鍵と同期の状態、クラウドへの接続とログイン、同期の記録を消します（アプリのデータは消えません）。\nもう一度同期するときは、パスフレーズの入力が必要です。', okLabel: '解除する', danger: true });
      if (!ok) { showResult(['やめました'], ''); return; }
      for (const p of providerList) { try { await p.signOut(); } catch (err) { /* メモリのトークンは次の読み込みで消える */ } }
      await forgetDevice();
      showResult(['この端末の同期を解除しました'], 'ok');
      await refresh();
    }), { title: 'この端末を忘れる' }));
  }

  // 動作確認・開発用（同じオリジンのスクリプトは元々すべてのDBを読めるので、新たな危険は増えない）
  window.SideOpsSync = {
    SYNC_APP_BUILD, FORMAT_VERSION, DB_RULES, MANIFEST_NAME, SyncError, saveSecret, loadSecret, deleteSecret,
    createMemoryBackend, backendFromPackage, packageBlob, inspect, unlock, createSpace, syncWith,
    forgetDevice, buildBackup, restoreBackup, countConflicts, getDevice, localDbVersions,
    unsentDbs, readDirtyMarks, listJournal, undoJournal, checkRemote, listConflicts, diffSeq,
    get lastReport() { return lastReport; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi);
  else initUi();
})();
