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
  const SYNC_APP_BUILD = 2026100501;
  const FORMAT_VERSION = 1;
  const SYNC_DB_NAME = 'sideops_sync';
  const SYNC_DB_VERSION = 1;
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
  const AUTO_INTERVAL_MS = 5 * 60 * 1000;         // ログイン中の自動の同期の間隔
  const AUTO_MIN_GAP_MS = 60 * 1000;              // 画面に戻ったとき、前回の自動の同期からこれ以上たっていれば取り込む
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
  ];
  const RULE_BY_NAME = new Map(DB_RULES.map((r) => [r.name, r]));

  class SyncError extends Error {}

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
      const bytes = new Uint8Array(await v.arrayBuffer());
      const h = await ctx.hash(bytes);
      ctx.blobs.set(h, bytes);
      const m = { $sideopsBlob: h, type: v.type || '', size: bytes.length };
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
  async function scanDb(rule, db, hash) {
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
        [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
      }
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!validKey(key)) { skipped++; continue; }
        const raw = project(rule, storeName, key, values[i], os.keyPath);
        const ctx = { hash, blobs: new Map() };
        let encoded;
        try { encoded = await encodeValue(raw, ctx); } catch (err) {
          skipped++;
          console.warn('同期できないレコードを飛ばしました', rule.name, storeName, key, err);
          continue;
        }
        ctx.blobs.forEach((b, h) => blobs.set(h, b));
        recs.set(rid(rule.name, storeName, key), { store: storeName, key, raw, encoded, fp: await fingerprint(encoded) });
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
    const bytes = await backend.read(MANIFEST_NAME);
    if (!bytes) return null;
    let m;
    try { m = JSON.parse(td.decode(bytes)); } catch (err) { throw new SyncError('同期ファイルの設定（manifest）が壊れています'); }
    return validateManifest(m);
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
    const tx = d.transaction(['meta', 'records', 'conflicts'], 'readwrite');
    ['keys', 'manifest', 'clock', 'dbs', 'status', 'device', 'cloud', 'written', ...secretKeys].forEach((k) => tx.objectStore('meta').delete(k));
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

  // hooks.confirmSensitive(rule) → Promise<boolean>（顧客データを初めて送る前の確認）
  // 戻り値：{ results: [{ db, label, pulled, removed, pushed, conflicts, note }], applied, conflicts }
  async function syncWith(backend, hooks = {}) {
    const keys = await getKeys();
    if (!keys) throw new SyncError('この端末はまだ同期の鍵を持っていません');
    const manifest = await readManifest(backend);
    if (!manifest) throw new SyncError('同期ファイルに設定（manifest）がありません');
    if (manifest.spaceId !== keys.spaceId || manifest.keyId !== keys.keyId) throw new SyncError('この端末は別の同期を使っています');
    const spaceId = manifest.spaceId;
    const dev = await getDevice();
    const prefs = await getPrefs();
    const clock = createClock(await metaGet('clock'), dev.id);
    const dbsMeta = (await metaGet('dbs')) || { key: 'dbs', synced: {} };
    const names = fileNames(keys);
    const hash = (bytes) => hmacHex(keys.nameKey, bytes);
    const report = { results: [], applied: false, conflicts: 0 };

    // クラウドでは、中身が前回書いたときと同じファイルは書き直さない（通信を減らす）。
    // 前回書いた時点の「中身の要約」と「保存先での更新時刻・大きさ」の両方が一致するときだけ省く。
    // 同期ファイル（手で運ぶ形）は、古いファイルを読み込み直した場合に備えて、毎回すべて書く
    let written = null;
    if (backend.kind !== 'file' && typeof backend.stamp === 'function') {
      const w = await metaGet('written');
      written = w && w.spaceId === spaceId && w.kind === backend.kind && isPlainObject(w.files) ? w : { key: 'written', spaceId, kind: backend.kind, files: {} };
    }
    async function writeIfChanged(name, obj) {
      const rest = { ...obj };
      delete rest.writtenAt;
      const digest = written ? await sha256Hex(te.encode(canonical(rest))) : '';
      const prev = written && written.files[name];
      if (prev && prev.digest === digest && prev.stamp === backend.stamp(name)) return false;
      await writeJsonFile(backend, keys, spaceId, name, obj);
      if (written) written.files[name] = { digest, stamp: backend.stamp(name) };
      return true;
    }

    // ---- 他の端末のファイルを読む（検査を通るまで、何も書き換えない） ----
    const listed = new Set(await backend.list());
    const remoteDevices = [];
    let ownPrev = null;
    for (const name of listed) {
      if (!name.startsWith('d_')) continue;
      const info = await readJsonFile(backend, keys, spaceId, name);
      if (!isPlainObject(info) || info.format !== 'sideops-sync-device' || !DEVICE_ID_RE.test(info.device) || !isPlainObject(info.dbs)) {
        throw new SyncError('同期ファイルの中身が壊れています（端末の情報）');
      }
      if (name !== await names.device(info.device)) throw new SyncError('同期ファイルの中身が壊れています（端末の情報の名前が合いません）');
      if (typeof info.formatVersion !== 'number' || info.formatVersion > FORMAT_VERSION
        || (typeof info.appBuild === 'number' && info.appBuild > SYNC_APP_BUILD)) {
        throw new SyncError(`「${String(info.deviceName || '別の端末').slice(0, 40)}」が新しい版のSIDE-OPSで書いたデータがあります。SIDE-OPSを再読み込みして更新してから、もう一度同期してください`);
      }
      if (info.device === dev.id) { ownPrev = info; continue; }
      remoteDevices.push(info);
    }

    // 他の端末のDBのファイルを先にすべて読む（この端末で同期しないDBの分も読む：
    // それらが参照している画像を、片付けの対象から外すため）
    const referenced = new Set();
    const remoteFiles = new Map(); // DB名 → [{ info, file }]
    for (const info of remoteDevices) {
      for (const [dbName, ref] of Object.entries(info.dbs)) {
        const expected = await names.db(info.device, dbName);
        if (!isPlainObject(ref) || ref.file !== expected) throw new SyncError('同期ファイルの中身が壊れています（DBのファイル名が合いません）');
        const f = await readJsonFile(backend, keys, spaceId, expected);
        if (!f) continue; // 端末の情報だけ残ってファイルがない（書き込み途中で止まった等）→ その端末のこのDBは無視
        if (!isPlainObject(f) || f.format !== 'sideops-sync-db' || f.db !== dbName || f.device !== info.device
          || !Number.isInteger(f.dbVersion) || !validSchema(f.schema) || !isPlainObject(f.stores)) {
          throw new SyncError('同期ファイルの中身が壊れています（' + ruleLabel(dbName) + '）');
        }
        if (Array.isArray(f.blobs)) f.blobs.forEach((h) => { if (typeof h === 'string') referenced.add(h); });
        if (!remoteFiles.has(dbName)) remoteFiles.set(dbName, []);
        remoteFiles.get(dbName).push({ info, file: f });
      }
    }

    const localVersions = await localDbVersions();
    const ownDbs = {};
    const d = await syncDb();

    for (const rule of DB_RULES) {
      const res = {
        db: rule.name, label: rule.label, pulled: 0, removed: 0, pushed: 0, conflicts: 0, note: '',
        inAdd: 0, inChange: 0, inDel: 0, outAdd: 0, outChange: 0, outDel: 0,
      };
      report.results.push(res);
      const keepPrev = () => { if (ownPrev && ownPrev.dbs[rule.name]) ownDbs[rule.name] = ownPrev.dbs[rule.name]; };
      if (prefs.disabled[rule.name]) { res.note = '同期しない設定'; continue; }
      const remotes = remoteFiles.get(rule.name) || [];

      let localVersion = localVersions.get(rule.name);
      if (localVersion !== undefined && localVersion > rule.version) {
        res.note = 'この版のSIDE-OPSが知らないDBの版です（同期の設定の更新漏れ）。同期しません';
        keepPrev();
        continue;
      }
      // DBの版が違う端末のデータは合流しない（移行前の形のデータで上書きしないため）
      const usable = [];
      for (const r of remotes) {
        if (localVersion === undefined ? r.file.dbVersion === rule.version : r.file.dbVersion === localVersion) usable.push(r);
        else {
          res.note = `「${String(r.info.deviceName || '別の端末').slice(0, 40)}」とDBの版が違うため、その端末の分は取り込みませんでした（古い方の端末で${rule.label}を一度開いてから同期してください）`;
        }
      }
      if (localVersion === undefined && !usable.length) { keepPrev(); continue; } // この端末にもなく、取り込めるデータもない

      // 顧客データ（RECON）は、初めて同期する前に1回確認する（送る側でも受け取る側でも）
      if (rule.sensitive && !prefs.sensitiveOk[rule.name]) {
        if (!hooks.confirmSensitive) {
          // 自動の同期では確認を出せないので、今回は飛ばす（同期しない設定にはしない）
          res.note = '確認待ち（☁から同期すると確認が出ます）';
          keepPrev();
          continue;
        }
        const ok = await hooks.confirmSensitive(rule);
        if (!ok) {
          prefs.disabled[rule.name] = true;
          await metaPut(prefs);
          res.note = '送らないことを選んだため、同期しない設定にしました';
          continue;
        }
        prefs.sensitiveOk[rule.name] = true;
        await metaPut(prefs);
      }

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
        const firstTime = !dbsMeta.synced[rule.name];
        const stList = await reqP(d.transaction('records').objectStore('records').index('db').getAll(rule.name));
        const st = new Map(stList.map((s) => [s.id, s]));
        stList.forEach((s) => { if (typeof s.ver === 'string' && VER_RE.test(s.ver)) clock.observe(s.ver); });
        // ---- 他の端末の最新の版を集める ----
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
        let scan = await scanDb(rule, db, hash);
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
        const losers = [];       // { side, id, store, key, loserVer, winnerVer, raw | encoded }
        for (const [id, r] of best) {
          const s = st.get(id);
          if (s && r.ver === s.ver) continue;
          // 中身がまったく同じなら、書き直さずに版だけ揃える（受け取り・送り出しにも数えない）。
          // 両方の端末で別々に同期を始めた後の合流などで、同じデータを受け取り直さないため
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
              if (c) losers.push({ side: 'local', id, store: s.store, key: s.key, loserVer: s.ver, winnerVer: r.ver, raw: c.raw });
            }
            if (r.deleted) { if (!s.deleted) plan.push({ op: 'del', id, store: r.store, key: r.key }); }
            else plan.push({ op: 'put', id, store: r.store, key: r.key, value: r.value });
            Object.assign(s, { ver: r.ver, deleted: r.deleted, dirty: false, baseVer: null, fp: null });
          } else if (s.dirty && !r.deleted && (s.baseVer === null || r.ver > s.baseVer)
            && (s.deleted || await fingerprint(r.value) !== s.fp)) {
            // こちらの変更が勝ったが、相手もその間に変えていた → 相手の版を控える
            losers.push({ side: 'remote', id, store: r.store, key: r.key, loserVer: r.ver, winnerVer: s.ver, encoded: r.value });
          }
        }

        // ---- 必要な画像を集めて検証する ----
        const need = new Set();
        plan.forEach((p) => { if (p.op === 'put') blobRefs(p.value, need); });
        losers.forEach((l) => { if (l.encoded) blobRefs(l.encoded, need); });
        const fetched = new Map();
        for (const h of need) {
          if (!HASH_RE.test(h)) throw new SyncError('同期ファイルの中身が壊れています（画像の参照）');
          if (scan.blobs.has(h)) { fetched.set(h, scan.blobs.get(h)); continue; }
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

        // ---- 反映（1トランザクション。失敗したら何も変わらない） ----
        if (plan.length) {
          const storeNames = [...new Set(plan.map((p) => p.store))];
          const keyPaths = readSchema(db, storeNames);
          // only 指定のレコードは、端末ごとの項目を残したまま同期する項目だけを書き換える
          const existing = new Map();
          if (rule.only) {
            const rtx = db.transaction(storeNames);
            for (const p of plan) existing.set(p.id, await reqP(rtx.objectStore(p.store).get(p.key)));
          }
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
          const wtx = db.transaction(storeNames, 'readwrite');
          const done = txDone(wtx);
          try {
            for (const p of prepared) {
              const os = wtx.objectStore(p.store);
              if (p.op === 'del') {
                if (rule.only) {
                  const fields = rule.only[p.store][p.key];
                  const cur = existing.get(p.id);
                  if (isPlainObject(cur)) { const v = { ...cur }; fields.forEach((f) => delete v[f]); os.put(v); }
                } else os.delete(p.key);
              } else if (p.kp === null) os.put(p.value, p.key);
              else os.put(p.value);
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
          // 反映後の中身で指紋を取り直す（次回、反映した分を「この端末の変更」と誤認しないように）
          scan = await scanDb(rule, db, hash);
          for (const p of plan) {
            const s = st.get(p.id);
            const c = scan.recs.get(p.id);
            if (s && c) s.fp = c.fp;
          }
        }

        // ---- 自分のファイルを書く：画像 → DBのファイル（端末の情報は最後にまとめて） ----
        // 並び順はキーの順に固定する（中身が同じなら、ファイルも同じになるように。
        // 並びが毎回変わると、変わっていないファイルを書き直してしまう）
        const outStores = {};
        scan.stores.forEach((n) => { outStores[n] = []; });
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
        for (const h of usedBlobs) {
          referenced.add(h);
          const name = names.blob(h);
          if (listed.has(name)) continue;
          const bytes = scan.blobs.get(h);
          if (!bytes) throw new SyncError(rule.label + ' の画像を読めませんでした');
          await backend.write(name, await seal(keys.encKey, bytes, 'sideops-sync|' + spaceId + '|' + name));
          listed.add(name);
        }
        const dbFile = await names.db(dev.id, rule.name);
        await writeIfChanged(dbFile, {
          format: 'sideops-sync-db', formatVersion: FORMAT_VERSION, db: rule.name, dbVersion: db.version,
          schema: scan.schema, appBuild: SYNC_APP_BUILD, device: dev.id, writtenAt: new Date().toISOString(),
          blobs: Array.from(usedBlobs).sort(), stores: outStores,
        });
        listed.add(dbFile);
        ownDbs[rule.name] = { file: dbFile, dbVersion: db.version, count: scan.recs.size };
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

        // ---- 状態を保存：送り終えたので、すべて「送信済み」にする ----
        const now = Date.now();
        const wtx2 = d.transaction(['records', 'conflicts'], 'readwrite');
        const recOs = wtx2.objectStore('records');
        for (const s of st.values()) { s.dirty = false; s.baseVer = null; recOs.put(s); }
        for (const l of losers) {
          let value = l.raw;
          if (l.encoded) value = decodeValue(l.encoded, bytesOf);
          wtx2.objectStore('conflicts').put({ id: randomHex(8), at: now, db: rule.name, store: l.store, key: l.key, side: l.side, loserVer: l.loserVer, winnerVer: l.winnerVer, value });
        }
        await txDone(wtx2);
        res.conflicts = losers.length;
        report.conflicts += losers.length;
        dbsMeta.synced[rule.name] = true;
      } finally {
        db.close();
      }
    }

    // ---- 端末の情報（どのDBのファイルを持っているか）を最後に書く ----
    const devFile = await names.device(dev.id);
    await writeIfChanged(devFile, {
      format: 'sideops-sync-device', formatVersion: FORMAT_VERSION, device: dev.id, deviceName: dev.name,
      appBuild: SYNC_APP_BUILD, writtenAt: new Date().toISOString(), dbs: ownDbs,
    });
    // 使わなくなった自分のDBファイル（同期しない設定にしたDB等）を消す
    if (ownPrev) {
      for (const [n, ref] of Object.entries(ownPrev.dbs)) {
        if (!ownDbs[n] && ref && typeof ref.file === 'string' && listed.has(ref.file)) await backend.remove(ref.file);
      }
    }
    // どこからも参照されない画像を片付ける。同期ファイル（手で運ぶ形）ではその場で消す。
    // クラウドでは、ほかの端末が書き込みの途中（画像を置いた後、DBのファイルを書く前）の
    // 可能性があるため、最後に書き換えられてから一定期間たったものだけを消す
    for (const n of await backend.list()) {
      if (!n.startsWith('x_') || referenced.has(n.slice(2, -4))) continue;
      if (backend.kind === 'file' || (typeof backend.ageMs === 'function' && backend.ageMs(n) > BLOB_GRACE_MS)) await backend.remove(n);
    }
    if (written) await metaPut(written);

    await metaPut(clock.save());
    await metaPut(dbsMeta);
    await metaPut({ key: 'status', lastSyncAt: Date.now(), lastSyncKind: backend.kind });
    await purgeConflicts();
    await addLog('sync', summarizeReport(report).join(' / ') || '変更なし');
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
    for (const c of list) rows.push({ ...c, value: await encodeValue(c.value, { hash: sha256Hex, blobs }) });
    const out = { format: 'sideops-sync-conflicts', exportedAt: new Date().toISOString(), conflicts: rows, blobs: {} };
    blobs.forEach((b, h) => { out.blobs[h] = bytesToB64(b); });
    return new Blob([JSON.stringify(out)], { type: 'application/json' });
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
    if (!(await waitStageIdle())) throw new SyncError('開いているアプリを閉じてから同期してください');
    if (await otherTabsOpen()) throw new SyncError('SIDE-OPSを開いている他のタブ（ウィンドウ）を閉じてから同期してください');
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
    const deviceNameInput = $('syncDeviceName');
    const pkgInput = $('syncPackageInput');
    const backupInput = $('syncBackupInput');
    let needReload = false;
    let lastPackage = null;

    openBtn.disabled = false;
    openBtn.title = '同期（複数の端末でデータを使う）';

    function setBusy(b) {
      overlay.querySelectorAll('[data-sync-action]').forEach((el) => { el.disabled = b; });
      overlay.classList.toggle('is-busy', b);
      if (!b) { applyCloudAvailability(); refreshCloud(); }
    }
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

    async function refresh() {
      try {
        const dev = await getDevice();
        const keys = await getKeys();
        const status = await metaGet('status');
        const prefs = await getPrefs();
        const conflicts = await countConflicts();
        deviceNameInput.value = dev.name;
        const lines = [];
        lines.push(keys ? `同期の鍵：あり（ID ${keys.keyId.slice(0, 8)}）` : '同期の鍵：なし（まだ同期していません）');
        lines.push('最後の同期：' + (status && status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ja-JP') : 'なし'));
        if (conflicts) lines.push(`競合の控え：${conflicts}件（30日で自動的に消えます）`);
        statusEl.textContent = lines.join('\n');
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
      if (c.connected && providers[c.provider] && providers[c.provider].configured()) run(cloudSyncFlow);
    }
    function close() {
      if (overlay.classList.contains('is-busy')) return;
      overlay.classList.remove('is-open');
      if (needReload) location.reload(); // 取り込んだ変更を画面に反映する（古いデータのまま保存し直さないように）
    }
    openBtn.addEventListener('click', () => open());
    $('syncCloseBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('is-open') && !$('syncDialog').classList.contains('is-open')) close(); });

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
    function dialog({ message, pass = 0, okLabel = 'OK', danger = false, validate }) {
      return new Promise((resolve) => {
        const my = ++dialogSeq;
        let validating = false;
        dlgMsg.textContent = message;
        dlgErr.textContent = '';
        dlgPass.value = ''; dlgPass2.value = '';
        dlgPass.hidden = pass < 1; dlgPass2.hidden = pass < 2;
        dlgOk.textContent = okLabel;
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
    const CONFLICT_LINE = (n) => `両方の端末で変えていたデータが${n}件ありました。新しい方を採用し、もう一方は「競合の控え」に残しました（「競合の控えを書き出す」で確かめられます）`;
    const RELOAD_LINE = '受け取ったデータは、この端末に保存済みです。画面の表示を最新にするため、閉じると再読み込みします';
    const RELOAD_BUTTON = '今すぐ画面を最新にする';

    async function finishSync(backend, manifest, report) {
      lastPackage = { blob: packageBlob(backend, manifest.spaceId), name: `sideops-sync-${stamp()}.json` };
      downloadBlob(lastPackage.blob, lastPackage.name);
      const lines = ['同期しました。新しい同期ファイルを保存しました（' + lastPackage.name + '）。', ...reportLines(report)];
      if (report.conflicts) lines.push(CONFLICT_LINE(report.conflicts));
      if (report.applied) {
        needReload = true;
        lines.push(RELOAD_LINE);
      }
      showResult(lines, 'ok');
      appendButton('同期ファイルをもう一度保存', () => downloadBlob(lastPackage.blob, lastPackage.name));
      if (report.applied) appendButton(RELOAD_BUTTON, () => location.reload(), 'primary');
      await refresh();
    }

    const userFacing = (err) => err instanceof SyncError || !!(err && err.userFacing);
    async function run(task) {
      setBusy(true);
      showResult(['処理中です…'], '');
      try {
        await task();
      } catch (err) {
        if (userFacing(err)) console.warn('同期を中止しました：' + err.message); // 想定内（利用者に理由を表示する）
        else console.error(err);
        showResult([userFacing(err) ? err.message : '同期に失敗しました：' + (err && err.message)], 'error');
        if (!userFacing(err)) addLog('error', err && err.stack ? err.stack : String(err));
      } finally {
        setBusy(false);
        updateIndicator();
      }
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

    // ☁ボタンの印：同期済み（cyan）／ログインが必要・しばらく同期していない（amber）／失敗（magenta）／同期中
    let indicatorError = false;
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
        const last = status && status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ja-JP') : 'なし';
        const stale = status && status.lastSyncAt && Date.now() - status.lastSyncAt > STALE_SYNC_MS;
        if (state === 'busy') { cls = 'sync-busy'; title = '同期しています…'; }
        else if (indicatorError) { cls = 'sync-error'; title = '前回の同期に失敗しました（押して確認）'; }
        else if (p && login === 'login') { cls = 'sync-warn'; title = `${p.label}のログインが必要です（押すと同期します）`; }
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
    async function cloudSyncFlow() {
      const p = await currentProvider();
      if (!p || !p.configured()) throw new SyncError('クラウドの設定（アプリの登録）がまだありません');
      if (p.loginLeavesPage) {
        // ログインでページを離れる方式（OneDrive）：離れる前に、アプリやほかのタブを閉じているか確かめる
        await precheck();
        showResult([`${p.label}を確認しています…`], '');
        if (!(await p.ensureToken({ interactive: false }))) {
          showResult([`${p.label}のログイン画面へ移ります。ログインすると、戻ってきて同期の続きをします…`], '');
          await p.ensureToken({ interactive: true }); // ページを離れる
          return;
        }
      } else if (!(await p.ensureToken({ interactive: false }))) {
        // ポップアップでログインする方式（Googleドライブ）：押した直後に開く必要があるので、先にログインする
        showResult([`${p.label}にログインしています…`], '');
        await p.ensureToken({ interactive: true });
      }
      await withLock(async () => {
        await precheck();
        showResult([`${p.label}を確認しています…`], '');
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
            showResult(['鍵を作っています…'], '');
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
        showResult(['同期しています…'], '');
        const report = await syncWith(backend, { confirmSensitive });
        await metaPut({ ...(await cloudMeta()), provider: p.id, connected: true });
        await p.persist(); // 鍵ができた後に、更新用トークンを暗号化して保存する（OneDrive）
        lastAuto = Date.now();
        const lines = [`${p.label}と同期しました。`, ...reportLines(report)];
        if (report.conflicts) lines.push(CONFLICT_LINE(report.conflicts));
        if (report.applied) { needReload = true; lines.push(RELOAD_LINE); }
        showResult(lines, 'ok');
        if (report.applied) appendButton(RELOAD_BUTTON, () => location.reload(), 'primary');
        updateIndicator('ok');
        await refresh();
      });
    }
    if (cloudBtn) cloudBtn.addEventListener('click', () => run(cloudSyncFlow));
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
    }));
    if (cloudAuto) cloudAuto.addEventListener('change', async () => {
      const c = await cloudMeta();
      await metaPut({ ...c, auto: cloudAuto.checked });
    });

    // ---- 自動の同期：ログイン中だけ。確認が必要な場面（パスフレーズ・顧客データ）では何もしない ----
    let lastAuto = 0;
    let autoRunning = false;
    let reloadPending = false;
    function otherModalOpen() {
      return !!document.querySelector('.settings-overlay.is-open, .launcher-modal-overlay.is-open, .launcher-confirm-overlay.is-open');
    }
    function scheduleReload() {
      if (reloadPending) return;
      reloadPending = true;
      showToast('ほかの端末の変更を受け取りました（保存済み）。画面の表示を最新にするため、再読み込みします');
      const tryReload = () => {
        if (!stageBusy() && !otherModalOpen()) location.reload();
        else setTimeout(tryReload, 2000);
      };
      setTimeout(tryReload, 2500);
    }
    async function autoSync() {
      if (autoRunning || reloadPending) return;
      const c = await cloudMeta();
      const p = c.connected ? providers[c.provider] : null;
      if (!p || !p.configured() || !c.auto) return;
      if (stageBusy() || otherModalOpen()) return; // アプリや設定を開いている間は後回し
      autoRunning = true;
      try {
        if (!(await p.ensureToken({ interactive: false }))) { updateIndicator(); return; } // 自動ではログインし直さない
        if (await otherTabsOpen()) return;
        updateIndicator('busy');
        const report = await withLock(async () => {
          const backend = p.createBackend();
          const info = await inspect(backend);
          if (info.state !== 'ready') throw new SyncError(`${p.label}の同期を確認してください（☁から同期してください）`);
          return syncWith(backend, {});
        });
        await p.persist();
        lastAuto = Date.now();
        updateIndicator('ok');
        if (report.applied) scheduleReload();
      } catch (err) {
        if (userFacing(err)) console.warn('自動の同期を中止しました：' + err.message);
        else { console.error(err); addLog('error', err && err.stack ? err.stack : String(err)); }
        const loginLost = err && err.code === 'login';
        updateIndicator(loginLost ? undefined : 'error');
      } finally {
        autoRunning = false;
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') autoSync();                 // 画面を離れるとき：送り出す
      else if (Date.now() - lastAuto > AUTO_MIN_GAP_MS) autoSync();          // 戻ったとき：取り込む
      else updateIndicator();
    });
    const stageEl = document.getElementById('stageEl');
    if (stageEl) {
      let wasOpen = stageEl.classList.contains('is-open');
      new MutationObserver(() => {
        const nowOpen = stageEl.classList.contains('is-open');
        if (wasOpen && !nowOpen) setTimeout(autoSync, STAGE_RETIRE_WAIT_MS + 500); // アプリを閉じたら、保存し終えるのを待って送る
        wasOpen = nowOpen;
      }).observe(stageEl, { attributes: true, attributeFilter: ['class'] });
    }
    setInterval(() => { if (document.visibilityState === 'visible') autoSync(); else updateIndicator(); }, AUTO_INTERVAL_MS);

    function showToast(text) {
      let el = document.getElementById('syncToast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'syncToast';
        el.className = 'sync-toast';
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.classList.add('show');
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => el.classList.remove('show'), 4000);
    }

    // ログイン（ページを離れる方式）から戻ったとき：結果を表示し、同期の続きをする
    (async () => {
      for (const p of providerList) {
        let r = null;
        try { r = await p.redirectResult; } catch (err) { r = { error: 'ログインに失敗しました' }; }
        if (!r) continue;
        const resume = p.resumeKey && sessionStorage.getItem(p.resumeKey) === p.id;
        if (p.resumeKey) sessionStorage.removeItem(p.resumeKey);
        buildProviderOptions();
        if (cloudSel && !(await cloudMeta()).connected) cloudSel.value = p.id;
        await open({ autoSync: false });
        if (r.error) { showResult([r.error], 'error'); continue; }
        if (resume) run(cloudSyncFlow);
      }
    })();
    applyCloudAvailability();
    updateIndicator();

    // 「同期ファイルを作る」：この端末のデータから同期ファイルを作る（初回はパスフレーズを決める）
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
        showResult(['鍵を作っています…'], '');
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
      const report = await syncWith(backend, { confirmSensitive });
      await finishSync(backend, manifest, report);
    })));

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
        const report = await syncWith(backend, { confirmSensitive });
        await finishSync(backend, info.manifest, report);
      }));
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
    }));
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
      }));
    });
    $('syncConflictsBtn').addEventListener('click', () => run(async () => {
      const n = await countConflicts();
      if (!n) { showResult(['競合の控えはありません'], ''); return; }
      downloadBlob(await exportConflicts(), `sideops-conflicts-${stamp()}.json`);
      showResult([`競合の控え${n}件を書き出しました（暗号化されていません）`], 'ok');
    }));
    $('syncForgetBtn').addEventListener('click', () => run(() => withLock(async () => {
      const ok = await dialog({ message: 'この端末の同期を解除します。覚えている鍵と同期の状態、クラウドへの接続とログインを消します（アプリのデータは消えません）。\nもう一度同期するときは、パスフレーズの入力が必要です。', okLabel: '解除する', danger: true });
      if (!ok) { showResult(['やめました'], ''); return; }
      for (const p of providerList) { try { await p.signOut(); } catch (err) { /* メモリのトークンは次の読み込みで消える */ } }
      await forgetDevice();
      showResult(['この端末の同期を解除しました'], 'ok');
      await refresh();
    })));
  }

  // 動作確認・開発用（同じオリジンのスクリプトは元々すべてのDBを読めるので、新たな危険は増えない）
  window.SideOpsSync = {
    SYNC_APP_BUILD, FORMAT_VERSION, DB_RULES, MANIFEST_NAME, SyncError, saveSecret, loadSecret, deleteSecret,
    createMemoryBackend, backendFromPackage, packageBlob, inspect, unlock, createSpace, syncWith,
    forgetDevice, buildBackup, restoreBackup, countConflicts, getDevice, localDbVersions,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi);
  else initUi();
})();
