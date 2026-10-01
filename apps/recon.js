/* =====================================================================
   RECON — 販売データの取込・突合（SIDE-OPS 先天的アプリ）
   ---------------------------------------------------------------------
   段階1：noteの「記事の販売履歴」CSVの取込（確認画面・検算・取消）、
          取引一覧、月別集計、ブランド管理、伏せ字モード。
   データの正本はこのアプリのDB（sideops_recon）。INTELパネルへは
   段階2で「集計済みの要約」だけを送る（個人名は送らない）。
   仕様：docs/apps/claude_アプリ_RECON_仕様書.md
===================================================================== */
(function () {
  'use strict';

  /* ===================== 定数 ===================== */
  const DB_NAME = 'sideops_recon';
  const DB_VERSION = 1;
  const S_TX = 'transactions';
  const S_IMPORTS = 'imports';
  const S_READERS = 'readers';   // 段階3（名寄せ）で使用。器だけ先に作っておく
  const S_WORKS = 'works';       // 同上
  const S_ALIASES = 'aliases';   // 同上（表記・IDの対応表）
  const S_PROFILES = 'profiles';
  const S_SETTINGS = 'settings';

  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const ALLOWED_EXT = /\.(csv|tsv|txt)$/i;
  const PAGE_SIZE = 100;
  const SAMPLE_SIZE = 20;
  const HEADER_SEARCH_ROWS = 10;
  const MAX_ISSUES_SHOWN = 50;
  const BRAND_NAME_MAX = 40;

  const PLATFORM_NOTE = 'note';
  const NOTE_PROFILE_ID = 'note';
  // noteの「記事の販売履歴」CSVの列。見出しは比較前にNFKC正規化・空白除去して照合する
  const NOTE_COLUMNS = {
    paidAt: '決済/返金日時',
    buyer: '購入者名',
    kind: '決済種別',
    payMethod: '決済方法',
    contentType: 'コンテンツ種別',
    content: 'コンテンツ名',
    price: '販売額',
    taxRate: '消費税率',
    priceExTax: '税抜販売額',
    tax: '消費税額',
    points: 'ポイント利用',
    txId: '取引ID',
    issuer: '発行事業者',
    issuerRegNo: '適格事業者登録番号',
  };
  const NOTE_REQUIRED = ['paidAt', 'buyer', 'kind', 'content', 'price', 'txId'];

  // 「ゲスト」などの共通表記。同じ表記でも別人の可能性が高いため、名寄せの自動照合に使わない（識別不能扱い）
  const GENERIC_BUYER_NAMES = ['ゲスト', 'ゲストユーザー', '退会したユーザー', '退会済みユーザー', '退会ユーザー', '名無し', '匿名', 'unknown', 'guest', '-', '―', '−'];

  const KIND_LABEL = { sale: '売上', refund: '返金', ignore: '集計しない' };
  const KIND_CHOICES = [
    { value: 'sale', label: '売上として加算' },
    { value: 'refund', label: '返金として減算' },
    { value: 'ignore', label: '集計しない' },
  ];
  const BRAND_PALETTE = ['#38d9c0', '#ff6b9a', '#ffb547', '#7aa7ff', '#b98cff', '#8ee06b'];
  const RE_HEX6 = /^#[0-9a-fA-F]{6}$/;
  const RE_DATETIME = /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;
  // 区切りなしの数字だけの日時（noteの実際のCSVは「20251113205937」＝年月日時分秒の14桁）。12桁（秒なし）・8桁（日付のみ）も受け付ける
  const RE_DATETIME_COMPACT = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/;

  /* ===================== 状態 ===================== */
  let db = null;
  let txAll = [];       // 全取引（新しい順）
  let imports = [];     // 取込の履歴（新しい順）
  let brands = [];      // [{ id, name, color, createdAt }]
  let profiles = new Map();
  let ui = { mask: false };
  let preview = null;   // 取込の確認画面の状態（null＝閉じている）
  let committing = false;
  let txShown = PAGE_SIZE;
  let brandModalFromPreview = false;
  let queryTimer = null;

  /* ===================== DOM ===================== */
  const $ = (id) => document.getElementById(id);
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const views = Array.from(document.querySelectorAll('.view'));
  const maskBtn = $('maskBtn');
  const menuBtn = $('menuBtn');
  const menuPanel = $('menuPanel');
  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  const previewEl = $('preview');
  const historyList = $('historyList');
  const toastEl = $('toast');

  /* ===================== 汎用ユーティリティ ===================== */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function nfkc(s) { return String(s == null ? '' : s).normalize('NFKC'); }
  function normKey(s) { return nfkc(s).replace(/\s+/g, ' ').trim(); }
  function normHeader(s) { return nfkc(s).replace(/\uFEFF/g, '').replace(/\s+/g, ''); }
  const GENERIC_SET = new Set(GENERIC_BUYER_NAMES.map((s) => normKey(s).toLowerCase()));

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function yen(n) {
    const v = Math.round(Number(n) || 0);
    const s = '¥' + Math.abs(v).toLocaleString('ja-JP');
    return v < 0 ? '−' + s : s;
  }
  function fmtDateTimeIso(iso) { return iso ? iso.slice(0, 16).replace('T', ' ').replace(/-/g, '/') : ''; }
  function fmtTs(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fmtYm(ym) { const p = String(ym || '').split('-'); return p.length === 2 ? `${p[0]}年${Number(p[1])}月` : String(ym || ''); }
  function fmtPeriod(from, to) {
    if (!from) return '—';
    const f = from.replace(/-/g, '/');
    if (!to || from === to) return f;
    const t = from.slice(0, 4) === to.slice(0, 4) ? to.slice(5).replace(/-/g, '/') : to.replace(/-/g, '/');
    return `${f} 〜 ${t}`;
  }
  function stamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }
  function randId(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => (b % 36).toString(36)).join('');
  }
  function shortHash(s) {
    // 伏せ字用の短い識別子（FNV-1a）。同じ人は常に同じ記号になるので、伏せたままでも見分けられる
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36).toUpperCase().padStart(4, '0').slice(-4);
  }
  function short(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const lim = n || 24;
    return t.length > lim ? t.slice(0, lim) + '…' : t;
  }

  let toastTimer = null;
  function showToast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-error', !!isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), isError ? 4200 : 2400);
  }

  /* ===================== 値の読み取り（正規化） ===================== */
  // 日時：CSVの日本時間の文字列から、年・月・日を直接切り出す（UTC変換を挟まない＝月の区切りがずれない）
  function parseDateTime(value) {
    const t = nfkc(value).trim();
    const m = RE_DATETIME.exec(t) || RE_DATETIME_COMPACT.exec(t);
    if (!m) return null;
    const Y = +m[1], M = +m[2], D = +m[3];
    const h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, s = m[6] ? +m[6] : 0;
    if (Y < 2000 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || s > 59) return null;
    const probe = new Date(Date.UTC(Y, M - 1, D));
    if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== M - 1 || probe.getUTCDate() !== D) return null; // 2/30など
    const date = `${Y}-${pad2(M)}-${pad2(D)}`;
    return { date, ym: date.slice(0, 7), iso: `${date}T${pad2(h)}:${pad2(mi)}:${pad2(s)}+09:00` };
  }

  // 金額：「¥」「,」「円」、全角数字、マイナス記号の揺れ、会計の▲△・括弧表記を吸収して数値化
  function parseAmount(value) {
    let t = nfkc(value).trim();
    if (!t) return { ok: false, empty: true };
    let neg = false;
    if (/^[▲△]/.test(t)) { neg = true; t = t.slice(1).trim(); }
    if (/^\(.*\)$/.test(t)) { neg = !neg; t = t.slice(1, -1).trim(); }
    t = t.replace(/[\u2212\u2013]/g, '-').replace(/[¥$,\s]/g, '').replace(/円$/, '');
    if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
    if (!/^\d+(?:\.\d+)?$/.test(t)) return { ok: false };
    let n = Number(t);
    if (!Number.isFinite(n)) return { ok: false };
    if (neg) n = -n;
    if (Object.is(n, -0)) n = 0;
    return { ok: true, value: n };
  }
  function parseOptionalAmount(value) {
    const r = parseAmount(value);
    return r.ok ? r.value : null;
  }

  // 購入者の状態：unmatched（名寄せ待ち）／unidentifiable（共通表記・空欄）
  // ※ anonymous（販路がそもそも購入者を出さない）は段階4の汎用取込で使う
  function buyerStatusOf(name) {
    const k = normKey(name).toLowerCase();
    if (!k || GENERIC_SET.has(k)) return 'unidentifiable';
    return 'unmatched';
  }

  // 1取引が差引に与える額。返金は符号に関係なく絶対値を引く（CSVの符号の付け方に左右されない）
  function contribution(rule, priceRaw) {
    if (rule === 'sale') return priceRaw;
    if (rule === 'refund') return -Math.abs(priceRaw);
    return 0;
  }

  function makeTxId(platform, brand, txId, kindKey) {
    return JSON.stringify([platform, brand, txId, kindKey]);
  }

  /* ===================== 文字コード・ハッシュ ===================== */
  function decodeBuffer(buf, forced) {
    const u8 = new Uint8Array(buf);
    const dec = (label, fatal) => new TextDecoder(label, { fatal: !!fatal }).decode(u8);
    if (forced) return { text: dec(forced), encoding: forced };
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return { text: dec('utf-16le'), encoding: 'utf-16le' };
    try {
      return { text: dec('utf-8', true), encoding: 'utf-8' };
    } catch (e) {
      return { text: dec('shift_jis'), encoding: 'shift_jis' };
    }
  }
  async function sha256Hex(buf) {
    if (!(window.crypto && crypto.subtle)) return null;
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ===================== IndexedDB ===================== */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB非対応')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const d = ev.target.result;
        if (!d.objectStoreNames.contains(S_TX)) {
          const s = d.createObjectStore(S_TX, { keyPath: 'id' });
          s.createIndex('importId', 'importId', { unique: false });
          s.createIndex('ptx', 'ptx', { unique: false });
          s.createIndex('ym', 'ym', { unique: false });
        }
        if (!d.objectStoreNames.contains(S_IMPORTS)) {
          const s = d.createObjectStore(S_IMPORTS, { keyPath: 'id' });
          s.createIndex('fileHash', 'fileHash', { unique: false });
        }
        [S_READERS, S_WORKS, S_ALIASES, S_PROFILES].forEach((name) => {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
        });
        if (!d.objectStoreNames.contains(S_SETTINGS)) d.createObjectStore(S_SETTINGS, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => {
          d.close();
          db = null;
          showToast('RECONのデータ構造が別のタブで更新されました。再読み込みしてください', true);
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => showToast('別のタブのRECONを閉じてから、再読み込みしてください', true);
    });
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
      tx.onabort = () => reject(tx.error || new Error('保存処理が中断されました'));
    });
  }
  function requireDb() {
    if (!db) throw new Error('DBが開いていません。再読み込みしてください');
    return db;
  }
  function getAll(store) { return reqP(requireDb().transaction(store, 'readonly').objectStore(store).getAll()); }
  function getAllKeys(store) { return reqP(requireDb().transaction(store, 'readonly').objectStore(store).getAllKeys()); }
  function putOne(store, value) {
    const tx = requireDb().transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    return txDone(tx);
  }

  function sanitizeBrands(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string').map((b) => ({
      id: b.id,
      name: b.name.slice(0, BRAND_NAME_MAX),
      color: RE_HEX6.test(b.color) ? b.color : BRAND_PALETTE[0],
      createdAt: Number(b.createdAt) || 0,
    })).sort((a, b) => a.createdAt - b.createdAt);
  }

  async function loadAll() {
    const [txs, imps, settingsRows, profs] = await Promise.all([getAll(S_TX), getAll(S_IMPORTS), getAll(S_SETTINGS), getAll(S_PROFILES)]);
    txAll = txs.sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : (a.id < b.id ? 1 : -1)));
    imports = imps.sort((a, b) => b.importedAt - a.importedAt);
    const sMap = new Map(settingsRows.map((r) => [r.key, r.value]));
    brands = sanitizeBrands(sMap.get('brands'));
    const savedUi = sMap.get('ui');
    ui = { mask: !!(savedUi && savedUi.mask) };
    profiles = new Map(profs.map((p) => [p.id, p]));
  }

  async function ensureNoteProfile() {
    const cur = await reqP(requireDb().transaction(S_PROFILES, 'readonly').objectStore(S_PROFILES).get(NOTE_PROFILE_ID));
    if (cur) return;
    const now = Date.now();
    await putOne(S_PROFILES, {
      id: NOTE_PROFILE_ID, platform: PLATFORM_NOTE, name: 'note 記事の販売履歴', builtin: true,
      kindRules: {}, createdAt: now, updatedAt: now,
    });
  }
  function noteKindRules() {
    const p = profiles.get(NOTE_PROFILE_ID);
    const rules = (p && p.kindRules) || {};
    const out = {};
    Object.keys(rules).forEach((k) => { if (KIND_LABEL[rules[k]]) out[k] = rules[k]; });
    return out;
  }

  /* ===================== ブランド ===================== */
  function brandById(id) { return brands.find((b) => b.id === id) || null; }
  function brandInUse(id) { return imports.some((i) => i.brand === id); }
  function brandChip(id) {
    const b = brandById(id);
    const chip = el('span', 'brand-chip');
    const dot = el('i', 'dot');
    if (b && RE_HEX6.test(b.color)) dot.style.background = b.color;
    chip.append(dot, el('span', '', b ? b.name : '（不明なブランド）'));
    return chip;
  }
  function validateBrandName(name, exceptId) {
    const n = String(name || '').trim();
    if (!n) return { ok: false, msg: 'ブランド名を入力してください' };
    if (n.length > BRAND_NAME_MAX) return { ok: false, msg: `ブランド名は${BRAND_NAME_MAX}文字までです` };
    const key = normKey(n).toLowerCase();
    if (brands.some((b) => b.id !== exceptId && normKey(b.name).toLowerCase() === key)) return { ok: false, msg: '同じ名前のブランドがすでにあります' };
    return { ok: true, name: n };
  }
  async function saveBrands() { await putOne(S_SETTINGS, { key: 'brands', value: brands }); }
  async function saveUi() { await putOne(S_SETTINGS, { key: 'ui', value: ui }); }

  /* ===================== 伏せ字 ===================== */
  function shownBuyer(name, status) {
    const s = String(name || '').trim();
    if (!s) return '（名前なし）';
    if (status === 'unidentifiable') return s; // 「ゲスト」等の共通表記は個人を指さない
    if (!ui.mask) return s;
    return '購入者 ' + shortHash(normKey(s));
  }
  function shownIssuer(name) {
    const s = String(name || '').trim();
    if (!s) return '（空欄）';
    return ui.mask ? '●●●（伏せ字）' : s;
  }

  /* ===================== CSVの解析（確認画面の材料づくり） ===================== */
  function locateNoteHeader(data) {
    const limit = Math.min(data.length, HEADER_SEARCH_ROWS);
    let bestMissing = NOTE_REQUIRED.slice();
    for (let i = 0; i < limit; i++) {
      const row = data[i] || [];
      const normed = row.map(normHeader);
      const map = {};
      Object.keys(NOTE_COLUMNS).forEach((field) => {
        const idx = normed.indexOf(normHeader(NOTE_COLUMNS[field]));
        if (idx !== -1) map[field] = idx;
      });
      const missing = NOTE_REQUIRED.filter((f) => map[f] === undefined);
      if (missing.length === 0) {
        const known = new Set(Object.values(NOTE_COLUMNS).map(normHeader));
        const unknown = row.map((h) => String(h == null ? '' : h).replace(/\uFEFF/g, '').trim())
          .filter((h) => h && !known.has(normHeader(h)));
        const headers = row.map((h) => String(h == null ? '' : h).replace(/\uFEFF/g, '').trim());
        return { index: i, map, headers, unknown, missing: [] };
      }
      if (missing.length < bestMissing.length) bestMissing = missing;
    }
    return { index: -1, missing: bestMissing };
  }

  function buildPreview(fileMeta, buf, hash, forcedEncoding, carry) {
    const decoded = decodeBuffer(buf, forcedEncoding);
    const pv = {
      file: fileMeta, buf, hash, encoding: decoded.encoding,
      fatal: [], info: [], headers: [], rows: [], kinds: [], issuers: [],
      period: { from: '', to: '' },
      brandId: carry ? carry.brandId : '',
      kindChoices: {}, excludeErrors: false, crossConfirmed: false,
      // 管理画面との照合：月（YYYY-MM）→ 入力された金額の文字列。文字コードを切り替えても引き継ぐ
      reconInputs: carry && carry.reconInputs ? Object.assign({}, carry.reconInputs) : {}, reconConfirmed: false,
      keyIndex: carry ? carry.keyIndex : null,
      sameFile: null, totals: null, blockers: [],
    };

    const parsed = Papa.parse(decoded.text, { skipEmptyLines: 'greedy', delimitersToGuess: [',', '\t', ';'] });
    const data = parsed.data || [];
    if (!data.length) { pv.fatal.push('ファイルにデータがありません。'); return pv; }

    const head = locateNoteHeader(data);
    if (head.index === -1) {
      const miss = head.missing.map((f) => `「${NOTE_COLUMNS[f]}」`).join('');
      pv.fatal.push(`noteの「記事の販売履歴」CSVの形式と一致しません。\n見つからない列：${miss}\n文字化けしている場合は、文字コードを切り替えてみてください。`);
      return pv;
    }
    pv.headers = head.headers;
    if (head.index > 0) pv.info.push(`見出しは${head.index + 1}行目にありました（それより上の行は読み飛ばしました）。`);
    if (head.unknown.length) pv.info.push(`見慣れない列があります：${head.unknown.map((h) => `「${h}」`).join('')}（取込には使いません。列が増えただけなら問題ありません）`);

    // Papa Parseが検出した引用符の崩れ（行番号つき）
    const quoteErrRows = new Set();
    (parsed.errors || []).forEach((e) => { if (typeof e.row === 'number' && e.type === 'Quotes') quoteErrRows.add(e.row); });

    const maxRequiredIdx = Math.max.apply(null, NOTE_REQUIRED.map((f) => head.map[f]));
    const seenInFile = new Map(); // `${txId}\u0000${kindKey}` → 最初の行番号
    const kindAgg = new Map();
    const issuerSet = new Map();

    for (let i = head.index + 1; i < data.length; i++) {
      const cells = data[i] || [];
      const no = i - head.index; // データの何件目か（見出しを除く）
      const get = (f) => (head.map[f] === undefined ? '' : (cells[head.map[f]] == null ? '' : String(cells[head.map[f]])));
      const errs = [];
      if (quoteErrRows.has(i)) errs.push('引用符（"）の対応が崩れています');
      if (cells.length <= maxRequiredIdx) errs.push('列が足りません（区切りが崩れている可能性）');

      const txId = normKey(get('txId'));
      const dt = parseDateTime(get('paidAt'));
      const price = parseAmount(get('price'));
      const kindText = get('kind').trim();
      const kindKey = normKey(kindText);
      const content = get('content').trim();

      if (!txId) errs.push('取引IDが空です');
      else if (/^\d(?:\.\d+)?E\+?\d+$/i.test(txId)) errs.push('取引IDが「1.2E+11」のような指数表記に崩れています（Excelで開いて上書き保存すると起きます。noteから書き出し直したCSVを使ってください）');
      if (!dt) {
        const rawDt = nfkc(get('paidAt')).trim();
        if (/^\d(?:\.\d+)?E\+?\d+$/i.test(rawDt)) errs.push(`日時が「${short(rawDt, 16)}」のような指数表記に崩れています（Excelで開いて上書き保存すると起きます。noteから書き出し直したCSVを使ってください）`);
        else errs.push(`日時を読み取れません（${short(get('paidAt'), 20) || '空欄'}）`);
      }
      if (!price.ok) errs.push(`販売額を読み取れません（${short(get('price'), 16) || '空欄'}）`);
      else if (!Number.isInteger(price.value)) errs.push('販売額が整数ではありません');
      if (!content) errs.push('コンテンツ名が空です');

      if (!errs.length) {
        const dupKey = txId + '\u0000' + kindKey;
        if (seenInFile.has(dupKey)) errs.push(`ファイル内で同じ取引ID・種別の行が重複しています（${seenInFile.get(dupKey)}件目と同じ）`);
        else seenInFile.set(dupKey, no);
      }

      const raw = {};
      head.headers.forEach((h, idx) => { if (h && h !== '__proto__') raw[h] = cells[idx] == null ? '' : String(cells[idx]); });

      const buyerName = get('buyer').trim();
      const issuer = get('issuer').trim();
      const row = {
        no, errs, raw, txId, kindKey, kindText,
        date: dt ? dt.date : '', ym: dt ? dt.ym : '', iso: dt ? dt.iso : '',
        priceRaw: price.ok ? price.value : 0,
        buyerName, buyerKey: normKey(buyerName), buyerStatus: buyerStatusOf(buyerName),
        content, contentKey: normKey(content), contentType: get('contentType').trim(),
        payMethod: get('payMethod').trim(), taxRate: get('taxRate').trim(),
        priceExTax: parseOptionalAmount(get('priceExTax')), tax: parseOptionalAmount(get('tax')),
        points: parseOptionalAmount(get('points')),
        issuer, issuerRegNo: get('issuerRegNo').trim(),
        status: errs.length ? 'error' : 'new', cross: [], sameTxOtherKind: false,
      };
      pv.rows.push(row);

      if (!errs.length) {
        const k = kindAgg.get(kindKey) || { key: kindKey, text: kindText, count: 0, sum: 0 };
        k.count++; k.sum += row.priceRaw;
        kindAgg.set(kindKey, k);
        if (!pv.period.from || row.date < pv.period.from) pv.period.from = row.date;
        if (!pv.period.to || row.date > pv.period.to) pv.period.to = row.date;
        if (issuer) issuerSet.set(normKey(issuer), issuer);
      }
    }

    if (!pv.rows.length) pv.fatal.push('見出しの下にデータ行がありません。');
    pv.kinds = Array.from(kindAgg.values()).sort((a, b) => b.count - a.count);
    pv.issuers = Array.from(issuerSet.values());
    if (pv.issuers.length > 1) pv.info.push(`1つのファイルに複数の発行事業者が含まれています（${pv.issuers.length}種類）。複数のブランドのデータが混ざっていないか確認してください。`);

    // 決済種別の扱い：保存済みの設定 → 直前の選択（文字コード切替時の引き継ぎ）の順で埋める
    const rules = noteKindRules();
    pv.kinds.forEach((k) => {
      if (rules[k.key]) pv.kindChoices[k.key] = rules[k.key];
      else if (carry && carry.kindChoices && carry.kindChoices[k.key]) pv.kindChoices[k.key] = carry.kindChoices[k.key];
    });
    return pv;
  }

  async function refreshKeyIndex(pv) {
    let keys = [];
    try { keys = await getAllKeys(S_TX); } catch (e) { console.error('取込済みキーの読み込みに失敗しました', e); }
    const idSet = new Set(keys);
    const brandsByTxId = new Map(); // note の取引ID → そのIDを持つブランドの集合
    keys.forEach((k) => {
      let arr;
      try { arr = JSON.parse(k); } catch (e) { return; }
      if (!Array.isArray(arr) || arr[0] !== PLATFORM_NOTE) return;
      if (!brandsByTxId.has(arr[2])) brandsByTxId.set(arr[2], new Set());
      brandsByTxId.get(arr[2]).add(arr[1]);
    });
    pv.keyIndex = { idSet, brandsByTxId };
  }

  function classifyPreview(pv) {
    const idx = pv.keyIndex || { idSet: new Set(), brandsByTxId: new Map() };
    pv.sameFile = pv.hash ? (imports.find((i) => i.fileHash === pv.hash) || null) : null;
    pv.rows.forEach((r) => {
      r.cross = [];
      r.sameTxOtherKind = false;
      if (r.errs.length) { r.status = 'error'; return; }
      if (!pv.brandId) { r.status = 'new'; return; } // ブランド未選択の間は仮に新規扱い（確定はできない）
      if (idx.idSet.has(makeTxId(PLATFORM_NOTE, pv.brandId, r.txId, r.kindKey))) { r.status = 'dup'; return; }
      r.status = 'new';
      const bs = idx.brandsByTxId.get(r.txId);
      if (bs) {
        bs.forEach((b) => { if (b !== pv.brandId) r.cross.push(b); });
        if (bs.has(pv.brandId)) r.sameTxOtherKind = true;
      }
    });
    computePreviewTotals(pv);
  }

  function computePreviewTotals(pv) {
    const t = {
      sale: 0, refund: 0, net: 0, newNet: 0,
      newCount: 0, dupCount: 0, errCount: 0, ignoreCount: 0,
      crossCount: 0, sameTxCount: 0, pendingKinds: 0,
      added: { sale: 0, refund: 0, net: 0 },
    };
    const monthMap = new Map(); // 管理画面との照合用：月ごとのファイル全体の合計（取込済みでスキップする行も含む）
    pv.rows.forEach((r) => {
      if (r.status === 'error') { t.errCount++; return; }
      const mo = monthMap.get(r.ym) || { ym: r.ym, sale: 0, refund: 0, net: 0 };
      monthMap.set(r.ym, mo);
      if (r.status === 'dup') t.dupCount++;
      if (r.status === 'new') {
        t.newCount++;
        if (r.cross.length) t.crossCount++;
        if (r.sameTxOtherKind) t.sameTxCount++;
      }
      const rule = pv.kindChoices[r.kindKey];
      if (!rule) return;
      if (rule === 'ignore') { t.ignoreCount++; return; }
      const c = contribution(rule, r.priceRaw);
      if (rule === 'sale') { t.sale += c; mo.sale += c; } else { t.refund += Math.abs(r.priceRaw); mo.refund += Math.abs(r.priceRaw); }
      t.net += c;
      mo.net += c;
      if (r.status === 'new') {
        t.newNet += c;
        if (rule === 'sale') t.added.sale += c; else t.added.refund += Math.abs(r.priceRaw);
        t.added.net += c;
      }
    });
    t.pendingKinds = pv.kinds.filter((k) => !pv.kindChoices[k.key]).length;
    // 管理画面との照合：入力された金額が、その月の差引か売上のどちらかと一致すれば「一致」
    // state：empty（未入力）／invalid（数字でない）／waiting（決済種別の扱いが未設定で、まだ比べられない）／net・sale（一致）／mismatch
    t.recon = Array.from(monthMap.values()).sort((a, b) => (a.ym < b.ym ? -1 : 1)).map((m) => {
      const raw = String(pv.reconInputs[m.ym] || '').trim();
      let state = 'empty';
      let entered = null;
      if (raw) {
        const a = parseAmount(raw);
        if (!a.ok || !Number.isInteger(a.value)) state = 'invalid';
        else {
          entered = a.value;
          if (t.pendingKinds) state = 'waiting';
          else state = a.value === m.net ? 'net' : a.value === m.sale ? 'sale' : 'mismatch';
        }
      }
      return Object.assign({}, m, { raw, entered, state });
    });
    pv.totals = t;

    const b = [];
    if (pv.fatal.length || pv.sameFile) {
      b.push('このファイルは取り込めません');
    } else {
      if (!pv.brandId) b.push('ブランドを選んでください');
      if (t.pendingKinds) b.push(`決済種別の扱いを選んでください（残り${t.pendingKinds}種類）`);
      if (t.errCount && !pv.excludeErrors) b.push(`読み取れない行が${t.errCount}件あります。除外してよければチェックを入れてください`);
      if (t.crossCount && !pv.crossConfirmed) b.push('別のブランドで取込済みの取引IDがあります。確認してチェックを入れてください');
      if (t.recon.some((x) => x.state === 'invalid')) b.push('管理画面の金額を読み取れない欄があります（数字で入力するか、空欄にしてください）');
      if (t.recon.some((x) => x.state === 'mismatch') && !pv.reconConfirmed) b.push('管理画面の金額と一致しない月があります。理由を確かめて、取り込む場合はチェックを入れてください');
      if (pv.brandId && t.newCount === 0) b.push('新しく追加される取引がありません（すべて取込済みです）');
    }
    pv.blockers = b;
  }

  /* ===================== 取込：ファイル受付 ===================== */
  async function handleFile(file) {
    if (!file) return;
    if (!db) { showToast('保存機能が使えないため、取り込めません', true); return; }
    if (!ALLOWED_EXT.test(file.name)) { showToast('CSVファイル（.csv／.tsv／.txt）を選んでください', true); return; }
    if (file.size === 0) { showToast('ファイルが空です', true); return; }
    if (file.size > MAX_FILE_BYTES) { showToast('ファイルが大きすぎます（上限10MB）', true); return; }
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { showToast('ファイルを読み込めませんでした', true); return; }
    let hash = null;
    try { hash = await sha256Hex(buf); } catch (e) { hash = null; }
    const pv = buildPreview({ name: file.name, size: file.size }, buf, hash, null, null);
    await refreshKeyIndex(pv);
    classifyPreview(pv);
    preview = pv;
    renderPreview();
    previewEl.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  async function changeEncoding(enc) {
    if (!preview) return;
    const old = preview;
    const pv = buildPreview(old.file, old.buf, old.hash, enc, { brandId: old.brandId, kindChoices: old.kindChoices, keyIndex: old.keyIndex, reconInputs: old.reconInputs });
    classifyPreview(pv);
    preview = pv;
    renderPreview();
  }

  function closePreview() {
    preview = null;
    previewEl.classList.remove('is-active');
  }

  /* ===================== 取込：確定（1トランザクションで全件） ===================== */
  async function commitPreview() {
    const pv = preview;
    if (!pv || committing) return;
    computePreviewTotals(pv);
    if (pv.blockers.length) { renderPreview(); return; }
    const newRows = pv.rows.filter((r) => r.status === 'new');
    if (!newRows.length) return;

    committing = true;
    $('pvCommit').disabled = true;
    const now = Date.now();
    const importId = 'imp_' + stamp(now) + '_' + randId(4);
    const records = newRows.map((r) => {
      const rule = pv.kindChoices[r.kindKey];
      return {
        id: makeTxId(PLATFORM_NOTE, pv.brandId, r.txId, r.kindKey),
        platform: PLATFORM_NOTE, brand: pv.brandId, ptx: PLATFORM_NOTE + '|' + r.txId,
        txId: r.txId, kindKey: r.kindKey, kindText: r.kindText, kind: rule,
        paidAt: r.iso, date: r.date, ym: r.ym,
        buyerName: r.buyerName, buyerKey: r.buyerKey, buyerStatus: r.buyerStatus, readerId: null,
        contentName: r.content, contentKey: r.contentKey, contentType: r.contentType, workId: null,
        payMethod: r.payMethod, currency: 'JPY', quantity: 1,
        priceRaw: r.priceRaw, amount: contribution(rule, r.priceRaw),
        priceExTax: r.priceExTax, tax: r.tax, taxRate: r.taxRate, points: r.points,
        issuer: r.issuer, issuerRegNo: r.issuerRegNo,
        importId, rowNo: r.no, raw: r.raw, createdAt: now,
      };
    });
    const t = pv.totals;
    const importRec = {
      id: importId, platform: PLATFORM_NOTE, profileId: NOTE_PROFILE_ID, brand: pv.brandId,
      fileName: pv.file.name, fileSize: pv.file.size, fileHash: pv.hash, encoding: pv.encoding,
      periodFrom: pv.period.from, periodTo: pv.period.to,
      counts: { rows: pv.rows.length, added: records.length, duplicate: t.dupCount, excluded: t.errCount },
      totals: { sale: t.added.sale, refund: t.added.refund, net: t.added.net },
      // 管理画面との照合の記録（入力した月だけ）。result：'net'／'sale'（一致した相手）・'mismatch'（承知の上で取込）
      reconcile: t.recon.filter((x) => x.state === 'net' || x.state === 'sale' || x.state === 'mismatch')
        .map((x) => ({ ym: x.ym, entered: x.entered, csvSale: x.sale, csvNet: x.net, result: x.state })),
      importedAt: now,
    };
    const cur = profiles.get(NOTE_PROFILE_ID) || { id: NOTE_PROFILE_ID, platform: PLATFORM_NOTE, name: 'note 記事の販売履歴', builtin: true, createdAt: now };
    const profile = Object.assign({}, cur, { kindRules: Object.assign({}, noteKindRules(), pv.kindChoices), updatedAt: now });

    try {
      const tx = requireDb().transaction([S_TX, S_IMPORTS, S_PROFILES], 'readwrite');
      const done = txDone(tx);
      try {
        const sTx = tx.objectStore(S_TX);
        // add（putではない）：同じ主キーが既にあれば失敗し、取込全体が中止される＝二重登録が起きない
        records.forEach((rec) => sTx.add(rec));
        tx.objectStore(S_IMPORTS).add(importRec);
        tx.objectStore(S_PROFILES).put(profile);
      } catch (syncErr) {
        // 途中で例外が出たら、それまでに積んだ書き込みも含めて全部取り消す（一部だけ保存されるのを防ぐ）
        console.error(syncErr);
        try { tx.abort(); } catch (e) { /* すでに終了している */ }
      }
      await done;
    } catch (err) {
      console.error('取込に失敗しました', err);
      const dupHint = err && err.name === 'ConstraintError' ? '別のタブなどで同じ取引が先に取り込まれた可能性があります。ファイルを選び直してください。' : '';
      showToast('取り込めませんでした。何も保存されていません。' + dupHint, true);
      committing = false;
      await refreshKeyIndex(pv).catch(() => {});
      classifyPreview(pv);
      renderPreview();
      return;
    }
    committing = false;
    closePreview();
    await reloadAndRender();
    showToast(`${records.length}件を取り込みました`);
  }

  /* ===================== 取込の取り消し ===================== */
  async function undoImport(imp) {
    const count = txAll.filter((t) => t.importId === imp.id).length;
    const ok = await confirmDialog(
      `この取込を取り消しますか？\n${imp.fileName}\n追加した取引${count}件（差引 ${yen(imp.totals && imp.totals.net)}）を削除します。元に戻せません。\n※元のCSVがあれば、いつでも取り込み直せます。`,
      '取り消す'
    );
    if (!ok) return;
    try {
      const tx = requireDb().transaction([S_TX, S_IMPORTS], 'readwrite');
      const done = txDone(tx);
      const sTx = tx.objectStore(S_TX);
      const req = sTx.index('importId').getAllKeys(IDBKeyRange.only(imp.id));
      req.onsuccess = () => { req.result.forEach((k) => sTx.delete(k)); };
      tx.objectStore(S_IMPORTS).delete(imp.id);
      await done;
    } catch (err) {
      console.error('取り消しに失敗しました', err);
      showToast('取り消せませんでした。データは変わっていません。', true);
      return;
    }
    await reloadAndRender();
    if (preview) {
      await refreshKeyIndex(preview);
      classifyPreview(preview);
      renderPreview();
    }
    showToast('取り消しました');
  }

  async function reloadAndRender() {
    try { await loadAll(); } catch (e) { console.error('データの読み込みに失敗しました', e); }
    renderAll();
  }

  /* ===================== 描画：取込の確認画面 ===================== */
  function renderPreview() {
    const pv = preview;
    if (!pv) { previewEl.classList.remove('is-active'); return; }
    previewEl.classList.add('is-active');
    const t = pv.totals || {};

    // 取り込めない理由
    const fatalMsgs = pv.fatal.slice();
    if (pv.sameFile) fatalMsgs.push(`このファイルは ${fmtTs(pv.sameFile.importedAt)} に取込済みです（${pv.sameFile.fileName}）。\n取り込み直す場合は、先に下の履歴から取り消してください。`);
    $('pvFatalBlock').classList.toggle('is-hidden', !fatalMsgs.length);
    $('pvFatalText').textContent = fatalMsgs.join('\n\n');

    // ファイル
    $('pvFileName').textContent = pv.file.name;
    $('pvEncoding').value = pv.encoding;
    const valid = pv.rows.filter((r) => r.status !== 'error').length;
    $('pvRows').textContent = pv.rows.length ? `${pv.rows.length}件（読み取れた行 ${valid}件）` : '0件';
    $('pvPeriod').textContent = fmtPeriod(pv.period.from, pv.period.to);
    $('pvFileNote').textContent = pv.encoding === 'shift_jis' ? '文字コードはShift_JISと判定しました。文字化けしていたら切り替えてください。' : '';

    const parseOk = !pv.fatal.length;
    ['pvBrandBlock', 'pvKindsBlock', 'pvSampleBlock'].forEach((id) => $(id).classList.toggle('is-hidden', !parseOk));

    // ブランド
    const sel = $('pvBrand');
    sel.textContent = '';
    const ph = el('option', '', brands.length ? 'ブランドを選んでください' : '先に「ブランドを追加」で登録してください');
    ph.value = '';
    sel.append(ph);
    brands.forEach((b) => { const o = el('option', '', b.name); o.value = b.id; sel.append(o); });
    sel.value = brandById(pv.brandId) ? pv.brandId : '';
    const iss = $('pvIssuer');
    if (pv.issuers.length === 1) iss.textContent = `CSV内の発行事業者：${shownIssuer(pv.issuers[0])}（ブランド選択の確認用）`;
    else if (pv.issuers.length > 1) iss.textContent = `CSV内の発行事業者：${pv.issuers.map(shownIssuer).join('／')}`;
    else iss.textContent = '';

    // 決済種別
    const kindsBox = $('pvKinds');
    kindsBox.textContent = '';
    const saved = noteKindRules();
    pv.kinds.forEach((k) => {
      const row = el('div', 'kind-row' + (pv.kindChoices[k.key] ? '' : ' is-pending'));
      const name = el('div', 'kind-name', k.text || '（空欄）');
      if (!saved[k.key]) name.append(el('span', 'tag is-new', '初めての値'));
      const s = el('select');
      s.setAttribute('aria-label', `「${k.text || '空欄'}」の扱い`);
      const o0 = el('option', '', '扱いを選ぶ');
      o0.value = '';
      s.append(o0);
      KIND_CHOICES.forEach((c) => { const o = el('option', '', c.label); o.value = c.value; s.append(o); });
      s.value = pv.kindChoices[k.key] || '';
      s.addEventListener('change', () => {
        if (s.value) pv.kindChoices[k.key] = s.value; else delete pv.kindChoices[k.key];
        computePreviewTotals(pv);
        renderPreview();
      });
      row.append(name, el('div', 'kind-count num', `${k.count}件`), el('div', 'kind-sum num', yen(k.sum)), s);
      kindsBox.append(row);
    });
    if (!pv.kinds.length) kindsBox.append(el('div', 'field-hint', '読み取れた行がありません。'));

    // 読み取れない行
    const errRows = pv.rows.filter((r) => r.status === 'error');
    $('pvErrorsBlock').classList.toggle('is-hidden', !(parseOk && errRows.length));
    const errList = $('pvErrorsList');
    errList.textContent = '';
    errRows.slice(0, MAX_ISSUES_SHOWN).forEach((r) => errList.append(el('li', '', `${r.no}件目：${r.errs.join('／')}`)));
    if (errRows.length > MAX_ISSUES_SHOWN) errList.append(el('li', '', `ほか${errRows.length - MAX_ISSUES_SHOWN}件`));
    $('pvExcludeErrors').checked = pv.excludeErrors;
    $('pvExcludeLabel').textContent = `この${errRows.length}件を除外して取り込む（合計行・区切りの崩れた行など）`;

    // 別ブランドで取込済み
    const crossRows = pv.rows.filter((r) => r.status === 'new' && r.cross.length);
    $('pvCrossBlock').classList.toggle('is-hidden', !(parseOk && crossRows.length));
    if (crossRows.length) {
      const others = new Set();
      crossRows.forEach((r) => r.cross.forEach((b) => others.add(b)));
      const names = Array.from(others).map((id) => (brandById(id) ? brandById(id).name : '不明なブランド')).join('、');
      $('pvCrossText').textContent = `${crossRows.length}件の取引IDが、別のブランド（${names}）で取込済みです。ブランドの選び間違いではないか確認してください。`;
      const list = $('pvCrossList');
      list.textContent = '';
      crossRows.slice(0, 10).forEach((r) => list.append(el('li', '', `取引ID ${r.txId}（${r.date.replace(/-/g, '/')}）`)));
      if (crossRows.length > 10) list.append(el('li', '', `ほか${crossRows.length - 10}件`));
    }
    $('pvCrossConfirm').checked = pv.crossConfirmed;

    // お知らせ
    const infos = pv.info.slice();
    if (t.sameTxCount) infos.push(`${t.sameTxCount}件は、取込済みの取引と取引IDが同じで種別が違う行です（返金など）。別の取引として追加します。`);
    if (!pv.brandId && parseOk) infos.push('ブランドを選ぶと、取込済みの行を判定します。');
    $('pvInfoBlock').classList.toggle('is-hidden', !infos.length);
    const infoList = $('pvInfoList');
    infoList.textContent = '';
    infos.forEach((m) => infoList.append(el('li', '', m)));

    // 追加される取引の見本
    const sample = $('pvSample');
    sample.textContent = '';
    const newRows = pv.rows.filter((r) => r.status === 'new');
    $('pvSampleTitle').textContent = newRows.length > SAMPLE_SIZE ? `新しく追加される取引（先頭${SAMPLE_SIZE}件／全${newRows.length}件）` : `新しく追加される取引（${newRows.length}件）`;
    newRows.slice(0, SAMPLE_SIZE).forEach((r) => {
      const rule = pv.kindChoices[r.kindKey];
      sample.append(txRowEl({
        paidAt: r.iso, brand: pv.brandId, buyerName: r.buyerName, buyerStatus: r.buyerStatus,
        contentName: r.content, kind: rule || '', kindText: r.kindText, priceRaw: r.priceRaw,
        amount: rule ? contribution(rule, r.priceRaw) : r.priceRaw,
      }));
    });
    if (!newRows.length && parseOk) sample.append(el('div', 'field-hint', '新しく追加される取引はありません。'));

    // 検算
    const show = parseOk && t;
    $('lgSale').textContent = show ? yen(t.sale) : '—';
    $('lgRefund').textContent = show ? (t.refund ? '−' + yen(t.refund) : yen(0)) : '—';
    $('lgNet').textContent = show ? yen(t.net) : '—';
    $('lgNew').textContent = show ? `${t.newCount}件` : '—';
    $('lgDup').textContent = show ? `${t.dupCount}件` : '—';
    $('lgErr').textContent = show ? `${t.errCount}件` : '—';
    $('lgIgnore').textContent = show ? `${t.ignoreCount}件` : '—';
    $('lgNewNet').textContent = show ? yen(t.newNet) : '—';
    renderReconcile(pv);
    renderCommitState(pv);
  }

  // 確定できない理由とボタン（照合欄の入力のたびに、画面全体を作り直さずにここだけ更新する）
  function renderCommitState(pv) {
    const t = pv.totals || {};
    const note = $('commitNote');
    note.textContent = '';
    pv.blockers.forEach((m) => note.append(el('li', '', m)));
    const btn = $('pvCommit');
    btn.disabled = !!pv.blockers.length || committing;
    btn.textContent = !pv.blockers.length && t.newCount ? `${t.newCount}件を取り込む` : '取り込む';
  }

  /* ===================== 描画：管理画面との照合（検算欄） ===================== */
  // 入力欄は、ファイルか月の並びが変わったときだけ作り直す（入力中にフォーカスと文字が消えないように）
  function renderReconcile(pv) {
    const t = pv.totals || {};
    const rc = (!pv.fatal.length && !pv.sameFile && t.recon) || [];
    $('lgReconBlock').classList.toggle('is-hidden', !rc.length);
    const box = $('lgRecon');
    const key = rc.map((x) => x.ym).join(',');
    if (box.reconOwner !== pv || box.dataset.key !== key) {
      box.reconOwner = pv;
      box.dataset.key = key;
      box.reconRefs = {};
      box.textContent = '';
      rc.forEach((x) => {
        const row = el('div', 'recon-row');
        const label = el('label', 'recon-ym', fmtYm(x.ym));
        const input = el('input', 'field-input num recon-input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'off';
        input.maxLength = 20;
        input.placeholder = '例 12,345';
        input.id = 'lgReconIn_' + x.ym;
        label.htmlFor = input.id;
        input.setAttribute('aria-label', `${fmtYm(x.ym)}の管理画面の金額`);
        input.value = pv.reconInputs[x.ym] || '';
        input.addEventListener('input', () => {
          pv.reconInputs[x.ym] = input.value;
          pv.reconConfirmed = false; // 金額を変えたら、不一致の確認はやり直し
          computePreviewTotals(pv);
          renderReconcile(pv);
          renderCommitState(pv);
        });
        const result = el('div', 'recon-result');
        row.append(label, input, result);
        box.append(row);
        box.reconRefs[x.ym] = result;
      });
    }
    rc.forEach((x) => {
      const res = box.reconRefs[x.ym];
      if (!res) return;
      let text;
      let cls = '';
      if (x.state === 'invalid') { text = '金額を読み取れません'; cls = 'is-bad'; }
      else if (x.state === 'waiting' || (x.state === 'empty' && t.pendingKinds)) text = '決済種別の扱いを選ぶと照合します';
      else if (x.state === 'net') { text = `一致（差引 ${yen(x.net)}）`; cls = 'is-ok'; }
      else if (x.state === 'sale') { text = `一致（売上 ${yen(x.sale)}）`; cls = 'is-ok'; }
      else if (x.state === 'mismatch') {
        const diff = x.entered - x.net;
        text = `不一致：CSVの差引 ${yen(x.net)}・売上 ${yen(x.sale)}（差引との差 ${diff > 0 ? '+' : ''}${yen(diff)}）`;
        cls = 'is-bad';
      } else text = `CSV：差引 ${yen(x.net)}・売上 ${yen(x.sale)}`;
      res.textContent = text;
      res.className = 'recon-result' + (cls ? ' ' + cls : '');
    });
    const anyMismatch = rc.some((x) => x.state === 'mismatch');
    $('lgReconConfirmRow').classList.toggle('is-hidden', !anyMismatch);
    $('lgReconConfirm').checked = pv.reconConfirmed;
    $('lgReconHint').textContent = anyMismatch && t.errCount
      ? `読み取れずに除外した行（${t.errCount}件）が差の原因かもしれません。`
      : '';
  }

  /* ===================== 描画：取引の1行（一覧・見本で共用） ===================== */
  function txRowEl(t) {
    const kindCls = t.kind ? 'k-' + t.kind : 'k-pending';
    const row = el('div', 'tx-row ' + kindCls);
    const sub = el('div', 'tx-sub');
    const date = el('div', 'tx-date num', fmtDateTimeIso(t.paidAt));
    const brand = el('div', 'tx-brand');
    brand.append(brandChip(t.brand));
    const buyer = el('div', 'tx-buyer', shownBuyer(t.buyerName, t.buyerStatus));
    if (t.buyerStatus === 'unidentifiable') buyer.append(el('span', 'tag', '共通表記'));
    sub.append(date, brand, buyer);
    const content = el('div', 'tx-content', t.contentName || '（作品名なし）');
    content.title = t.contentName || '';
    const kind = el('div', 'tx-kind', t.kind ? KIND_LABEL[t.kind] : `未設定（${t.kindText || '空欄'}）`);
    const amount = el('div', 'tx-amount num', yen(t.kind === 'ignore' ? t.priceRaw : t.amount));
    row.append(sub, content, kind, amount);
    return row;
  }

  /* ===================== 描画：取込の履歴 ===================== */
  function renderHistory() {
    historyList.textContent = '';
    if (!imports.length) {
      historyList.append(el('div', 'hist-empty', 'まだ取り込んだファイルはありません。'));
      return;
    }
    imports.forEach((imp) => {
      const row = el('div', 'hist-row');
      const main = el('div', 'hist-main');
      const file = el('div', 'hist-file', imp.fileName);
      file.title = imp.fileName;
      const meta = el('div', 'hist-meta');
      meta.append(brandChip(imp.brand), el('span', 'num', `期間 ${fmtPeriod(imp.periodFrom, imp.periodTo)}`), el('span', 'num', `取込 ${fmtTs(imp.importedAt)}`));
      const rec = Array.isArray(imp.reconcile) ? imp.reconcile : [];
      if (rec.length) {
        const bad = rec.filter((x) => x.result === 'mismatch');
        const tag = bad.length
          ? el('span', 'tag is-new', `管理画面と不一致 ${bad.map((x) => fmtYm(x.ym)).join('・')}`)
          : el('span', 'tag is-ok', '管理画面と一致');
        tag.title = rec.map((x) => `${fmtYm(x.ym)}：入力 ${yen(x.entered)}／CSVの差引 ${yen(x.csvNet)}・売上 ${yen(x.csvSale)}`).join('\n');
        meta.append(tag);
      }
      main.append(file, meta);
      const net = el('div', 'hist-net num', yen(imp.totals && imp.totals.net));
      net.append(el('small', '', `${(imp.counts && imp.counts.added) || 0}件を追加`));
      const undo = el('button', 'btn danger', '取り消す');
      undo.type = 'button';
      undo.addEventListener('click', () => undoImport(imp));
      row.append(main, net, undo);
      historyList.append(row);
    });
  }

  /* ===================== 描画：取引一覧 ===================== */
  function fillSelect(sel, firstLabel, items, keep) {
    const prev = keep ? sel.value : '';
    sel.textContent = '';
    const o0 = el('option', '', firstLabel);
    o0.value = '';
    sel.append(o0);
    items.forEach((it) => { const o = el('option', '', it.label); o.value = it.value; sel.append(o); });
    sel.value = items.some((it) => it.value === prev) ? prev : '';
  }
  function monthsInData() {
    return Array.from(new Set(txAll.map((t) => t.ym))).filter(Boolean).sort().reverse();
  }
  function renderTxFilters() {
    fillSelect($('fBrand'), 'すべてのブランド', brands.map((b) => ({ value: b.id, label: b.name })), true);
    fillSelect($('fMonth'), 'すべての月', monthsInData().map((ym) => ({ value: ym, label: fmtYm(ym) })), true);
  }
  function filteredTx() {
    const fb = $('fBrand').value;
    const fm = $('fMonth').value;
    const fk = $('fKind').value;
    const q = normKey($('fQuery').value).toLowerCase();
    return txAll.filter((t) => {
      if (fb && t.brand !== fb) return false;
      if (fm && t.ym !== fm) return false;
      if (fk && t.kind !== fk) return false;
      if (q) {
        const hay = [t.contentKey, t.buyerKey, t.txId].map((v) => String(v || '').toLowerCase());
        if (!hay.some((v) => v.includes(q))) return false;
      }
      return true;
    });
  }
  function renderTx() {
    const list = $('txList');
    const sum = $('txSummary');
    list.textContent = '';
    sum.textContent = '';
    if (!txAll.length) {
      const es = el('div', 'empty-state');
      es.append(el('div', 'big', 'まだ取引がありません'), el('div', 'small', '「取込」タブから、noteの販売履歴CSVを読み込んでください。'));
      list.append(es);
      $('txMore').style.display = 'none';
      return;
    }
    const rows = filteredTx();
    let sale = 0, refund = 0, net = 0;
    rows.forEach((t) => {
      if (t.kind === 'sale') sale += t.amount;
      else if (t.kind === 'refund') refund += Math.abs(t.amount);
      net += t.amount || 0;
    });
    const item = (label, value, cls) => { const s = el('span', cls || '', label); s.append(el('b', 'num', value)); return s; };
    sum.append(item('件数', `${rows.length}件`), item('売上', yen(sale)), item('返金', refund ? '−' + yen(refund) : yen(0), 'is-neg'), item('差引', yen(net), 'is-net'));
    if (!rows.length) {
      list.append(el('div', 'hist-empty', '条件に合う取引はありません。'));
      $('txMore').style.display = 'none';
      return;
    }
    const frag = document.createDocumentFragment();
    rows.slice(0, txShown).forEach((t) => frag.append(txRowEl(t)));
    list.append(frag);
    const rest = rows.length - txShown;
    const more = $('txMore');
    more.style.display = rest > 0 ? 'block' : 'none';
    more.textContent = `さらに表示（残り${rest}件）`;
  }

  /* ===================== 描画：月別 ===================== */
  function renderMonthly() {
    const box = $('monthlyInner');
    box.textContent = '';
    if (!txAll.length) {
      const es = el('div', 'empty-state');
      es.append(el('div', 'big', 'まだ集計するデータがありません'), el('div', 'small', '「取込」タブから、noteの販売履歴CSVを読み込んでください。'));
      const go = el('button', 'btn primary', '取込を開く');
      go.type = 'button';
      go.addEventListener('click', () => switchTab('import'));
      es.append(go);
      box.append(es);
      return;
    }
    const byYm = new Map(); // ym → Map(brandId → {net, sales})
    const brandIds = new Set();
    txAll.forEach((t) => {
      if (t.kind === 'ignore') return;
      if (!byYm.has(t.ym)) byYm.set(t.ym, new Map());
      const m = byYm.get(t.ym);
      const c = m.get(t.brand) || { net: 0, sales: 0 };
      c.net += t.amount || 0;
      if (t.kind === 'sale') c.sales++;
      m.set(t.brand, c);
      brandIds.add(t.brand);
    });
    const cols = brands.filter((b) => brandIds.has(b.id)).map((b) => b.id);
    brandIds.forEach((id) => { if (!cols.includes(id)) cols.push(id); });
    const yms = Array.from(byYm.keys()).sort().reverse();

    const wrap = el('div', 'table-wrap');
    const table = el('table', 'mtable');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', '', '月'));
    cols.forEach((id) => { const th = el('th'); th.append(brandChip(id)); hr.append(th); });
    hr.append(el('th', '', '合計'));
    thead.append(hr);
    const tbody = el('tbody');
    const grand = new Map();
    let grandNet = 0, grandSales = 0;
    yms.forEach((ym) => {
      const tr = el('tr');
      const th = el('td');
      const link = el('button', 'ym-link', fmtYm(ym));
      link.type = 'button';
      link.title = 'この月の取引一覧を開く';
      link.addEventListener('click', () => {
        $('fMonth').value = ym;
        $('fBrand').value = '';
        $('fKind').value = '';
        $('fQuery').value = '';
        txShown = PAGE_SIZE;
        switchTab('tx');
      });
      th.append(link);
      tr.append(th);
      let rowNet = 0, rowSales = 0;
      cols.forEach((id) => {
        const c = byYm.get(ym).get(id);
        const td = el('td', 'num' + (c && c.net < 0 ? ' is-neg' : ''), c ? yen(c.net) : '—');
        if (c) td.append(el('span', 'cnt', `${c.sales}件`));
        tr.append(td);
        if (c) {
          rowNet += c.net; rowSales += c.sales;
          const g = grand.get(id) || { net: 0, sales: 0 };
          g.net += c.net; g.sales += c.sales;
          grand.set(id, g);
        }
      });
      const tot = el('td', 'num is-total', yen(rowNet));
      tot.append(el('span', 'cnt', `${rowSales}件`));
      tr.append(tot);
      grandNet += rowNet; grandSales += rowSales;
      tbody.append(tr);
    });
    const tfoot = el('tfoot');
    const fr = el('tr');
    fr.append(el('td', '', '全期間'));
    cols.forEach((id) => {
      const g = grand.get(id) || { net: 0, sales: 0 };
      const td = el('td', 'num', yen(g.net));
      td.append(el('span', 'cnt', `${g.sales}件`));
      fr.append(td);
    });
    const gt = el('td', 'num is-total', yen(grandNet));
    gt.append(el('span', 'cnt', `${grandSales}件`));
    fr.append(gt);
    tfoot.append(fr);
    table.append(thead, tbody, tfoot);
    wrap.append(table);
    box.append(wrap);
    box.append(el('p', 'field-hint monthly-note', '金額は差引（売上−返金）で、税込の販売額です（noteの手数料を引く前）。件数は売上の件数です。月の名前を押すと、その月の取引一覧を開きます。'));
  }

  function renderAll() {
    maskBtn.setAttribute('aria-pressed', ui.mask ? 'true' : 'false');
    renderHistory();
    renderTxFilters();
    renderTx();
    renderMonthly();
    if (preview) renderPreview();
  }

  /* ===================== ブランドの管理 ===================== */
  function renderBrandModal() {
    const box = $('brandRows');
    box.textContent = '';
    $('brandError').textContent = '';
    if (!brands.length) box.append(el('div', 'hist-empty', 'まだブランドがありません。下の欄から追加してください。'));
    brands.forEach((b) => {
      const row = el('div', 'brand-row');
      const color = el('input');
      color.type = 'color';
      color.value = b.color;
      color.setAttribute('aria-label', `${b.name}の色`);
      color.addEventListener('change', async () => {
        if (!RE_HEX6.test(color.value)) return;
        b.color = color.value;
        await persistBrands();
      });
      const name = el('input', 'field-input');
      name.type = 'text';
      name.maxLength = BRAND_NAME_MAX;
      name.value = b.name;
      name.setAttribute('aria-label', 'ブランド名');
      name.addEventListener('change', async () => {
        const v = validateBrandName(name.value, b.id);
        if (!v.ok) { $('brandError').textContent = v.msg; name.value = b.name; return; }
        $('brandError').textContent = '';
        b.name = v.name;
        await persistBrands();
      });
      const del = el('button', 'btn danger', '削除');
      del.type = 'button';
      const inUse = brandInUse(b.id);
      del.disabled = inUse;
      del.title = inUse ? '取引があるため削除できません' : 'このブランドを削除';
      del.addEventListener('click', async () => {
        if (brandInUse(b.id)) return;
        const ok = await confirmDialog(`ブランド「${b.name}」を削除しますか？`, '削除する');
        if (!ok) return;
        brands = brands.filter((x) => x.id !== b.id);
        if (preview && preview.brandId === b.id) { preview.brandId = ''; classifyPreview(preview); }
        await persistBrands();
        renderBrandModal();
      });
      row.append(color, name, del);
      box.append(row);
    });
    $('newBrandColor').value = BRAND_PALETTE[brands.length % BRAND_PALETTE.length];
  }
  async function persistBrands() {
    try {
      await saveBrands();
    } catch (e) {
      console.error('ブランドの保存に失敗しました', e);
      showToast('ブランドを保存できませんでした', true);
    }
    renderAll();
  }
  async function addBrand() {
    const v = validateBrandName($('newBrandName').value, null);
    if (!v.ok) { $('brandError').textContent = v.msg; return; }
    const color = RE_HEX6.test($('newBrandColor').value) ? $('newBrandColor').value : BRAND_PALETTE[0];
    const b = { id: 'b_' + Date.now().toString(36) + randId(4), name: v.name, color, createdAt: Date.now() };
    brands.push(b);
    $('newBrandName').value = '';
    if (brandModalFromPreview && preview && !preview.brandId) {
      preview.brandId = b.id;
      classifyPreview(preview);
    }
    await persistBrands();
    renderBrandModal();
    showToast(`ブランド「${b.name}」を追加しました`);
  }

  /* ===================== 保存領域の状態 ===================== */
  async function renderStorageModal() {
    const box = $('storageStats');
    box.textContent = '';
    const add = (k, v) => { box.append(el('dt', '', k), el('dd', 'num', v)); };
    let persisted = null;
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { persisted = null; }
    add('消されにくい保存', persisted === null ? '確認できません' : (persisted ? '有効' : '未設定（容量不足時にブラウザが消す可能性あり）'));
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
        add('このサイトの使用量', `${mb(est.usage || 0)}（上限の目安 ${mb(est.quota || 0)}）`);
      }
    } catch (e) { /* 確認できない環境は表示しない */ }
    add('取引', `${txAll.length}件`);
    add('取込の履歴', `${imports.length}件`);
    add('ブランド', `${brands.length}件`);
    $('persistBtn').disabled = persisted === true || !(navigator.storage && navigator.storage.persist);
  }
  async function requestPersist(verbose) {
    if (!(navigator.storage && navigator.storage.persist)) return;
    try {
      const ok = await navigator.storage.persist();
      if (verbose) showToast(ok ? '消されにくい保存を有効にしました' : 'ブラウザに許可されませんでした（ブックマーク等で許可されやすくなります）', !ok);
    } catch (e) { /* 失敗しても動作に影響なし */ }
  }

  /* ===================== モーダル・メニュー・確認 ===================== */
  function openModal(id) { $(id).classList.add('is-open'); }
  function closeModal(id) { $(id).classList.remove('is-open'); }
  function closeMenu() { menuPanel.classList.remove('is-open'); menuBtn.setAttribute('aria-expanded', 'false'); }

  let confirmResolver = null;
  function confirmDialog(msg, okLabel) {
    if (confirmResolver) confirmResolver(false);
    $('confirmMsg').textContent = msg;
    $('confirmOk').textContent = okLabel || '実行する';
    openModal('confirmOverlay');
    $('confirmCancel').focus();
    return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function settleConfirm(v) {
    closeModal('confirmOverlay');
    const r = confirmResolver;
    confirmResolver = null;
    if (r) r(v);
  }

  function switchTab(name) {
    tabs.forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    views.forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
    if (name === 'tx') renderTx();
  }

  /* ===================== イベント ===================== */
  tabs.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  maskBtn.addEventListener('click', async () => {
    ui.mask = !ui.mask;
    renderAll();
    try { await saveUi(); } catch (e) { console.error(e); }
  });

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menuPanel.classList.contains('is-open');
    menuPanel.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  menuPanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    closeMenu();
    if (btn.dataset.action === 'brands') { brandModalFromPreview = false; renderBrandModal(); openModal('brandsOverlay'); }
    if (btn.dataset.action === 'storage') { renderStorageModal(); openModal('storageOverlay'); }
  });
  document.addEventListener('click', (e) => {
    if (menuPanel.classList.contains('is-open') && !e.target.closest('.menu-wrap')) closeMenu();
  });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  ['brandsOverlay', 'storageOverlay'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeModal(id); });
  });
  $('confirmOverlay').addEventListener('click', (e) => { if (e.target === $('confirmOverlay')) settleConfirm(false); });
  $('confirmCancel').addEventListener('click', () => settleConfirm(false));
  $('confirmOk').addEventListener('click', () => settleConfirm(true));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('confirmOverlay').classList.contains('is-open')) { settleConfirm(false); return; }
    const open = ['brandsOverlay', 'storageOverlay'].find((id) => $(id).classList.contains('is-open'));
    if (open) { closeModal(open); return; }
    closeMenu();
  });

  $('newBrandAdd').addEventListener('click', addBrand);
  $('newBrandName').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) addBrand(); });
  $('persistBtn').addEventListener('click', async () => { await requestPersist(true); renderStorageModal(); });

  // ファイル選択
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 同じファイルを選び直しても反応するように
    handleFile(f);
  });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 1) showToast('1回に取り込めるのは1ファイルです。先頭のファイルだけ読み込みます', true);
    handleFile(files && files[0]);
  });
  // ドロップ枠の外に落としたファイルで、アプリの画面がファイル表示に置き換わるのを防ぐ
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 確認画面の操作
  $('pvEncoding').addEventListener('change', (e) => changeEncoding(e.target.value));
  $('pvBrand').addEventListener('change', (e) => {
    if (!preview) return;
    preview.brandId = e.target.value;
    preview.crossConfirmed = false; // ブランドを変えたら、確認のチェックはやり直し
    classifyPreview(preview);
    renderPreview();
  });
  $('pvAddBrand').addEventListener('click', () => {
    brandModalFromPreview = true;
    renderBrandModal();
    openModal('brandsOverlay');
    $('newBrandName').focus();
  });
  $('pvExcludeErrors').addEventListener('change', (e) => {
    if (!preview) return;
    preview.excludeErrors = e.target.checked;
    computePreviewTotals(preview);
    renderPreview();
  });
  $('pvCrossConfirm').addEventListener('change', (e) => {
    if (!preview) return;
    preview.crossConfirmed = e.target.checked;
    computePreviewTotals(preview);
    renderPreview();
  });
  $('lgReconConfirm').addEventListener('change', (e) => {
    if (!preview) return;
    preview.reconConfirmed = e.target.checked;
    computePreviewTotals(preview);
    renderCommitState(preview);
  });
  $('pvCancel').addEventListener('click', closePreview);
  $('pvCommit').addEventListener('click', commitPreview);

  // 取引一覧の絞り込み
  ['fBrand', 'fMonth', 'fKind'].forEach((id) => $(id).addEventListener('change', () => { txShown = PAGE_SIZE; renderTx(); }));
  $('fQuery').addEventListener('input', () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => { txShown = PAGE_SIZE; renderTx(); }, 200);
  });
  $('txMore').addEventListener('click', () => { txShown += PAGE_SIZE; renderTx(); });

  /* ===================== 初期化 ===================== */
  function fatalInit(msg) {
    views.forEach((v) => {
      v.textContent = '';
      const es = el('div', 'empty-state');
      es.append(el('div', 'big', '保存機能を利用できません'), el('div', 'small', msg));
      v.append(es);
    });
  }

  async function init() {
    if (typeof Papa === 'undefined') {
      fatalInit('CSVを読み取る部品（vendor/papaparse.min.js）を読み込めませんでした。ページを再読み込みしてください。');
      return;
    }
    try {
      db = await openDb();
    } catch (err) {
      console.error('RECON用DBの初期化に失敗しました', err);
      fatalInit('このブラウザ／モードではIndexedDBが使えないため、取り込んだデータを保存できません。プライベートブラウジングや、ファイルを直接開いていないか（file://）確認してください。');
      return;
    }
    try {
      await ensureNoteProfile();
      await loadAll();
    } catch (err) {
      console.error('RECONのデータ読み込みに失敗しました', err);
    }
    renderAll();
    requestPersist(false);
  }

  init();
})();
