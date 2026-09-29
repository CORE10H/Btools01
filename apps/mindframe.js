/* =====================================================================
   MINDFRAME（apps/mindframe.html）本体
   ---------------------------------------------------------------------
   マインドマップ・フローチャート・UIラフ（画面の検討）を1枚の無限キャンバスで描くアプリ。
   - 描画は SVG。見た目は「表示リスト（path / text / image の配列）」を1か所で作り、
     画面（SVG）と PNG 書き出し（Canvas 2D）の両方がそれを描く＝見た目が必ず一致する
   - 保存は IndexedDB（sideops_mindframe）。入力は自動保存、本体の Stage を閉じる合図でも即保存
   - 色は本体テーマ（テーマブリッジ）から読み、テーマが変わったら描き直す
   - テキストの入出力（箇条書き・Mermaid）と自動整列は mindframe-io.js（window.MFIO）
===================================================================== */
(function () {
  'use strict';

  const IO = window.MFIO;

  /* =====================================================================
     定数
  ===================================================================== */
  const DB_NAME = 'sideops_mindframe';
  const DB_VERSION = 1;
  const S = { boards: 'boards', images: 'images', views: 'views', meta: 'meta' };
  const APP_KEY = 'sideops_mindframe';
  const SCHEMA_VERSION = 1;
  const SAVE_DELAY_MS = 600;
  const VIEW_SAVE_DELAY_MS = 800;
  const BACKUP_ALERT_DAYS = 7;
  const DAY_MS = 86400000;
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const IMPORT_MAX_BYTES = 200 * 1024 * 1024;
  const MAX_NODES = 3000;       // 1ボードのノード上限（これ以上は動作が重くなるため）
  const MAX_EDGES = 5000;
  const MAX_TEXT = 4000;        // 1ノードの文字数上限
  const HISTORY_MAX = 100;      // 元に戻せる回数
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 4;
  const COORD_LIMIT = 200000;   // 座標の上限（壊れたデータで画面が飛ばないように）
  const GRID = 20;
  const ID_PATTERN = /^[A-Za-z0-9_\-]{1,80}$/;
  const FONT_STACK = "'IBM Plex Sans JP', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif";
  const CLIP_MIME = 'application/x-sideops-mindframe';
  const SVGNS = 'http://www.w3.org/2000/svg';

  const KINDS = { mindmap: 'マインドマップ', flow: 'フローチャート', ui: 'UIラフ', free: '自由' };
  const NODE_TYPES = ['topic', 'shape', 'sticky', 'text', 'frame', 'ui', 'image'];
  const TYPE_LABEL = { topic: 'トピック', shape: '図形', sticky: '付箋', text: 'テキスト', frame: '画面フレーム', ui: 'UI部品', image: '画像' };
  const LAYOUTS = ['both', 'right', 'down'];
  const LAYOUT_LABEL = { right: '右', both: '左右', down: '下' };
  const ROUTES = ['elbow', 'straight', 'curve'];
  const ROUTE_LABEL = { straight: '直線', elbow: 'カギ線', curve: '曲線' };
  const ARROWS = ['end', 'none', 'start', 'both'];
  const ARROW_LABEL = { none: 'なし', end: '終点', start: '始点', both: '両方' };
  const SIDES = ['a', 't', 'r', 'b', 'l'];
  const FS_LIST = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];

  /* ---- 色（本体テーマに追従する3色＋固定色） ---- */
  const COLOR_KEYS = ['default', 'cyan', 'magenta', 'amber', 'green', 'blue', 'violet', 'gray'];
  const COLOR_LABEL = { default: '標準', cyan: 'シアン', magenta: 'マゼンタ', amber: 'アンバー', green: 'グリーン', blue: 'ブルー', violet: 'バイオレット', gray: 'グレー' };
  const FIXED_COLORS = { green: '#3ccf8e', blue: '#4b8dff', violet: '#a07cff', gray: '#8795a1' };
  const STICKY_KEYS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];
  const STICKY_COLORS = { yellow: '#ffe07a', pink: '#ffb3c7', blue: '#a9d4ff', green: '#b5ecb0', orange: '#ffc98f', purple: '#d6c1ff' };
  const STICKY_LABEL = { yellow: '黄', pink: 'ピンク', blue: '水色', green: '緑', orange: 'オレンジ', purple: '紫' };
  const STICKY_INK = '#1d232a';
  const BRANCH_ORDER = ['cyan', 'magenta', 'amber', 'green', 'blue', 'violet'];
  // 「白地」で書き出すときの配色（テーマに関係なく印刷向けの色にする）
  const LIGHT_BASE = {
    bg: '#ffffff', bgAlt: '#f5f7f9', panel: '#ffffff', panelHi: '#eef2f5', line: '#d3dae0', lineSoft: '#e6ebef',
    text: '#1b2229', textDim: '#44515c', textFaint: '#8793a0', cyan: '#00a08c', magenta: '#d81f5a', amber: '#c77f00',
  };
  const DARK_BASE = {
    bg: '#05070a', bgAlt: '#070b10', panel: '#0e1620', panelHi: '#121d29', line: '#1e3038', lineSoft: '#14212a',
    text: '#f5f9fa', textDim: '#b8c4cc', textFaint: '#5c6b73', cyan: '#00f0d0', magenta: '#ff2f6e', amber: '#ffb020',
  };

  /* ---- 画面フレームの大きさ ---- */
  const FRAME_DEVICES = {
    phone: { label: 'スマホ', w: 390, h: 844, r: 12 },  // 角丸は小さめ（中のヘッダー等の角がはみ出して見えないように）
    tablet: { label: 'タブレット', w: 820, h: 1180, r: 10 },
    pc: { label: 'PC', w: 1440, h: 900, r: 0 },
    free: { label: '自由（ドラッグで大きさ）', w: 640, h: 400, r: 0 },
  };
  const FRAME_ORDER = ['phone', 'tablet', 'pc', 'free'];

  /* =====================================================================
     小さな道具
  ===================================================================== */
  const $ = (id) => document.getElementById(id);
  const f2 = (v) => Math.round(v * 100) / 100;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad = (n) => String(n).padStart(2, '0');
  function stamp(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
  function dateStamp(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
  function formatDateTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function safeFileName(s, fallback) {
    const map = { '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜' };
    const v = String(s || '').replace(/[\/\\:*?"<>|]/g, (c) => map[c]).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    return v || fallback;
  }
  function norm(s) { return String(s || '').normalize('NFKC').toLowerCase(); }

  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function randomChars(n) {
    let out = '';
    if (window.crypto && crypto.getRandomValues) {
      const arr = new Uint32Array(n);
      crypto.getRandomValues(arr);
      arr.forEach((v) => { out += ID_CHARS[v % ID_CHARS.length]; });
    } else {
      for (let i = 0; i < n; i++) out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    }
    return out;
  }

  let toastTimer = null;
  function toast(msg, level) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('is-error', level === 'error');
    el.classList.toggle('is-warn', level === 'warn');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), level ? 4200 : 2400);
  }

  async function copyText(text) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
    } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    toast(ok ? 'コピーしました' : 'コピーできませんでした。手動で選択してコピーしてください', ok ? undefined : 'error');
    return ok;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // DOM を組み立てる小さな関数（表示する文字は textContent でのみ入れる）
  function h(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style') e.setAttribute('style', v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'title' || k === 'type' || k === 'min' || k === 'max' || k === 'step') e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach((x) => { if (x != null && x !== false) e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => { const v = attrs[k]; if (v != null && v !== false) e.setAttribute(k, v); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function icon(name) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'ic');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }

  /* =====================================================================
     IndexedDB（IndexedDB実装パターン_仕様書 に準拠）
     DB: sideops_mindframe（v1）
       boards : { id(mf_), title, kind, nodes[], edges[], settings{grid,snap,guides}, createdAt, updatedAt }
       images : { id(im_), boardId, blob, type, name, w, h, createdAt }
       views  : { id(=boardId), x, y, zoom }   … 最後に見ていた位置（書き出しには含めない）
       meta   : { id, value }                   … lastFullExportAt・prefs
  ===================================================================== */
  let db = null;
  let dbReady = false;
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB を利用できません')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const _db = ev.target.result;
        Object.values(S).forEach((name) => {
          if (!_db.objectStoreNames.contains(name)) _db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => {
        const _db = req.result;
        _db.onversionchange = () => _db.close(); // 他のタブの更新を妨げない
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('他のタブがDBを開いているため更新できません'));
    });
  }
  function store(name, mode) { return db.transaction(name, mode).objectStore(name); }
  function dbGetAll(name) {
    return new Promise((resolve, reject) => {
      const req = store(name, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function dbGet(name, id) {
    return new Promise((resolve, reject) => {
      const req = store(name, 'readonly').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  function dbPut(name, value) {
    return new Promise((resolve, reject) => {
      const req = store(name, 'readwrite').put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function dbDel(name, id) {
    return new Promise((resolve, reject) => {
      const req = store(name, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDelSafe(name, id) {
    try { await dbDel(name, id); return true; } catch (err) { console.error('削除に失敗しました', name, id, err); return false; }
  }

  /* =====================================================================
     色（パレット）
     テーマの CSS 変数を読み、実際の色コードに解決して描画する。
     テーマが変わったら（sideops:themechange）読み直して全体を描き直す。
  ===================================================================== */
  function parseColor(s) {
    const v = String(s || '').trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(v);
    if (m) {
      let hx = m[1];
      if (hx.length === 3 || hx.length === 4) hx = hx.slice(0, 3).split('').map((c) => c + c).join('');
      hx = hx.slice(0, 6);
      if (hx.length !== 6) return null;
      const n = parseInt(hx, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(v);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((x) => clamp(x, 0, 255));
    m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((x) => clamp(x, 0, 255));
    return null;
  }
  const mixRgb = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  const rgbCss = (c, alpha) => (alpha == null || alpha >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`);
  const luminance = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

  function makePalette(base) {
    const P = {};
    Object.keys(DARK_BASE).forEach((k) => { P[k] = parseColor(base[k]) || parseColor(DARK_BASE[k]); });
    P.light = luminance(P.bg) > 0.5;
    P.ink = mixRgb(P.textFaint, P.textDim, 0.45);       // 標準の線の色
    P.edge = mixRgb(P.textFaint, P.textDim, 0.6);       // 標準の矢印の色
    P.shadow = P.light ? 'rgba(60,75,85,.18)' : 'rgba(0,0,0,.35)';
    return P;
  }
  let pal = makePalette(DARK_BASE);
  let palVersion = 0;
  function refreshPalette() {
    const cs = getComputedStyle(document.documentElement);
    const read = (name) => cs.getPropertyValue(name).trim();
    pal = makePalette({
      bg: read('--bg'), bgAlt: read('--bg-alt'), panel: read('--panel'), panelHi: read('--panel-hi'),
      line: read('--line'), lineSoft: read('--line-soft'), text: read('--text'), textDim: read('--text-dim'),
      textFaint: read('--text-faint'), cyan: read('--cyan'), magenta: read('--magenta'), amber: read('--amber'),
    });
    palVersion++;
  }
  // 色キー → RGB 配列
  function colorRgb(key, P) {
    if (key === 'cyan' || key === 'magenta' || key === 'amber') return P[key];
    if (FIXED_COLORS[key]) return parseColor(FIXED_COLORS[key]);
    return P.ink;
  }
  function onColor(c) { return luminance(c) > 0.55 ? '#0b0f14' : '#ffffff'; }

  /* =====================================================================
     文字の計測と折り返し（画面・書き出しで同じ結果になるよう、ここで1回だけ決める）
  ===================================================================== */
  const measureCtx = document.createElement('canvas').getContext('2d');
  const widthCache = new Map();
  const fontStr = (fs, bold) => `${bold ? 700 : 400} ${fs}px ${FONT_STACK}`;
  const lineH = (fs) => Math.round(fs * 1.45);
  function textWidth(s, fs, bold) {
    const key = (bold ? 'b' : 'n') + fs + '|' + s;
    let w = widthCache.get(key);
    if (w == null) {
      measureCtx.font = fontStr(fs, bold);
      w = measureCtx.measureText(s).width;
      if (widthCache.size > 30000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  }
  // 英数字の連続は1語、空白は1語、それ以外（日本語など）は1文字ずつ
  const TOKEN_RE = /[A-Za-z0-9À-ɏ_'’\-.,:;!?@#$%&*+=/\\~^()[\]{}<>"|]+|\s+|[\s\S]/gu;
  // 行頭に来てはいけない文字（前の行にぶら下げる）
  const NO_LINE_START = /^[、。，．,.)\]）」』】〉》〕｝!?！？ー・：；:;ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…‥]$/;
  function wrapText(text, maxW, fs, bold) {
    const lines = [];
    String(text == null ? '' : text).split('\n').forEach((para) => {
      let line = '', w = 0, wrapped = false;
      const push = () => { lines.push(line.replace(/\s+$/, '')); line = ''; w = 0; wrapped = true; };
      const toks = para.match(TOKEN_RE) || [];
      for (const tok of toks) {
        const isSpace = /^\s+$/.test(tok);
        if (wrapped && !line && isSpace) continue; // 折り返した行頭の空白は捨てる
        const tw = textWidth(tok, fs, bold);
        if (w + tw <= maxW + 0.5) { line += tok; w += tw; continue; }
        if (isSpace) { push(); continue; }
        if (line && NO_LINE_START.test(tok)) { line += tok; w += tw; push(); continue; }
        if (line) push();
        if (tw <= maxW + 0.5) { line = tok; w = tw; continue; }
        for (const ch of Array.from(tok)) { // 1語が幅を超える：1文字ずつ割る
          const cw = textWidth(ch, fs, bold);
          if (w + cw > maxW + 0.5 && line) push();
          line += ch; w += cw;
        }
      }
      if (line || !wrapped) lines.push(line.replace(/\s+$/, ''));
    });
    return lines;
  }
  function linesWidth(lines, fs, bold) {
    let m = 0;
    lines.forEach((l) => { m = Math.max(m, textWidth(l, fs, bold)); });
    return m;
  }
  function fitLine(s, maxW, fs, bold) { // 1行に収まらなければ … で切る
    if (textWidth(s, fs, bold) <= maxW) return s;
    const chars = Array.from(s);
    while (chars.length && textWidth(chars.join('') + '…', fs, bold) > maxW) chars.pop();
    return chars.join('') + '…';
  }

  /* =====================================================================
     図形の定義（フローチャート）
     path(w,h)：輪郭、deco(w,h)：飾り線、box(w,h)：文字の入る範囲、anchor：接続点の補正
  ===================================================================== */
  function rrPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r < 0.5) return `M${f2(x)},${f2(y)}H${f2(x + w)}V${f2(y + h)}H${f2(x)}Z`;
    return `M${f2(x + r)},${f2(y)}H${f2(x + w - r)}A${f2(r)},${f2(r)} 0 0 1 ${f2(x + w)},${f2(y + r)}V${f2(y + h - r)}A${f2(r)},${f2(r)} 0 0 1 ${f2(x + w - r)},${f2(y + h)}H${f2(x + r)}A${f2(r)},${f2(r)} 0 0 1 ${f2(x)},${f2(y + h - r)}V${f2(y + r)}A${f2(r)},${f2(r)} 0 0 1 ${f2(x + r)},${f2(y)}Z`;
  }
  function ellipsePath(cx, cy, rx, ry) {
    return `M${f2(cx - rx)},${f2(cy)}A${f2(rx)},${f2(ry)} 0 1 0 ${f2(cx + rx)},${f2(cy)}A${f2(rx)},${f2(ry)} 0 1 0 ${f2(cx - rx)},${f2(cy)}Z`;
  }
  const polyPath = (pts) => 'M' + pts.map((p) => f2(p[0]) + ',' + f2(p[1])).join('L') + 'Z';
  const linePath = (x1, y1, x2, y2) => `M${f2(x1)},${f2(y1)}L${f2(x2)},${f2(y2)}`;
  const paraSkew = (w, h) => Math.min(h * 0.35, w * 0.2);
  const hexK = (w, h) => Math.min(h * 0.32, w * 0.2);
  const cylRy = (w, h) => Math.min(h * 0.14, w * 0.18, 14);
  const docWave = (h) => h * 0.12;

  const SHAPES = {
    rect: { label: '処理', w: 150, h: 64, path: (w, h) => rrPath(0, 0, w, h, 2) },
    round: { label: '角丸', w: 150, h: 64, path: (w, h) => rrPath(0, 0, w, h, Math.min(14, h / 2)) },
    pill: { label: '端子（開始・終了）', w: 140, h: 52, path: (w, h) => rrPath(0, 0, w, h, Math.min(w, h) / 2), box: (w, h) => ({ x: Math.min(w, h) * 0.35, y: 4, w: w - Math.min(w, h) * 0.7, h: h - 8 }) },
    diamond: { label: '判断', w: 160, h: 96, path: (w, h) => polyPath([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), box: (w, h) => ({ x: w * 0.2, y: h * 0.2, w: w * 0.6, h: h * 0.6 }) },
    para: {
      label: '入出力', w: 160, h: 64,
      path: (w, h) => { const k = paraSkew(w, h); return polyPath([[k, 0], [w, 0], [w - k, h], [0, h]]); },
      box: (w, h) => { const k = paraSkew(w, h); return { x: k + 4, y: 4, w: w - k * 2 - 8, h: h - 8 }; },
      anchor: (w, h, side, p) => { const k = paraSkew(w, h); if (side === 'l') p.x += k / 2; if (side === 'r') p.x -= k / 2; return p; },
    },
    doc: {
      label: '書類', w: 150, h: 76,
      path: (w, h) => { const a = docWave(h); return `M0,0H${f2(w)}V${f2(h - a)}C${f2(w * 0.72)},${f2(h - a * 2.6)} ${f2(w * 0.28)},${f2(h + a * 0.6)} 0,${f2(h - a)}Z`; },
      box: (w, h) => ({ x: 8, y: 6, w: w - 16, h: h - docWave(h) * 1.6 - 8 }),
      anchor: (w, h, side, p) => { if (side === 'b') p.y -= docWave(h); return p; },
    },
    cyl: {
      label: 'データベース', w: 120, h: 88,
      path: (w, h) => { const r = cylRy(w, h); return `M0,${f2(r)}A${f2(w / 2)},${f2(r)} 0 0 1 ${f2(w)},${f2(r)}V${f2(h - r)}A${f2(w / 2)},${f2(r)} 0 0 1 0,${f2(h - r)}Z`; },
      deco: (w, h) => { const r = cylRy(w, h); return `M0,${f2(r)}A${f2(w / 2)},${f2(r)} 0 0 0 ${f2(w)},${f2(r)}`; },
      box: (w, h) => { const r = cylRy(w, h); return { x: 6, y: r * 2 + 2, w: w - 12, h: h - r * 3 - 4 }; },
    },
    sub: {
      label: '定義済み処理', w: 160, h: 64, path: (w, h) => rrPath(0, 0, w, h, 2),
      deco: (w, h) => { const k = Math.min(12, w * 0.1); return linePath(k, 0, k, h) + linePath(w - k, 0, w - k, h); },
      box: (w, h) => { const k = Math.min(12, w * 0.1); return { x: k + 6, y: 4, w: w - k * 2 - 12, h: h - 8 }; },
    },
    hex: {
      label: '準備', w: 160, h: 64,
      path: (w, h) => { const k = hexK(w, h); return polyPath([[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]); },
      box: (w, h) => { const k = hexK(w, h); return { x: k * 0.7, y: 4, w: w - k * 1.4, h: h - 8 }; },
    },
    ellipse: { label: '円', w: 96, h: 96, path: (w, h) => ellipsePath(w / 2, h / 2, w / 2, h / 2), box: (w, h) => ({ x: w * 0.15, y: h * 0.15, w: w * 0.7, h: h * 0.7 }) },
  };
  const SHAPE_ORDER = ['rect', 'round', 'pill', 'diamond', 'para', 'doc', 'cyl', 'sub', 'hex', 'ellipse'];
  const shapeBox = (n) => (SHAPES[n.shape].box ? SHAPES[n.shape].box(n.w, n.h) : { x: 8, y: 4, w: n.w - 16, h: n.h - 8 });

  /* =====================================================================
     UI部品（画面の検討用）
     render(n, c) は部品の中身の表示リストを返す。c は色などの計算済みの値
  ===================================================================== */
  const splitItems = (t, fallback) => { const a = String(t || '').split(/\||\n/).map((s) => s.trim()); const r = a.filter((s, i) => s || i < a.length - 1); return r.length ? r : fallback; };
  const UI_KIT = {
    button: { label: 'ボタン', w: 140, h: 44, text: 'ボタン', color: 'cyan', fill: 'solid', stroke: 'none', bold: true },
    input: { label: '入力欄', w: 280, h: 44, text: '入力してください', align: 'left' },
    search: { label: '検索バー', w: 280, h: 40, text: '検索', align: 'left' },
    select: { label: 'プルダウン', w: 280, h: 44, text: '選択してください', align: 'left' },
    checkbox: { label: 'チェック', w: 180, h: 24, text: 'チェック項目', align: 'left', toggle: true },
    radio: { label: 'ラジオ', w: 180, h: 24, text: '選択肢', align: 'left', toggle: true },
    toggle: { label: 'スイッチ', w: 200, h: 28, text: '通知を受け取る', align: 'left', toggle: true },
    slider: { label: 'スライダー', w: 240, h: 24, text: '' },
    tabs: { label: 'タブ', w: 300, h: 40, text: 'タブA|タブB|タブC', toggle: true },
    image: { label: '画像枠', w: 240, h: 160, text: '' },
    card: { label: 'カード', w: 240, h: 230, text: 'カードのタイトル\n説明文が入ります。', align: 'left' },
    list: { label: 'リスト', w: 300, h: 150, text: '項目1\n項目2\n項目3', align: 'left' },
    avatar: { label: 'アバター', w: 48, h: 48, text: '' },
    icon: { label: 'アイコン', w: 36, h: 36, text: '' },
    badge: { label: 'バッジ', w: 64, h: 24, text: 'NEW', color: 'magenta', fill: 'solid', stroke: 'none', fs: 12, bold: true },
    divider: { label: '区切り線', w: 300, h: 16, text: '' },
    lines: { label: '文章ダミー', w: 300, h: 76, text: '' },
    navbar: { label: 'ヘッダー', w: 390, h: 56, text: 'タイトル', align: 'left', bold: true },
    tabbar: { label: 'タブバー', w: 390, h: 64, text: 'ホーム|検索|通知|設定', toggle: true },
  };
  const UI_ORDER = ['button', 'input', 'search', 'select', 'checkbox', 'radio', 'toggle', 'slider', 'tabs', 'image', 'card', 'list', 'avatar', 'icon', 'badge', 'divider', 'lines', 'navbar', 'tabbar'];
  const UI_TEXT_PRESETS = {
    heading: { label: '見出し', w: 320, text: '見出し', fs: 24, bold: true },
    body: { label: '本文', w: 320, text: '本文のテキストが入ります。', fs: 14, bold: false },
  };
  // 文字を持たない（ダブルクリックで編集しない）UI部品
  const UI_NO_TEXT = ['slider', 'avatar', 'divider', 'lines'];

  /* ---- 新規ボード（はじめ方） ---- */
  const TEMPLATES = [
    { key: 'mindmap', label: 'マインドマップ', desc: '中心のテーマから枝を広げる', kind: 'mindmap' },
    { key: 'flow', label: 'フローチャート', desc: '開始→処理→終了のひな形', kind: 'flow' },
    { key: 'ui-phone', label: 'UIラフ（スマホ）', desc: 'スマホ画面のフレームと部品', kind: 'ui' },
    { key: 'ui-pc', label: 'UIラフ（PC）', desc: 'PC画面のフレームと部品', kind: 'ui' },
    { key: 'blank', label: '白紙', desc: '何もない所から自由に', kind: 'free' },
    { key: 'text', label: 'テキストから作成', desc: '箇条書き・Mermaid・AIの出力を貼る', kind: '' },
  ];

  /* ---- 外部AIに貼る依頼文（{{テーマ}} を差し込む） ---- */
  const AI_PROMPTS = {
    mind: '次のテーマについてマインドマップを作ります。\n' +
      '中心テーマを1行目に「- 」で書き、関連する項目をインデント付きの箇条書きで出力してください。\n' +
      '- 階層は半角スペース2つで字下げする\n' +
      '- 1項目は短い言葉（20字程度まで）にする\n' +
      '- 3〜4階層、全体で20〜40項目を目安にする\n' +
      '- 前置き・説明・コードブロックは書かない\n\n' +
      'テーマ：{{テーマ}}',
    flow: '次の内容をフローチャートにしたいので、Mermaid の flowchart TD 形式で出力してください。\n' +
      '- 開始・終了は ([ ])、処理は [ ]、判断（分岐）は { } を使う\n' +
      '- 分岐の線には -->|はい| のようにラベルを付ける\n' +
      '- ノードの文字は短く（15字程度まで）する\n' +
      '- 説明文は書かず、Mermaid のコードだけを出力する\n\n' +
      '内容：{{テーマ}}',
  };

  /* =====================================================================
     データの正規化（読み込み時・インポート時・貼り付け時に必ず通す）
  ===================================================================== */
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const numIn = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : def);
  const ts = (v) => (typeof v === 'number' && isFinite(v) && v > 946684800000 && v < 4102444800000 ? v : Date.now()); // 2000〜2100年以外は不正
  const validId = (v) => typeof v === 'string' && ID_PATTERN.test(v);
  const coord = (v) => numIn(v, -COORD_LIMIT, COORD_LIMIT, 0);

  function normalizeStyle(s, type) {
    const o = {};
    if (!s || typeof s !== 'object') return o;
    const colors = type === 'sticky' ? STICKY_KEYS : COLOR_KEYS;
    if (colors.includes(s.color)) o.color = s.color;
    if (['tint', 'solid', 'none'].includes(s.fill)) o.fill = s.fill;
    if (['solid', 'dashed', 'dotted', 'none'].includes(s.stroke)) o.stroke = s.stroke;
    if ([1, 2, 3, 4].includes(s.sw)) o.sw = s.sw;
    if (FS_LIST.includes(s.fs)) o.fs = s.fs;
    if (typeof s.bold === 'boolean') o.bold = s.bold;
    if (['left', 'center', 'right'].includes(s.align)) o.align = s.align;
    if (typeof s.opacity === 'number' && s.opacity >= 0.1 && s.opacity <= 1) o.opacity = Math.round(s.opacity * 100) / 100;
    return o;
  }
  function normalizeNode(x) {
    if (!x || typeof x !== 'object' || !validId(x.id) || !NODE_TYPES.includes(x.type)) return null;
    const n = {
      id: x.id, type: x.type, x: coord(x.x), y: coord(x.y),
      w: numIn(x.w, 4, 20000, 120), h: numIn(x.h, 4, 20000, 60),
      text: str(x.text, MAX_TEXT), style: normalizeStyle(x.style, x.type), locked: x.locked === true,
    };
    if (n.type === 'shape') n.shape = SHAPES[x.shape] ? x.shape : 'rect';
    else if (n.type === 'ui') { n.ui = UI_KIT[x.ui] ? x.ui : 'button'; n.on = x.on !== false; }
    else if (n.type === 'topic') {
      n.parent = validId(x.parent) ? x.parent : null;
      n.order = numIn(x.order, -1e9, 1e9, 0);
      n.collapsed = x.collapsed === true;
      n.layout = LAYOUTS.includes(x.layout) ? x.layout : 'both';
      n.side = x.side === 'l' || x.side === 'r' ? x.side : '';
    } else if (n.type === 'frame') n.device = FRAME_DEVICES[x.device] ? x.device : 'free';
    else if (n.type === 'image') {
      n.imageId = validId(x.imageId) ? x.imageId : '';
      n.iw = numIn(x.iw, 1, 100000, n.w);
      n.ih = numIn(x.ih, 1, 100000, n.h);
    }
    return n;
  }
  function normalizeEnd(e) {
    if (!e || typeof e !== 'object') return null;
    if (validId(e.node)) return { node: e.node, side: SIDES.includes(e.side) ? e.side : 'a' };
    if (typeof e.x === 'number' && typeof e.y === 'number' && isFinite(e.x) && isFinite(e.y)) return { x: coord(e.x), y: coord(e.y) };
    return null;
  }
  function normalizeEdge(x) {
    if (!x || typeof x !== 'object' || !validId(x.id)) return null;
    const from = normalizeEnd(x.from), to = normalizeEnd(x.to);
    if (!from || !to) return null;
    const s = x.style && typeof x.style === 'object' ? x.style : {};
    const style = {};
    if (COLOR_KEYS.includes(s.color)) style.color = s.color;
    if (['solid', 'dashed', 'dotted'].includes(s.stroke)) style.stroke = s.stroke;
    if ([1, 2, 3, 4].includes(s.sw)) style.sw = s.sw;
    return {
      id: x.id, from, to,
      route: ROUTES.includes(x.route) ? x.route : 'elbow',
      arrow: ARROWS.includes(x.arrow) ? x.arrow : 'end',
      label: str(x.label, 500), style,
    };
  }
  function normalizeBoard(x) {
    if (!x || typeof x !== 'object' || !validId(x.id)) return null;
    const nodes = [];
    const ids = new Set();
    (Array.isArray(x.nodes) ? x.nodes : []).forEach((r) => {
      if (nodes.length >= MAX_NODES) return;
      const n = normalizeNode(r);
      if (n && !ids.has(n.id)) { ids.add(n.id); nodes.push(n); }
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // トピックの親：存在しない・トピックでない・循環している場合は切り離す
    nodes.forEach((n) => {
      if (n.type !== 'topic' || !n.parent) return;
      const p = byId.get(n.parent);
      if (!p || p.type !== 'topic' || p === n) n.parent = null;
    });
    nodes.forEach((n) => {
      if (n.type !== 'topic') return;
      const seen = new Set([n.id]);
      let p = n.parent ? byId.get(n.parent) : null;
      while (p) {
        if (seen.has(p.id)) { n.parent = null; break; }
        seen.add(p.id);
        p = p.parent ? byId.get(p.parent) : null;
      }
    });
    const edges = [];
    (Array.isArray(x.edges) ? x.edges : []).forEach((r) => {
      if (edges.length >= MAX_EDGES) return;
      const e = normalizeEdge(r);
      if (!e || ids.has(e.id)) return;
      if ((e.from.node && !byId.has(e.from.node)) || (e.to.node && !byId.has(e.to.node))) return;
      ids.add(e.id);
      edges.push(e);
    });
    const st = x.settings && typeof x.settings === 'object' ? x.settings : {};
    return {
      id: x.id, title: str(x.title, 100), kind: KINDS[x.kind] ? x.kind : 'free', nodes, edges,
      settings: { grid: st.grid !== false, snap: st.snap === true, guides: st.guides !== false },
      createdAt: ts(x.createdAt), updatedAt: ts(x.updatedAt),
    };
  }

  /* ---- ID ---- */
  // ボード・画像：<接頭辞>_YYYYMMDD_HHMMSS_<英数4桁>。作成時に1回だけ発行し、エクスポート・インポートでも変えない
  function genId(prefix, used) {
    for (let i = 0; i < 100; i++) {
      const id = `${prefix}_${stamp(new Date())}_${randomChars(4)}`;
      if (!used || !used.has(id)) return id;
    }
    throw new Error('IDを発行できませんでした');
  }
  // ノード・線：ボードの中で一意な短いID
  function localId(prefix, used) {
    for (let i = 0; i < 100; i++) {
      const id = prefix + '_' + randomChars(8);
      if (!used.has(id)) { used.add(id); return id; }
    }
    throw new Error('IDを発行できませんでした');
  }

  /* =====================================================================
     マインドマップ（トピックの木）の配置
     根（中心トピック）の位置だけを保存し、子の位置・大きさは毎回ここで計算する。
     T：木の情報（深さ・枝の色・伸びる向き・折りたたみで隠れているもの）
  ===================================================================== */
  const H_GAP = 44, V_GAP = 12, D_HGAP = 22, D_VGAP = 44;
  function emptyTree() {
    return { kids: new Map(), depth: new Map(), root: new Map(), branch: new Map(), dir: new Map(), hidden: new Set(), hiddenCount: new Map(), lines: new Map() };
  }
  function topicMetrics(n, depth) {
    const fs = n.style.fs || (depth === 0 ? 18 : depth === 1 ? 15 : 13);
    const bold = n.style.bold != null ? n.style.bold : depth <= 1;
    return {
      fs, bold, maxW: depth === 0 ? 300 : 260,
      padX: depth === 0 ? 18 : depth === 1 ? 14 : 10,
      padY: depth === 0 ? 11 : depth === 1 ? 8 : 6,
      r: depth === 0 ? 10 : depth === 1 ? 7 : 5,
    };
  }
  function sizeTopic(n, depth, T) {
    const m = topicMetrics(n, depth);
    const lines = wrapText(n.text, m.maxW, m.fs, m.bold);
    T.lines.set(n.id, lines);
    const tw = Math.max(linesWidth(lines, m.fs, m.bold), m.fs * 1.5);
    n.w = Math.ceil(tw + m.padX * 2);
    n.h = Math.ceil(lines.length * lineH(m.fs) + m.padY * 2);
  }
  function childDir(n, T) {
    if (!n.parent) return n.layout === 'down' ? 'd' : n.layout === 'right' ? 'r' : 'b';
    return T.dir.get(n.id) || 'r';
  }
  // テキストノードは幅だけ持ち、高さは文字から決める
  function sizeText(n) {
    const fs = n.style.fs || 14;
    const lines = wrapText(n.text, Math.max(8, n.w), fs, !!n.style.bold);
    n.h = Math.max(lineH(fs), lines.length * lineH(fs)) + 4;
  }

  function layoutNodes(nodes) {
    const T = emptyTree();
    const topics = [];
    nodes.forEach((n) => {
      if (n.type === 'topic') topics.push(n);
      else if (n.type === 'text') sizeText(n);
    });
    topics.forEach((n) => {
      if (!n.parent) return;
      if (!T.kids.has(n.parent)) T.kids.set(n.parent, []);
      T.kids.get(n.parent).push(n);
    });
    T.kids.forEach((arr) => arr.sort((a, b) => a.order - b.order));
    topics.forEach((root) => { if (!root.parent) layoutTree(root, T); });
    return T;
  }

  function layoutTree(root, T) {
    const kidsOf = (n) => T.kids.get(n.id) || [];
    const vis = (n) => (n.collapsed ? [] : kidsOf(n));
    // 1) 大きさ・深さ・隠れ状態・枝の色
    const visit = (n, depth, hidden, branch) => {
      T.depth.set(n.id, depth);
      T.root.set(n.id, root.id);
      if (hidden) T.hidden.add(n.id);
      if (depth === 0) {
        const cx = n.x + n.w / 2, cy = n.y + n.h / 2; // 中心を保ったまま大きさを変える
        sizeTopic(n, 0, T);
        n.x = cx - n.w / 2; n.y = cy - n.h / 2;
      } else sizeTopic(n, depth, T);
      T.branch.set(n.id, branch);
      let count = 0;
      kidsOf(n).forEach((c, k) => {
        const b = c.style.color || (depth === 0 ? BRANCH_ORDER[k % BRANCH_ORDER.length] : branch);
        count += 1 + visit(c, depth + 1, hidden || n.collapsed, b);
      });
      if (n.collapsed && count) T.hiddenCount.set(n.id, count);
      return count;
    };
    visit(root, 0, false, root.style.color || 'cyan');

    // 2) 位置
    if (root.layout === 'down') {
      const sw = new Map();
      const subW = (n) => {
        const ch = vis(n);
        let w = n.w;
        if (ch.length) w = Math.max(w, ch.reduce((a, c) => a + subW(c), 0) + D_HGAP * (ch.length - 1));
        sw.set(n.id, w);
        return w;
      };
      subW(root);
      const place = (n, cx, y) => {
        n.x = cx - n.w / 2; n.y = y;
        const ch = vis(n);
        if (!ch.length) return;
        const total = ch.reduce((a, c) => a + sw.get(c.id), 0) + D_HGAP * (ch.length - 1);
        let x = cx - total / 2;
        ch.forEach((c) => {
          const w = sw.get(c.id);
          T.dir.set(c.id, 'd');
          place(c, x + w / 2, y + n.h + D_VGAP);
          x += w + D_HGAP;
        });
      };
      place(root, root.x + root.w / 2, root.y);
      return;
    }
    const sh = new Map();
    const subH = (n) => {
      const ch = vis(n);
      let hh = n.h;
      if (ch.length) hh = Math.max(hh, ch.reduce((a, c) => a + subH(c), 0) + V_GAP * (ch.length - 1));
      sh.set(n.id, hh);
      return hh;
    };
    subH(root);
    const placeGroup = (parent, group, sign) => {
      if (!group.length) return;
      const total = group.reduce((a, c) => a + sh.get(c.id), 0) + V_GAP * (group.length - 1);
      let y = parent.y + parent.h / 2 - total / 2;
      group.forEach((c) => {
        const hh = sh.get(c.id);
        c.y = y + hh / 2 - c.h / 2;
        c.x = sign > 0 ? parent.x + parent.w + H_GAP : parent.x - H_GAP - c.w;
        T.dir.set(c.id, sign > 0 ? 'r' : 'l');
        placeGroup(c, vis(c), sign);
        y += hh + V_GAP;
      });
    };
    if (root.layout === 'right') { placeGroup(root, vis(root), 1); return; }
    // 左右：明示された側を優先し、残りは右から順に高さの半分まで詰めて振り分ける
    const ch = vis(root);
    const right = [], left = [];
    const grand = ch.reduce((a, c) => a + sh.get(c.id), 0);
    let rightH = ch.filter((c) => c.side === 'r').reduce((a, c) => a + sh.get(c.id), 0);
    ch.forEach((c) => {
      if (c.side === 'r') right.push(c);
      else if (c.side === 'l') left.push(c);
      else if (rightH < grand / 2) { right.push(c); rightH += sh.get(c.id); }
      else left.push(c);
    });
    placeGroup(root, right, 1);
    placeGroup(root, left, -1);
  }

  /* =====================================================================
     表示リスト（見た目の唯一の定義）
       { k:'path', d, fill, stroke, sw, dash, op }
       { k:'text', x, y, lines, fs, bold, color, align, lh, op }   … y は1行目の行ボックス上端
       { k:'image', x, y, w, h, src, op }
       { k:'g', x, y, items }                                       … 平行移動したまとまり
  ===================================================================== */
  function styleOf(n, key) {
    const v = n.style[key];
    if (v != null) return v;
    if (n.type === 'ui') {
      const kit = UI_KIT[n.ui];
      if (key === 'color') return kit.color || 'default';
      if (key === 'fill') return kit.fill || 'tint';
      if (key === 'stroke') return kit.stroke || 'solid';
      if (key === 'sw') return 1;
      if (key === 'fs') return kit.fs || 14;
      if (key === 'bold') return !!kit.bold;
      if (key === 'align') return kit.align || 'center';
    }
    switch (key) {
      case 'color': return n.type === 'sticky' ? 'yellow' : 'default';
      case 'fill': return 'tint';
      case 'stroke': return 'solid';
      case 'sw': return n.type === 'frame' ? 1 : 2;
      case 'fs': return 14;
      case 'bold': return false;
      case 'align': return n.type === 'text' || n.type === 'sticky' ? 'left' : 'center';
      case 'opacity': return 1;
      default: return null;
    }
  }
  // 塗り・線・文字の色をまとめて決める
  function colorsOf(n, P) {
    const key = styleOf(n, 'color');
    const c = colorRgb(key, P);
    const fillMode = styleOf(n, 'fill');
    let fill = null, text = rgbCss(P.text);
    if (fillMode === 'solid') { fill = rgbCss(c); text = onColor(c); }
    else if (fillMode === 'tint') fill = key === 'default' ? rgbCss(P.panel) : rgbCss(mixRgb(P.bg, c, 0.16));
    const strokeMode = styleOf(n, 'stroke');
    return {
      c, fill, text, faint: rgbCss(P.textFaint), dim: rgbCss(P.textDim),
      stroke: strokeMode === 'none' ? null : rgbCss(c), dash: strokeMode, sw: styleOf(n, 'sw'),
    };
  }
  function textPrim(lines, box, o) {
    const lh = lineH(o.fs);
    const blockH = lines.length * lh;
    const y = o.valign === 'top' ? box.y : box.y + (box.h - blockH) / 2;
    const align = o.align || 'center';
    const x = align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2;
    return { k: 'text', x, y, lines, fs: o.fs, bold: !!o.bold, color: o.color, align, lh };
  }
  function boxText(n, box, P, color, opts) {
    const o = opts || {};
    const fs = o.fs || styleOf(n, 'fs');
    const bold = o.bold != null ? o.bold : styleOf(n, 'bold');
    const lines = wrapText(o.text != null ? o.text : n.text, Math.max(8, box.w), fs, bold);
    return textPrim(lines, box, { fs, bold, color, align: o.align || styleOf(n, 'align'), valign: o.valign });
  }

  function topicPrims(n, P, T) {
    const depth = T.depth.get(n.id) || 0;
    const m = topicMetrics(n, depth);
    const bc = colorRgb(T.branch.get(n.id) || 'cyan', P);
    const fillMode = n.style.fill || (depth === 0 ? 'solid' : 'tint');
    let fill = null, text = rgbCss(P.text);
    if (fillMode === 'solid') { fill = rgbCss(bc); text = onColor(bc); }
    else if (fillMode === 'tint') fill = rgbCss(mixRgb(P.bg, bc, depth === 1 ? 0.18 : 0.08));
    const strokeMode = n.style.stroke || (depth === 0 ? 'none' : 'solid');
    const sw = n.style.sw || (depth === 1 ? 2 : 1);
    const out = [{ k: 'path', d: rrPath(0, 0, n.w, n.h, m.r), fill, stroke: strokeMode === 'none' ? null : rgbCss(bc), sw, dash: strokeMode }];
    const lines = T.lines.get(n.id) || wrapText(n.text, m.maxW, m.fs, m.bold);
    out.push(textPrim(lines, { x: m.padX, y: m.padY, w: n.w - m.padX * 2, h: n.h - m.padY * 2 }, { fs: m.fs, bold: m.bold, color: text, align: n.style.align || 'center' }));
    const hidden = T.hiddenCount.get(n.id);
    if (hidden) {
      const b = foldPoint(n, T);
      out.push({ k: 'path', d: ellipsePath(b.x, b.y, 10, 10), fill: rgbCss(P.bg), stroke: rgbCss(bc), sw: 1.5, dash: 'solid' });
      out.push(textPrim([String(Math.min(hidden, 999))], { x: b.x - 10, y: b.y - 10, w: 20, h: 20 }, { fs: 10, bold: true, color: rgbCss(P.text), align: 'center' }));
    }
    return out;
  }
  // 折りたたみの印の位置（ノード内の座標）
  function foldPoint(n, T) {
    const d = childDir(n, T);
    if (d === 'd') return { x: n.w / 2, y: n.h + 12 };
    if (d === 'l') return { x: -12, y: n.h / 2 };
    return { x: n.w + 12, y: n.h / 2 };
  }

  function shapePrims(n, P) {
    const c = colorsOf(n, P);
    const def = SHAPES[n.shape];
    const out = [{ k: 'path', d: def.path(n.w, n.h), fill: c.fill, stroke: c.stroke, sw: c.sw, dash: c.dash }];
    if (def.deco && c.stroke) out.push({ k: 'path', d: def.deco(n.w, n.h), fill: null, stroke: c.stroke, sw: c.sw, dash: c.dash });
    if (n.text) out.push(boxText(n, shapeBox(n), P, c.text));
    return out;
  }
  function stickyPrims(n, P) {
    const bg = STICKY_COLORS[styleOf(n, 'color')] || STICKY_COLORS.yellow;
    const out = [
      { k: 'path', d: rrPath(2, 4, n.w, n.h, 2), fill: P.shadow, stroke: null },
      { k: 'path', d: rrPath(0, 0, n.w, n.h, 2), fill: bg, stroke: null },
    ];
    if (n.text) out.push(boxText(n, { x: 12, y: 10, w: n.w - 24, h: n.h - 20 }, P, STICKY_INK, { valign: 'top' }));
    return out;
  }
  function textNodePrims(n, P) {
    if (!n.text) return [];
    const key = styleOf(n, 'color');
    const color = key === 'default' ? rgbCss(P.text) : rgbCss(colorRgb(key, P));
    return [boxText(n, { x: 0, y: 2, w: n.w, h: n.h - 4 }, P, color, { valign: 'top' })];
  }
  function framePrims(n, P) {
    const dev = FRAME_DEVICES[n.device] || FRAME_DEVICES.free;
    const key = styleOf(n, 'color');
    const stroke = key === 'default' ? mixRgb(P.line, P.textFaint, 0.55) : colorRgb(key, P);
    const fillMode = styleOf(n, 'fill');
    const fill = fillMode === 'none' ? null : fillMode === 'solid' ? rgbCss(P.panel) : rgbCss(mixRgb(P.bg, P.text, P.light ? 0.02 : 0.035));
    const title = fitLine(n.text || '（名前なし）', Math.max(20, n.w), 12, false);
    const strokeMode = n.style.stroke || 'solid';
    return [
      { k: 'path', d: rrPath(0, 0, n.w, n.h, Math.min(dev.r, n.w / 6, n.h / 6)), fill, stroke: strokeMode === 'none' ? null : rgbCss(stroke), sw: n.style.sw || 1, dash: strokeMode },
      { k: 'text', x: 0, y: -22, lines: [title], fs: 12, bold: false, color: rgbCss(P.textDim), align: 'left', lh: 17 },
    ];
  }
  function imagePrims(n) {
    return [{ k: 'image', x: 0, y: 0, w: n.w, h: n.h, src: n.imageId, op: styleOf(n, 'opacity') }];
  }

  function uiPrims(n, P) {
    const c = colorsOf(n, P);
    const w = n.w, hh = n.h, out = [];
    const accent = rgbCss(c.c);
    const neutral = styleOf(n, 'color') === 'default';
    const line = c.stroke || rgbCss(P.ink);
    const surface = c.fill;
    const ink = c.text;
    const placeholder = styleOf(n, 'fill') === 'solid' ? ink : c.faint;
    const onColorKey = neutral ? rgbCss(P.cyan) : accent; // チェック等の「オン」の色（標準色ならテーマの強調色）
    const onRgb = neutral ? P.cyan : c.c;
    const muted = rgbCss(mixRgb(P.bg, P.text, 0.14));
    const box = (x, y, bw, bh, r, fill, stroke, sw) => out.push({ k: 'path', d: rrPath(x, y, bw, bh, r), fill, stroke, sw: sw || 1, dash: 'solid' });
    const label = (x, text, color, align) => out.push(boxText(n, { x, y: 0, w: Math.max(8, w - x - (align === 'center' ? x : 4)), h: hh }, P, color, { text, align: align || 'left' }));
    switch (n.ui) {
      case 'button':
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, Math.min(8, hh / 2)), fill: surface, stroke: c.stroke, sw: c.sw, dash: c.dash });
        out.push(boxText(n, { x: 8, y: 0, w: w - 16, h: hh }, P, styleOf(n, 'fill') === 'solid' ? ink : c.stroke ? accent : ink));
        break;
      case 'input':
      case 'select':
      case 'search': {
        const r = n.ui === 'search' ? hh / 2 : 5;
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, r), fill: surface, stroke: c.stroke ? line : null, sw: c.sw, dash: c.dash });
        let x = 12;
        if (n.ui === 'search') {
          const s = Math.min(hh * 0.22, 8);
          out.push({ k: 'path', d: ellipsePath(hh * 0.5, hh * 0.47, s, s) + linePath(hh * 0.5 + s * 0.72, hh * 0.47 + s * 0.72, hh * 0.5 + s * 1.5, hh * 0.47 + s * 1.5), fill: null, stroke: c.faint, sw: 1.6, dash: 'solid' });
          x = hh * 0.95;
        }
        if (n.ui === 'select') out.push({ k: 'path', d: `M${f2(w - 24)},${f2(hh / 2 - 3)}l5,5l5,-5`, fill: null, stroke: c.faint, sw: 1.6, dash: 'solid' });
        out.push(boxText(n, { x, y: 0, w: w - x - (n.ui === 'select' ? 34 : 12), h: hh }, P, placeholder));
        break;
      }
      case 'checkbox': {
        const y = hh / 2 - 8;
        if (n.on) {
          box(0, y, 16, 16, 3, rgbCss(onRgb), null);
          out.push({ k: 'path', d: `M3.5,${f2(y + 8.5)}l3.2,3.2l6,-6.4`, fill: null, stroke: onColor(onRgb), sw: 2, dash: 'solid' });
        } else box(0, y, 16, 16, 3, surface, line, 1.5);
        label(26, null, rgbCss(P.text));
        break;
      }
      case 'radio': {
        out.push({ k: 'path', d: ellipsePath(8, hh / 2, 8, 8), fill: surface, stroke: n.on ? onColorKey : line, sw: 1.5, dash: 'solid' });
        if (n.on) out.push({ k: 'path', d: ellipsePath(8, hh / 2, 4, 4), fill: onColorKey, stroke: null });
        label(26, null, rgbCss(P.text));
        break;
      }
      case 'toggle': {
        const tw = 38, th = 22, y = hh / 2 - th / 2;
        box(0, y, tw, th, th / 2, n.on ? rgbCss(onRgb) : muted, null);
        out.push({ k: 'path', d: ellipsePath(n.on ? tw - th / 2 : th / 2, hh / 2, 8, 8), fill: '#ffffff', stroke: null });
        label(tw + 10, null, rgbCss(P.text));
        break;
      }
      case 'slider': {
        const y = hh / 2, x1 = 8, x2 = w - 8, xm = x1 + (x2 - x1) * 0.55;
        out.push({ k: 'path', d: linePath(x1, y, x2, y), fill: null, stroke: muted, sw: 4, dash: 'solid', cap: 'round' });
        out.push({ k: 'path', d: linePath(x1, y, xm, y), fill: null, stroke: onColorKey, sw: 4, dash: 'solid', cap: 'round' });
        out.push({ k: 'path', d: ellipsePath(xm, y, 8, 8), fill: onColorKey, stroke: rgbCss(P.bg), sw: 2, dash: 'solid' });
        break;
      }
      case 'tabs': {
        const items = splitItems(n.text, ['タブ']);
        const r = Math.min(6, hh / 2);
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, r), fill: surface, stroke: c.stroke ? line : null, sw: 1, dash: 'solid' });
        const sw = w / items.length;
        items.forEach((t, i) => {
          const active = n.on && i === 0;
          if (active) out.push({ k: 'path', d: rrPath(i * sw + 3, 3, sw - 6, hh - 6, Math.max(0, r - 2)), fill: rgbCss(onRgb), stroke: null });
          else if (i > 0) out.push({ k: 'path', d: linePath(i * sw, 8, i * sw, hh - 8), fill: null, stroke: rgbCss(P.lineSoft), sw: 1, dash: 'solid' });
          out.push(textPrim([fitLine(t, sw - 12, styleOf(n, 'fs'), styleOf(n, 'bold'))], { x: i * sw + 6, y: 0, w: sw - 12, h: hh }, { fs: styleOf(n, 'fs'), bold: styleOf(n, 'bold'), color: active ? onColor(onRgb) : rgbCss(P.textDim), align: 'center' }));
        });
        break;
      }
      case 'image':
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, 4), fill: surface || rgbCss(mixRgb(P.bg, P.text, 0.05)), stroke: line, sw: 1, dash: 'solid' });
        out.push({ k: 'path', d: linePath(0, 0, w, hh) + linePath(w, 0, 0, hh), fill: null, stroke: line, sw: 1, dash: 'solid', op: 0.6 });
        if (n.text) out.push(boxText(n, { x: 8, y: 0, w: w - 16, h: hh }, P, c.faint));
        break;
      case 'card': {
        const ih = Math.round(hh * 0.5);
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, 8), fill: surface, stroke: c.stroke ? line : null, sw: c.sw, dash: c.dash });
        out.push({ k: 'path', d: `M0,${ih}V8A8,8 0 0 1 8,0H${f2(w - 8)}A8,8 0 0 1 ${f2(w)},8V${ih}Z`, fill: rgbCss(mixRgb(P.bg, P.text, 0.07)), stroke: null });
        out.push({ k: 'path', d: linePath(0, 0, w, ih) + linePath(w, 0, 0, ih), fill: null, stroke: line, sw: 1, dash: 'solid', op: 0.45 });
        const parts = String(n.text || '').split('\n');
        const fs = styleOf(n, 'fs');
        const tLines = wrapText(parts[0] || '', w - 28, fs + 1, true);
        out.push(textPrim(tLines, { x: 14, y: ih + 12, w: w - 28, h: 0 }, { fs: fs + 1, bold: true, color: ink, align: styleOf(n, 'align'), valign: 'top' }));
        const rest = parts.slice(1).join('\n');
        if (rest) out.push(textPrim(wrapText(rest, w - 28, fs - 2, false), { x: 14, y: ih + 16 + tLines.length * lineH(fs + 1), w: w - 28, h: 0 }, { fs: fs - 2, bold: false, color: c.dim, align: styleOf(n, 'align'), valign: 'top' }));
        break;
      }
      case 'list': {
        const items = splitItems(n.text, ['項目']);
        const rh = hh / items.length;
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, 4), fill: surface, stroke: c.stroke ? line : null, sw: 1, dash: 'solid' });
        items.forEach((t, i) => {
          const y = i * rh;
          if (i > 0) out.push({ k: 'path', d: linePath(12, y, w - 12, y), fill: null, stroke: rgbCss(P.lineSoft), sw: 1, dash: 'solid' });
          const rr = Math.min(9, rh * 0.28);
          out.push({ k: 'path', d: ellipsePath(12 + rr, y + rh / 2, rr, rr), fill: muted, stroke: null });
          out.push(textPrim([fitLine(t, w - 44 - rr, styleOf(n, 'fs'), styleOf(n, 'bold'))], { x: 22 + rr * 2, y, w: w - 34 - rr * 2, h: rh }, { fs: styleOf(n, 'fs'), bold: styleOf(n, 'bold'), color: ink, align: 'left' }));
        });
        break;
      }
      case 'avatar': {
        const r = Math.min(w, hh) / 2;
        out.push({ k: 'path', d: ellipsePath(w / 2, hh / 2, w / 2, hh / 2), fill: rgbCss(mixRgb(P.bg, P.text, 0.1)), stroke: line, sw: 1, dash: 'solid' });
        out.push({ k: 'path', d: ellipsePath(w / 2, hh * 0.4, r * 0.32, r * 0.32), fill: c.faint, stroke: null });
        out.push({ k: 'path', d: `M${f2(w / 2 - r * 0.6)},${f2(hh * 0.86)}C${f2(w / 2 - r * 0.55)},${f2(hh * 0.62)} ${f2(w / 2 + r * 0.55)},${f2(hh * 0.62)} ${f2(w / 2 + r * 0.6)},${f2(hh * 0.86)}Z`, fill: c.faint, stroke: null });
        break;
      }
      case 'icon':
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, Math.min(8, w / 4)), fill: surface, stroke: line, sw: 1, dash: 'solid' });
        if (n.text) out.push(boxText(n, { x: 2, y: 0, w: w - 4, h: hh }, P, ink, { align: 'center' }));
        else out.push({ k: 'path', d: polyPath([[w / 2, hh * 0.28], [w * 0.72, hh / 2], [w / 2, hh * 0.72], [w * 0.28, hh / 2]]), fill: null, stroke: c.faint, sw: 1.5, dash: 'solid' });
        break;
      case 'badge':
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, hh / 2), fill: surface, stroke: c.stroke, sw: c.sw, dash: c.dash });
        out.push(boxText(n, { x: 4, y: 0, w: w - 8, h: hh }, P, styleOf(n, 'fill') === 'solid' ? ink : c.stroke ? accent : ink, { align: 'center' }));
        break;
      case 'divider':
        out.push({ k: 'path', d: linePath(0, hh / 2, w, hh / 2), fill: null, stroke: line, sw: c.sw || 1, dash: c.dash === 'none' ? 'solid' : c.dash });
        break;
      case 'lines': {
        const count = Math.max(1, Math.floor((hh + 10) / 18));
        for (let i = 0; i < count; i++) {
          const lw = i === count - 1 && count > 1 ? w * 0.62 : i % 3 === 1 ? w * 0.94 : w;
          out.push({ k: 'path', d: rrPath(0, i * 18, lw, 8, 4), fill: muted, stroke: null });
        }
        break;
      }
      case 'navbar': {
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, 0), fill: surface, stroke: null });
        out.push({ k: 'path', d: linePath(0, hh - 0.5, w, hh - 0.5), fill: null, stroke: line, sw: 1, dash: 'solid' });
        const my = hh / 2;
        out.push({ k: 'path', d: linePath(16, my - 6, 34, my - 6) + linePath(16, my, 34, my) + linePath(16, my + 6, 34, my + 6), fill: null, stroke: ink, sw: 1.8, dash: 'solid', cap: 'round' });
        out.push({ k: 'path', d: ellipsePath(w - 28, my, 12, 12), fill: muted, stroke: null });
        out.push(boxText(n, { x: 48, y: 0, w: w - 96, h: hh }, P, ink));
        break;
      }
      case 'tabbar': {
        const items = splitItems(n.text, ['ホーム']);
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, 0), fill: surface, stroke: null });
        out.push({ k: 'path', d: linePath(0, 0.5, w, 0.5), fill: null, stroke: line, sw: 1, dash: 'solid' });
        const iw = w / items.length;
        items.forEach((t, i) => {
          const active = n.on && i === 0;
          const col = active ? onColorKey : rgbCss(P.textDim);
          const cx = iw * i + iw / 2;
          out.push({ k: 'path', d: rrPath(cx - 10, hh * 0.2, 20, 18, 5), fill: null, stroke: col, sw: 1.6, dash: 'solid' });
          out.push(textPrim([fitLine(t, iw - 6, 10, active)], { x: iw * i + 3, y: hh * 0.2 + 22, w: iw - 6, h: 14 }, { fs: 10, bold: active, color: col, align: 'center' }));
        });
        break;
      }
      default:
        out.push({ k: 'path', d: rrPath(0, 0, w, hh, 4), fill: surface, stroke: line, sw: 1, dash: 'solid' });
    }
    return out;
  }

  function nodePrims(n, P, T) {
    switch (n.type) {
      case 'topic': return topicPrims(n, P, T);
      case 'shape': return shapePrims(n, P);
      case 'sticky': return stickyPrims(n, P);
      case 'text': return textNodePrims(n, P);
      case 'frame': return framePrims(n, P);
      case 'ui': return uiPrims(n, P);
      case 'image': return imagePrims(n);
      default: return [];
    }
  }
  // 編集中は文字を隠す（上に編集欄を重ねるため）
  function withoutText(prims) { return prims.filter((p) => p.k !== 'text'); }

  /* =====================================================================
     線（矢印）の形
     端は「ノード＋辺（t/r/b/l、a=自動）」か「自由な点」。
     カギ線は候補の経路をいくつか作り、長さ・曲がり数・ノードとの重なりで一番良いものを選ぶ
  ===================================================================== */
  const DIRV = { t: { x: 0, y: -1 }, r: { x: 1, y: 0 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 } };
  const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  function sidePoint(n, side) {
    let p;
    if (side === 't') p = { x: n.x + n.w / 2, y: n.y };
    else if (side === 'b') p = { x: n.x + n.w / 2, y: n.y + n.h };
    else if (side === 'l') p = { x: n.x, y: n.y + n.h / 2 };
    else p = { x: n.x + n.w, y: n.y + n.h / 2 };
    if (n.type === 'shape' && SHAPES[n.shape].anchor) {
      const local = SHAPES[n.shape].anchor(n.w, n.h, side, { x: p.x - n.x, y: p.y - n.y });
      p = { x: local.x + n.x, y: local.y + n.y };
    }
    return p;
  }
  function autoSide(n, target) {
    const c = center(n);
    const dx = (target.x - c.x) / Math.max(n.w, 1), dy = (target.y - c.y) / Math.max(n.h, 1);
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'r' : 'l') : (dy >= 0 ? 'b' : 't');
  }
  function freeDir(p, q) {
    const dx = q.x - p.x, dy = q.y - p.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? 1 : -1, y: 0 } : { x: 0, y: dy >= 0 ? 1 : -1 };
  }
  function edgeEnds(e, map) {
    const A = e.from.node ? map.get(e.from.node) : null;
    const B = e.to.node ? map.get(e.to.node) : null;
    const ca = A ? center(A) : { x: e.from.x || 0, y: e.from.y || 0 };
    const cb = B ? center(B) : { x: e.to.x || 0, y: e.to.y || 0 };
    let sa = A ? e.from.side : null, sb = B ? e.to.side : null;
    if (A && B && sa === 'a' && sb === 'a') {
      const dx = (cb.x - ca.x) / (((A.w + B.w) / 2) || 1), dy = (cb.y - ca.y) / (((A.h + B.h) / 2) || 1);
      if (Math.abs(dx) >= Math.abs(dy)) { sa = dx >= 0 ? 'r' : 'l'; sb = dx >= 0 ? 'l' : 'r'; }
      else { sa = dy >= 0 ? 'b' : 't'; sb = dy >= 0 ? 't' : 'b'; }
    } else {
      if (A && sa === 'a') sa = autoSide(A, B && sb !== 'a' ? sidePoint(B, sb) : cb);
      if (B && sb === 'a') sb = autoSide(B, A ? sidePoint(A, sa) : ca);
    }
    const p1 = A ? sidePoint(A, sa) : ca;
    const p2 = B ? sidePoint(B, sb) : cb;
    const d1 = A ? DIRV[sa] : freeDir(p1, p2);
    const d2 = B ? DIRV[sb] : freeDir(p2, p1);
    return { p1, p2, d1, d2, A, B };
  }
  function simplifyPts(pts) {
    const out = [];
    pts.forEach((p) => {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) return;
      out.push(p);
    });
    for (let i = out.length - 2; i >= 1; i--) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) {
        // 折り返し（行って戻る）でなければ中間点は不要
        const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
        if (dot >= 0) out.splice(i, 1);
      }
    }
    return out;
  }
  function segHitsBox(a, b, bx) {
    const e = 1;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    return x2 > bx.x1 + e && x1 < bx.x2 - e && y2 > bx.y1 + e && y1 < bx.y2 - e;
  }
  function elbowRoute(p1, d1, p2, d2, A, B) {
    const G = 20;
    const s1 = { x: p1.x + d1.x * G, y: p1.y + d1.y * G };
    const s2 = { x: p2.x + d2.x * G, y: p2.y + d2.y * G };
    const mx = (s1.x + s2.x) / 2, my = (s1.y + s2.y) / 2;
    const cands = [
      [{ x: s2.x, y: s1.y }],
      [{ x: s1.x, y: s2.y }],
      [{ x: mx, y: s1.y }, { x: mx, y: s2.y }],
      [{ x: s1.x, y: my }, { x: s2.x, y: my }],
    ];
    const boxes = [A, B].filter(Boolean).map((n) => ({ x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }));
    if (boxes.length) {
      const U = { x1: Math.min(s1.x, s2.x), y1: Math.min(s1.y, s2.y), x2: Math.max(s1.x, s2.x), y2: Math.max(s1.y, s2.y) };
      boxes.forEach((b) => { U.x1 = Math.min(U.x1, b.x1 - G); U.y1 = Math.min(U.y1, b.y1 - G); U.x2 = Math.max(U.x2, b.x2 + G); U.y2 = Math.max(U.y2, b.y2 + G); });
      cands.push(
        [{ x: s1.x, y: U.y1 }, { x: s2.x, y: U.y1 }], [{ x: s1.x, y: U.y2 }, { x: s2.x, y: U.y2 }],
        [{ x: U.x1, y: s1.y }, { x: U.x1, y: s2.y }], [{ x: U.x2, y: s1.y }, { x: U.x2, y: s2.y }]
      );
    }
    let best = null, bestScore = Infinity;
    cands.forEach((mids) => {
      const pts = simplifyPts([p1, s1].concat(mids, [s2, p2]));
      let score = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        score += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
        if (i >= 2) {
          const pa = pts[i - 2];
          const dot = (a.x - pa.x) * (b.x - a.x) + (a.y - pa.y) * (b.y - a.y);
          score += dot < 0 ? 2000 : 24; // 折り返しは大きく減点、曲がりは少し減点
        }
        boxes.forEach((bx, bi) => {
          if ((bi === 0 && A && i === 1) || (i === pts.length - 1 && B && bx === boxes[boxes.length - 1])) return;
          if (segHitsBox(a, b, bx)) score += 5000;
        });
      }
      if (score < bestScore) { bestScore = score; best = pts; }
    });
    return best;
  }
  function roundedPolyline(pts, r) {
    let d = `M${f2(pts[0].x)},${f2(pts[0].y)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const rr = Math.min(r, l1 / 2, l2 / 2);
      if (rr < 0.5) { d += `L${f2(b.x)},${f2(b.y)}`; continue; }
      const p = { x: b.x + (a.x - b.x) / l1 * rr, y: b.y + (a.y - b.y) / l1 * rr };
      const q = { x: b.x + (c.x - b.x) / l2 * rr, y: b.y + (c.y - b.y) / l2 * rr };
      d += `L${f2(p.x)},${f2(p.y)}Q${f2(b.x)},${f2(b.y)} ${f2(q.x)},${f2(q.y)}`;
    }
    const z = pts[pts.length - 1];
    return d + `L${f2(z.x)},${f2(z.y)}`;
  }
  const unit = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
  function polyMid(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let half = total / 2;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (half <= l && l > 0) return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * half / l, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * half / l };
      half -= l;
    }
    return pts[0];
  }
  const bez = (a, b, c, d, t) => { const u = 1 - t; return { x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y }; };

  // 線の形（中心線・矢じり・ラベル位置・当たり判定用の経路・範囲）
  function edgeGeometry(e, map) {
    const g = edgeEnds(e, map);
    const sw = e.style.sw || 2;
    const L = 9 + sw * 2.2;
    const wantStart = e.arrow === 'start' || e.arrow === 'both';
    const wantEnd = e.arrow === 'end' || e.arrow === 'both';
    let d, mid, startDir, endDir, pts, box;
    if (e.route === 'curve') {
      const dist = Math.hypot(g.p2.x - g.p1.x, g.p2.y - g.p1.y);
      const k = Math.max(30, Math.min(dist * 0.45, 160));
      let a = g.p1, dd = g.p2;
      let b = { x: a.x + g.d1.x * k, y: a.y + g.d1.y * k }, c = { x: dd.x + g.d2.x * k, y: dd.y + g.d2.y * k };
      mid = bez(a, b, c, dd, 0.5);
      startDir = unit({ x: a.x - b.x, y: a.y - b.y });
      endDir = unit({ x: dd.x - c.x, y: dd.y - c.y });
      const cut = L * 0.75;
      if (wantStart) { a = { x: a.x - startDir.x * cut, y: a.y - startDir.y * cut }; b = { x: b.x - startDir.x * cut, y: b.y - startDir.y * cut }; }
      if (wantEnd) { dd = { x: dd.x - endDir.x * cut, y: dd.y - endDir.y * cut }; c = { x: c.x - endDir.x * cut, y: c.y - endDir.y * cut }; }
      d = `M${f2(a.x)},${f2(a.y)}C${f2(b.x)},${f2(b.y)} ${f2(c.x)},${f2(c.y)} ${f2(dd.x)},${f2(dd.y)}`;
      pts = [g.p1, b, c, g.p2];
    } else {
      // 向かい合った辺どうしで、ずれがわずか（3px未満）なら、段差を作らずまっすぐ引く
      const facing = g.d1.x === -g.d2.x && g.d1.y === -g.d2.y;
      const offAxis = g.d1.x !== 0 ? Math.abs(g.p2.y - g.p1.y) : Math.abs(g.p2.x - g.p1.x);
      const ahead = (g.p2.x - g.p1.x) * g.d1.x + (g.p2.y - g.p1.y) * g.d1.y > 0;
      pts = e.route === 'straight' || (e.route === 'elbow' && facing && ahead && offAxis < 3) ? [g.p1, g.p2] : elbowRoute(g.p1, g.d1, g.p2, g.d2, g.A, g.B);
      mid = polyMid(pts);
      const n = pts.length;
      startDir = unit({ x: pts[0].x - pts[1].x, y: pts[0].y - pts[1].y });
      endDir = unit({ x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y });
      const draw = pts.map((p) => ({ x: p.x, y: p.y }));
      const cut = L * 0.75;
      const segLen = (i, j) => Math.hypot(draw[j].x - draw[i].x, draw[j].y - draw[i].y);
      if (wantStart && segLen(0, 1) > cut) { draw[0].x -= startDir.x * cut; draw[0].y -= startDir.y * cut; }
      if (wantEnd && segLen(n - 1, n - 2) > cut) { draw[n - 1].x -= endDir.x * cut; draw[n - 1].y -= endDir.y * cut; }
      d = e.route === 'elbow' ? roundedPolyline(draw, 8) : `M${f2(draw[0].x)},${f2(draw[0].y)}L${f2(draw[1].x)},${f2(draw[1].y)}`;
    }
    box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    pts.forEach((p) => { box.x1 = Math.min(box.x1, p.x); box.y1 = Math.min(box.y1, p.y); box.x2 = Math.max(box.x2, p.x); box.y2 = Math.max(box.y2, p.y); });
    return { d, mid, p1: g.p1, p2: g.p2, startDir, endDir, L, sw, wantStart, wantEnd, box, pts };
  }
  function arrowHead(tip, dir, L) {
    const W = L * 0.42;
    const bx = tip.x - dir.x * L, by = tip.y - dir.y * L;
    const px = -dir.y, py = dir.x;
    return `M${f2(tip.x)},${f2(tip.y)}L${f2(bx + px * W)},${f2(by + py * W)}L${f2(bx - px * W)},${f2(by - py * W)}Z`;
  }
  function edgePrims(e, geo, P, hideLabel) {
    const col = e.style.color && e.style.color !== 'default' ? colorRgb(e.style.color, P) : P.edge;
    const css = rgbCss(col);
    const out = [{ k: 'path', d: geo.d, fill: null, stroke: css, sw: geo.sw, dash: e.style.stroke || 'solid' }];
    if (geo.wantEnd) out.push({ k: 'path', d: arrowHead(geo.p2, geo.endDir, geo.L), fill: css, stroke: null });
    if (geo.wantStart) out.push({ k: 'path', d: arrowHead(geo.p1, geo.startDir, geo.L), fill: css, stroke: null });
    if (e.label && !hideLabel) {
      const lines = wrapText(e.label, 200, 12, false);
      const tw = linesWidth(lines, 12, false), th = lines.length * lineH(12);
      const bx = geo.mid.x - tw / 2 - 5, by = geo.mid.y - th / 2 - 2;
      out.push({ k: 'path', d: rrPath(bx, by, tw + 10, th + 4, 3), fill: rgbCss(P.bg), stroke: null });
      out.push(textPrim(lines, { x: bx + 5, y: by + 2, w: tw, h: th }, { fs: 12, color: rgbCss(P.text), align: 'center' }));
    }
    return out;
  }
  function labelBox(e, geo) {
    const lines = wrapText(e.label || ' ', 200, 12, false);
    const tw = Math.max(40, linesWidth(lines, 12, false)), th = lines.length * lineH(12);
    return { x: geo.mid.x - tw / 2, y: geo.mid.y - th / 2, w: tw, h: th };
  }

  // マインドマップの枝（親 → 子）
  function branchPath(p, c, T) {
    const dir = T.dir.get(c.id);
    if (dir === 'd') {
      const x1 = p.x + p.w / 2, y1 = p.y + p.h, x2 = c.x + c.w / 2, y2 = c.y;
      const my = y1 + (y2 - y1) / 2;
      return roundedPolyline(simplifyPts([{ x: x1, y: y1 }, { x: x1, y: my }, { x: x2, y: my }, { x: x2, y: y2 }]), 8);
    }
    const right = dir !== 'l';
    const x1 = right ? p.x + p.w : p.x, y1 = p.y + p.h / 2;
    const x2 = right ? c.x : c.x + c.w, y2 = c.y + c.h / 2;
    const k = (x2 - x1) / 2;
    return `M${f2(x1)},${f2(y1)}C${f2(x1 + k)},${f2(y1)} ${f2(x2 - k)},${f2(y2)} ${f2(x2)},${f2(y2)}`;
  }
  function branchPrim(p, c, T, P) {
    const depth = T.depth.get(c.id) || 1;
    return { k: 'path', d: branchPath(p, c, T), fill: null, stroke: rgbCss(colorRgb(T.branch.get(c.id) || 'cyan', P)), sw: depth === 1 ? 3 : depth === 2 ? 2 : 1.5, dash: 'solid' };
  }

  /* ---- 範囲 ---- */
  function nodeBox(n, T) {
    const b = { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h };
    if (n.type === 'frame') b.y1 -= 24;
    if (n.type === 'sticky') { b.x2 += 3; b.y2 += 5; }
    if (n.type === 'topic' && T && T.hiddenCount.get(n.id)) { b.x1 -= 24; b.x2 += 24; b.y2 += 24; }
    return b;
  }
  const unionBox = (a, b) => (a ? { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) } : { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
  const rectsTouch = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const boxInside = (a, b) => a.x1 >= b.x1 && a.x2 <= b.x2 && a.y1 >= b.y1 && a.y2 <= b.y2;

  /* =====================================================================
     描画の実装（2通り）：SVG の要素を作る／Canvas 2D に描く
  ===================================================================== */
  const dashArr = (p) => {
    const sw = p.sw || 1;
    if (p.dash === 'dashed') return [sw * 4, sw * 3];
    if (p.dash === 'dotted') return [0.1, sw * 2.6];
    return null;
  };
  const baseline = (p, i) => p.y + i * p.lh + p.lh / 2 + p.fs * 0.36;
  const anchorOf = (a) => (a === 'left' ? 'start' : a === 'right' ? 'end' : 'middle');

  // env: { imageHref(id) → URL|null, forExport }
  function appendPrims(parent, prims, env) {
    prims.forEach((p) => {
      if (p.k === 'g') {
        const g = svgEl('g', { transform: `translate(${f2(p.x)},${f2(p.y)})` }, parent);
        appendPrims(g, p.items, env);
      } else if (p.k === 'path') {
        if (!p.fill && !p.stroke) return;
        const dash = p.stroke ? dashArr(p) : null;
        svgEl('path', {
          d: p.d, fill: p.fill || 'none', stroke: p.stroke || 'none',
          'stroke-width': p.stroke ? p.sw : null,
          'stroke-dasharray': dash ? dash.map(f2).join(' ') : null,
          'stroke-linecap': p.cap || (p.dash === 'dotted' ? 'round' : null),
          'stroke-linejoin': p.stroke ? 'round' : null,
          opacity: p.op != null && p.op < 1 ? p.op : null,
        }, parent);
      } else if (p.k === 'text') {
        const t = svgEl('text', {
          'font-size': p.fs, 'font-weight': p.bold ? 700 : 400, fill: p.color, 'text-anchor': anchorOf(p.align),
          'font-family': env && env.forExport ? FONT_STACK : null,
          'xml:space': env && env.forExport ? 'preserve' : null,
          style: 'white-space:pre', opacity: p.op != null && p.op < 1 ? p.op : null,
        }, parent);
        p.lines.forEach((line, i) => {
          const s = svgEl('tspan', { x: f2(p.x), y: f2(baseline(p, i)) }, t);
          s.textContent = line;
        });
      } else if (p.k === 'image') {
        const href = env && env.imageHref ? env.imageHref(p.src) : null;
        if (href) {
          svgEl('image', { href, x: f2(p.x), y: f2(p.y), width: f2(p.w), height: f2(p.h), preserveAspectRatio: 'none', opacity: p.op != null && p.op < 1 ? p.op : null }, parent);
        } else {
          svgEl('path', { d: rrPath(p.x, p.y, p.w, p.h, 0), fill: rgbCss(mixRgb(pal.bg, pal.text, 0.06)), stroke: rgbCss(pal.textFaint), 'stroke-dasharray': '4 3' }, parent);
          const t = svgEl('text', { x: f2(p.x + p.w / 2), y: f2(p.y + p.h / 2 + 4), 'font-size': 12, fill: rgbCss(pal.textFaint), 'text-anchor': 'middle' }, parent);
          t.textContent = env && env.thumb ? '' : '画像';
        }
      }
    });
  }

  // images: Map(id → 描画できる画像)
  function paintPrims(ctx, prims, images) {
    prims.forEach((p) => {
      ctx.save();
      if (p.op != null && p.op < 1) ctx.globalAlpha = p.op;
      if (p.k === 'g') {
        ctx.translate(p.x, p.y);
        paintPrims(ctx, p.items, images);
      } else if (p.k === 'path') {
        const path = new Path2D(p.d);
        if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(path); }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.sw || 1;
          ctx.lineJoin = 'round';
          ctx.lineCap = p.cap || (p.dash === 'dotted' ? 'round' : 'butt');
          ctx.setLineDash(dashArr(p) || []);
          ctx.stroke(path);
        }
      } else if (p.k === 'text') {
        ctx.fillStyle = p.color;
        ctx.font = fontStr(p.fs, p.bold);
        ctx.textAlign = p.align === 'left' ? 'left' : p.align === 'right' ? 'right' : 'center';
        ctx.textBaseline = 'alphabetic';
        p.lines.forEach((line, i) => ctx.fillText(line, p.x, baseline(p, i)));
      } else if (p.k === 'image') {
        const img = images && images.get(p.src);
        if (img) ctx.drawImage(img, p.x, p.y, p.w, p.h);
        else { ctx.strokeStyle = rgbCss(pal.textFaint); ctx.setLineDash([4, 3]); ctx.strokeRect(p.x, p.y, p.w, p.h); }
      }
      ctx.restore();
    });
  }

  /* ---- ボード1枚分の表示リスト（書き出し・サムネイル用） ----
     filter(n) で対象のノードを絞れる。線は両端とも対象のノード（または自由な点）のものだけ */
  function boardScene(b, P, opts) {
    const o = opts || {};
    const T = layoutNodes(b.nodes);
    const map = new Map(b.nodes.map((n) => [n.id, n]));
    const visible = b.nodes.filter((n) => !T.hidden.has(n.id) && (!o.filter || o.filter(n)));
    const inSet = new Set(visible.map((n) => n.id));
    const items = [];
    let box = null;
    const frames = visible.filter((n) => n.type === 'frame');
    const others = visible.filter((n) => n.type !== 'frame');
    frames.concat(others).forEach((n) => {
      items.push({ k: 'g', x: n.x, y: n.y, items: nodePrims(n, P, T) });
      box = unionBox(box, nodeBox(n, T));
    });
    visible.forEach((c) => {
      if (c.type !== 'topic' || !c.parent || !inSet.has(c.parent)) return;
      items.push(branchPrim(map.get(c.parent), c, T, P));
    });
    b.edges.forEach((e) => {
      const okEnd = (end) => (end.node ? inSet.has(end.node) : !o.filter || (o.freeFilter && o.freeFilter(end)));
      if (!okEnd(e.from) || !okEnd(e.to)) return;
      if (o.edgeFilter && !o.edgeFilter(e)) return;
      const geo = edgeGeometry(e, map);
      edgePrims(e, geo, P, false).forEach((p) => items.push(p));
      box = unionBox(box, { x1: geo.box.x1 - 12, y1: geo.box.y1 - 12, x2: geo.box.x2 + 12, y2: geo.box.y2 + 12 });
      if (e.label) { const lb = labelBox(e, geo); box = unionBox(box, { x1: lb.x - 6, y1: lb.y - 3, x2: lb.x + lb.w + 6, y2: lb.y + lb.h + 3 }); }
    });
    // 重なり順は画面と同じ：フレーム → ノード → 枝 → 線
    return { items, box };
  }

  /* =====================================================================
     状態
  ===================================================================== */
  let boards = [];             // すべてのボード（開いているボードも同じオブジェクト）
  let meta = {};
  let prefs = { wheel: 'scroll', inspector: true };
  let currentView = 'home';
  let board = null;            // 開いているボード
  let nodeMap = new Map();
  let edgeMap = new Map();
  let T = emptyTree();
  const geoCache = new Map();  // 線ID → 形（当たり判定・選択表示に使う）
  let view = { x: 0, y: 0, zoom: 1 };
  let selection = new Set();
  let tool = 'select';
  let shapeKind = 'rect', frameKind = 'phone', uiKind = 'button', stickyColor = 'yellow';
  let act = null;              // 進行中の操作（ドラッグなど）
  let editing = null;          // 文字の編集中 { kind:'node'|'edge'|'frame', id, before }
  let hoverId = null;
  let spaceDown = false;
  let undoStack = [];
  let redoStack = [];
  let needsLayout = true;
  let lastPointer = null;      // 最後にポインタがあった位置（ワールド座標）。貼り付け位置に使う
  let pointerInCanvas = false;
  let memClip = null;          // アプリ内のクリップボード（画像の中身も持つ）
  let baseUpdatedAt = 0;       // DB上のこのボードの更新日時（別タブとの衝突検知用）
  let search = { open: false, hits: [], idx: -1 };
  const useSink = !window.matchMedia || matchMedia('(pointer: fine)').matches; // マウス環境：選択中トピックへの直接入力（日本語入力対応）

  /* ---- DOM ---- */
  const appShell = $('appShell');
  const boardListEl = $('boardList'), boardSearch = $('boardSearch'), boardSort = $('boardSort');
  const boardTitle = $('boardTitle'), saveInd = $('saveInd');
  const stage = $('stage'), world = $('world');
  const layerFrames = $('layerFrames'), layerNodes = $('layerNodes'), layerEdges = $('layerEdges'), layerOverlay = $('layerOverlay');
  const layerBranches = svgEl('g', { 'pointer-events': 'none' }, layerEdges);
  const layerLinks = svgEl('g', {}, layerEdges);
  const canvasWrap = $('canvasWrap'), textEditor = $('textEditor'), editTip = $('editTip');
  const inspector = $('inspector'), toolRail = $('toolRail'), placeHint = $('placeHint'), selBar = $('selBar');
  const zoomVal = $('zoomVal'), canvasEmpty = $('canvasEmpty');
  const menuBtn = $('menuBtn'), menuPanel = $('menuPanel');

  /* =====================================================================
     画像（Blob を IndexedDB に保存し、表示には Object URL を使う）
  ===================================================================== */
  const imageCache = new Map(); // imageId → { rec, url }
  function cacheImage(rec) {
    const old = imageCache.get(rec.id);
    if (old && old.rec.blob === rec.blob) return old.url;
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(rec.blob);
    imageCache.set(rec.id, { rec, url });
    return url;
  }
  function dropImageCache() { imageCache.forEach((c) => URL.revokeObjectURL(c.url)); imageCache.clear(); }
  const imageHref = (id) => { const c = imageCache.get(id); return c ? c.url : null; };
  const screenEnv = { imageHref, forExport: false };
  async function preloadImages(b) {
    const ids = new Set(b.nodes.filter((n) => n.type === 'image' && n.imageId).map((n) => n.imageId));
    for (const id of ids) {
      if (imageCache.has(id)) continue;
      try { const rec = await dbGet(S.images, id); if (rec && rec.blob) cacheImage(rec); } catch (err) { console.error('画像の読み込みに失敗しました', err); }
    }
  }

  /* =====================================================================
     保存（自動保存：デバウンス＋Promiseチェーンで直列化）
  ===================================================================== */
  function createSaver(saveFn, onState, delay) {
    let timer = null, dirty = false, chain = Promise.resolve();
    function run() {
      clearTimeout(timer); timer = null;
      if (!dirty) return chain;
      dirty = false;
      chain = chain.then(saveFn).then(() => onState('saved')).catch((err) => {
        console.error('保存に失敗しました', err);
        dirty = true; // 次の保存機会で再試行する
        onState('error');
      });
      return chain;
    }
    return {
      schedule() { dirty = true; onState('editing'); clearTimeout(timer); timer = setTimeout(run, delay); },
      flush() { return run(); },
      get pending() { return dirty; },
    };
  }
  function setSaveState(s) {
    const text = !dbReady ? 'このブラウザでは保存できません' : s === 'editing' ? '編集中…' : s === 'saved' ? '保存しました' : s === 'error' ? '保存に失敗しました' : '';
    saveInd.textContent = text;
    saveInd.classList.toggle('is-error', s === 'error' || !dbReady);
    if (s === 'error') toast('保存に失敗しました。容量不足の可能性があります。☰ からエクスポートしてください', 'error');
  }
  function serializeBoard(b) {
    return { id: b.id, title: b.title, kind: b.kind, nodes: b.nodes, edges: b.edges, settings: b.settings, createdAt: b.createdAt, updatedAt: b.updatedAt };
  }
  let conflictOpen = false;
  async function saveBoardNow() {
    const b = board;
    if (!b || !dbReady) return;
    const cur = await dbGet(S.boards, b.id);
    if (cur && cur.updatedAt > baseUpdatedAt && cur.updatedAt !== b.updatedAt && !conflictOpen) {
      // 別のタブ（画面）が先に保存していた：黙って上書きせず、どうするか聞く
      conflictOpen = true;
      const choice = await ask('このボードは別の画面（タブ）で更新されています。\nどちらの内容を残しますか？', {
        buttons: [
          { value: 'mine', label: 'こちらで上書き', kind: 'danger' },
          { value: 'copy', label: 'こちらを別のボードとして保存', kind: 'primary' },
          { value: 'theirs', label: '相手の内容を読み込む' },
        ],
      });
      conflictOpen = false;
      if (choice === 'theirs') { await reloadBoardFrom(cur); return; }
      if (choice === 'copy') { await saveAsCopy(b); return; }
      if (choice !== 'mine') { boardSaver.schedule(); return; } // 閉じた場合は次の機会にもう一度聞く
    }
    const rec = serializeBoard(b);
    await dbPut(S.boards, rec);
    baseUpdatedAt = rec.updatedAt;
  }
  const boardSaver = createSaver(saveBoardNow, setSaveState, SAVE_DELAY_MS);
  const viewSaver = createSaver(async () => {
    if (!board || !dbReady) return;
    await dbPut(S.views, { id: board.id, x: view.x, y: view.y, zoom: view.zoom });
  }, () => {}, VIEW_SAVE_DELAY_MS);
  function markDirty() {
    if (!board) return;
    board.updatedAt = Math.max(Date.now(), board.updatedAt + 1);
    boardSaver.schedule();
  }
  const flushAll = () => { if (editing) commitEdit(); boardSaver.flush(); viewSaver.flush(); };

  /* =====================================================================
     元に戻す／やり直す（操作前の全体を JSON で控える方式）
  ===================================================================== */
  const snapshot = () => JSON.stringify({ n: board.nodes, e: board.edges });
  function pushUndo(before) {
    undoStack.push(before);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function restoreSnap(s) {
    const o = JSON.parse(s);
    board.nodes = o.n;
    board.edges = o.e;
    afterModelChange();
    markDirty();
  }
  function undo() {
    if (!board) return;
    if (editing) commitEdit();
    if (act) cancelAct();
    if (!undoStack.length) { toast('これ以上は戻せません'); return; }
    redoStack.push(snapshot());
    restoreSnap(undoStack.pop());
    updateUndoButtons();
  }
  function redo() {
    if (!board) return;
    if (editing) commitEdit();
    if (act) cancelAct();
    if (!redoStack.length) { toast('やり直せる操作はありません'); return; }
    undoStack.push(snapshot());
    restoreSnap(redoStack.pop());
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }
  function afterModelChange() {
    nodeMap = new Map(board.nodes.map((n) => [n.id, n]));
    edgeMap = new Map(board.edges.map((e) => [e.id, e]));
    Array.from(selection).forEach((id) => { if (!nodeMap.has(id) && !edgeMap.has(id)) selection.delete(id); });
    if (hoverId && !nodeMap.has(hoverId)) hoverId = null;
    needsLayout = true;
    requestRender();
    scheduleInspector();
  }
  function commitIfChanged(before) {
    if (snapshot() === before) return false;
    pushUndo(before);
    markDirty();
    return true;
  }
  // 変更をまとめて行い、実際に変わっていれば「元に戻す」に積んで保存する
  function mutate(fn) {
    if (!board) return undefined;
    const before = snapshot();
    const r = fn();
    afterModelChange();
    commitIfChanged(before);
    return r;
  }
  function ensureLayout() {
    if (!needsLayout || !board) return;
    T = layoutNodes(board.nodes);
    needsLayout = false;
    Array.from(selection).forEach((id) => { if (T.hidden.has(id)) selection.delete(id); });
  }

  /* =====================================================================
     座標
  ===================================================================== */
  function stageRect() { return stage.getBoundingClientRect(); }
  function toWorld(clientX, clientY) {
    const r = stageRect();
    return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
  }
  function viewCenterWorld() {
    const r = stageRect();
    return { x: (r.width / 2 - view.x) / view.zoom, y: (r.height / 2 - view.y) / view.zoom };
  }
  function visibleWorldBox(margin) {
    const r = stageRect();
    const m = margin || 0;
    return { x1: (-view.x) / view.zoom - m, y1: (-view.y) / view.zoom - m, x2: (r.width - view.x) / view.zoom + m, y2: (r.height - view.y) / view.zoom + m };
  }
  function zoomAt(sx, sy, z) {
    const nz = clamp(z, ZOOM_MIN, ZOOM_MAX);
    const wx = (sx - view.x) / view.zoom, wy = (sy - view.y) / view.zoom;
    view.zoom = nz;
    view.x = sx - wx * nz;
    view.y = sy - wy * nz;
    viewChanged();
  }
  function zoomBy(factor) { const r = stageRect(); zoomAt(r.width / 2, r.height / 2, view.zoom * factor); }
  function viewChanged() { requestRender(); viewSaver.schedule(); }
  function fitBox(box, maxZoom) {
    const r = stageRect();
    if (!box || r.width < 10 || r.height < 10) return;
    const padPx = 48;
    const bw = Math.max(1, box.x2 - box.x1), bh = Math.max(1, box.y2 - box.y1);
    const z = clamp(Math.min((r.width - padPx * 2) / bw, (r.height - padPx * 2) / bh, maxZoom || 1), ZOOM_MIN, ZOOM_MAX);
    view.zoom = z;
    view.x = r.width / 2 - (box.x1 + bw / 2) * z;
    view.y = r.height / 2 - (box.y1 + bh / 2) * z;
    viewChanged();
  }
  function contentBox(ids) {
    ensureLayout();
    let box = null;
    board.nodes.forEach((n) => { if (!T.hidden.has(n.id) && (!ids || ids.has(n.id))) box = unionBox(box, nodeBox(n, T)); });
    board.edges.forEach((e) => {
      if (ids && !ids.has(e.id)) return;
      const g = geoCache.get(e.id);
      if (g) box = unionBox(box, g.box);
    });
    return box;
  }
  function fitAll() { const b = contentBox(); if (b) fitBox(b, 1); else { const r = stageRect(); view = { x: r.width / 2, y: r.height / 2, zoom: 1 }; viewChanged(); } }
  function centerOn(pt) { const r = stageRect(); view.x = r.width / 2 - pt.x * view.zoom; view.y = r.height / 2 - pt.y * view.zoom; viewChanged(); }

  /* =====================================================================
     描画（変わったノード・線だけを作り直す）
  ===================================================================== */
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderNow);
  }
  const nodeEls = new Map();
  const linkEls = new Map();
  function renderNow() {
    renderQueued = false;
    if (!board || currentView !== 'editor') return;
    ensureLayout();
    world.setAttribute('transform', `translate(${f2(view.x)},${f2(view.y)}) scale(${view.zoom})`);
    updateGrid();
    renderNodes();
    renderLinks();
    renderOverlay();
    positionEditor();
    zoomVal.textContent = Math.round(view.zoom * 100) + '%';
    canvasEmpty.classList.toggle('is-shown', board.nodes.length === 0 && !act && !editing);
  }
  function updateGrid() {
    const on = board.settings.grid;
    canvasWrap.classList.toggle('show-grid', on);
    if (!on) return;
    let g = GRID * view.zoom;
    while (g < 12) g *= 2;
    canvasWrap.style.backgroundSize = `${f2(g)}px ${f2(g)}px`;
    canvasWrap.style.backgroundPosition = `${f2(((view.x % g) + g) % g - g / 2)}px ${f2(((view.y % g) + g) % g - g / 2)}px`;
  }
  function nodeKey(n) {
    const k = [n.type, n.w, n.h, n.text, n.style, n.shape, n.ui, n.on, n.device, n.imageId, editing && editing.id === n.id, palVersion];
    if (n.type === 'topic') k.push(T.depth.get(n.id), T.branch.get(n.id), T.hiddenCount.get(n.id) || 0, T.dir.get(n.id), n.parent ? 1 : n.layout);
    if (n.type === 'image') k.push(imageHref(n.imageId) ? 1 : 0);
    return JSON.stringify(k);
  }
  function buildNodeG(n) {
    const g = svgEl('g', { 'data-node': n.id });
    if (n.type === 'frame') {
      // フレームはふちと名前だけで掴む（中は空白と同じ＝範囲選択できる）
      const inner = svgEl('g', { 'pointer-events': 'none' }, g);
      let prims = nodePrims(n, pal, T);
      if (editing && editing.id === n.id) prims = withoutText(prims);
      appendPrims(inner, prims, screenEnv);
      svgEl('rect', { x: 0, y: 0, width: n.w, height: n.h, fill: 'none', stroke: 'transparent', 'stroke-width': 12, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'stroke', class: 'mf-frame-hit' }, g);
      svgEl('rect', { x: 0, y: -26, width: Math.min(n.w, textWidth(n.text || '（名前なし）', 12, false) + 16), height: 24, fill: 'transparent', class: 'mf-frame-hit' }, g);
      return g;
    }
    svgEl('rect', { x: 0, y: 0, width: Math.max(n.w, 1), height: Math.max(n.h, 1), fill: 'transparent' }, g);
    let prims = nodePrims(n, pal, T);
    if (editing && editing.id === n.id) prims = withoutText(prims);
    appendPrims(g, prims, screenEnv);
    return g;
  }
  function renderNodes() {
    const alive = new Set();
    let fi = 0, ni = 0;
    board.nodes.forEach((n) => {
      if (T.hidden.has(n.id)) return;
      alive.add(n.id);
      const key = nodeKey(n);
      let rec = nodeEls.get(n.id);
      if (!rec || rec.key !== key) {
        const g = buildNodeG(n);
        if (rec) rec.g.remove();
        rec = { g, key };
        nodeEls.set(n.id, rec);
      }
      rec.g.setAttribute('transform', `translate(${f2(n.x)},${f2(n.y)})`);
      const layer = n.type === 'frame' ? layerFrames : layerNodes;
      const idx = n.type === 'frame' ? fi++ : ni++;
      if (layer.children[idx] !== rec.g) layer.insertBefore(rec.g, layer.children[idx] || null);
    });
    nodeEls.forEach((rec, id) => { if (!alive.has(id)) { rec.g.remove(); nodeEls.delete(id); } });
  }
  const endHidden = (end) => !!end.node && (!nodeMap.has(end.node) || T.hidden.has(end.node));
  function renderLinks() {
    const alive = new Set();
    let bi = 0, ei = 0;
    board.nodes.forEach((c) => {
      if (c.type !== 'topic' || !c.parent || T.hidden.has(c.id)) return;
      const p = nodeMap.get(c.parent);
      if (!p) return;
      const prim = branchPrim(p, c, T, pal);
      const id = 'b:' + c.id;
      alive.add(id);
      const key = prim.d + '|' + prim.stroke + '|' + prim.sw;
      let rec = linkEls.get(id);
      if (!rec || rec.key !== key) {
        const g = svgEl('g');
        appendPrims(g, [prim], screenEnv);
        if (rec) rec.g.remove();
        rec = { g, key };
        linkEls.set(id, rec);
      }
      if (layerBranches.children[bi] !== rec.g) layerBranches.insertBefore(rec.g, layerBranches.children[bi] || null);
      bi++;
    });
    geoCache.clear();
    board.edges.forEach((e) => {
      if (endHidden(e.from) || endHidden(e.to)) return;
      const geo = edgeGeometry(e, nodeMap);
      geoCache.set(e.id, geo);
      const hideLabel = !!(editing && editing.kind === 'edge' && editing.id === e.id);
      const prims = edgePrims(e, geo, pal, hideLabel);
      const id = 'e:' + e.id;
      alive.add(id);
      const key = JSON.stringify(prims) + palVersion;
      let rec = linkEls.get(id);
      if (!rec || rec.key !== key) {
        const g = svgEl('g', { 'data-edge': e.id });
        svgEl('path', { d: geo.d, fill: 'none', stroke: 'transparent', 'stroke-width': 14, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round' }, g);
        appendPrims(g, prims, screenEnv);
        if (rec) rec.g.remove();
        rec = { g, key };
        linkEls.set(id, rec);
      }
      if (layerLinks.children[ei] !== rec.g) layerLinks.insertBefore(rec.g, layerLinks.children[ei] || null);
      ei++;
    });
    linkEls.forEach((rec, id) => { if (!alive.has(id)) { rec.g.remove(); linkEls.delete(id); } });
  }
  function dropRenderCache() {
    nodeEls.forEach((r) => r.g.remove()); nodeEls.clear();
    linkEls.forEach((r) => r.g.remove()); linkEls.clear();
    layerOverlay.textContent = '';
  }

  /* ---- 操作用の表示（選択枠・ハンドル・接続点など。書き出しには含めない） ---- */
  const PORT_TYPES = ['shape', 'sticky', 'text', 'ui', 'image', 'frame'];
  const canResize = (n) => n && n.type !== 'topic' && !n.locked;
  function singleNode() {
    if (selection.size !== 1) return null;
    const id = selection.values().next().value;
    return nodeMap.get(id) || null;
  }
  function singleEdge() {
    if (selection.size !== 1) return null;
    const id = selection.values().next().value;
    return edgeMap.get(id) || null;
  }
  function portsFor(n) {
    if (!n || !PORT_TYPES.includes(n.type) || T.hidden.has(n.id)) return null;
    if (n.type === 'frame' && !selection.has(n.id) && !(act && act.type === 'connect')) return null;
    return ['t', 'r', 'b', 'l'].map((s) => {
      const p = sidePoint(n, s);
      const off = 14 / view.zoom;
      return { side: s, x: p.x + DIRV[s].x * off, y: p.y + DIRV[s].y * off };
    });
  }
  function renderOverlay() {
    layerOverlay.textContent = '';
    const z = view.zoom;
    const px = (v) => v / z;
    const ov = layerOverlay;
    const rectOf = (n, inflate) => ({ x: n.x - inflate, y: n.y - inflate, width: n.w + inflate * 2, height: n.h + inflate * 2 });

    // 検索のヒット
    if (search.open) search.hits.forEach((id, i) => {
      const n = nodeMap.get(id);
      if (n && !T.hidden.has(id)) svgEl('rect', Object.assign(rectOf(n, px(5)), { class: 'ov-search' + (i === search.idx ? ' is-current' : '') }), ov);
    });
    // ホバー
    if (hoverId && !selection.has(hoverId) && (!act || act.type === 'connect' || act.type === 'arrowDraw' || act.type === 'endDrag')) {
      const n = nodeMap.get(hoverId);
      if (n && !T.hidden.has(n.id)) svgEl('rect', Object.assign(rectOf(n, px(2)), { class: act ? 'ov-target' : 'ov-hover' }), ov);
    }
    // 選択
    selection.forEach((id) => {
      const n = nodeMap.get(id);
      if (n) { svgEl('rect', Object.assign(rectOf(n, px(3)), { class: 'ov-sel' + (n.locked ? ' is-locked' : '') }), ov); return; }
      const g = geoCache.get(id);
      if (g) svgEl('path', { d: g.d, class: 'ov-edge-sel', 'stroke-width': g.sw + 8 }, ov);
    });
    const busy = act && act.type !== 'hover';
    const one = singleNode();
    // 大きさを変えるハンドル
    if (one && canResize(one) && !editing && (!busy || act.type === 'resize')) {
      const hs = px(8);
      const x1 = one.x, y1 = one.y, x2 = one.x + one.w, y2 = one.y + one.h, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const small = one.w * z < 36 || one.h * z < 36;
      let hsList = [['nw', x1, y1], ['ne', x2, y1], ['se', x2, y2], ['sw', x1, y2]];
      if (!small) hsList = hsList.concat([['n', cx, y1], ['e', x2, cy], ['s', cx, y2], ['w', x1, cy]]);
      if (one.type === 'text') hsList = [['e', x2, cy], ['w', x1, cy]];
      hsList.forEach(([d, x, y]) => svgEl('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, class: 'ov-handle', 'data-h': d }, ov));
    }
    // 接続点（ドラッグでつなぐ／クリックで次の図形）
    if (tool === 'select' && !editing && (!busy || act.type === 'connect' || act.type === 'endDrag' || act.type === 'arrowDraw')) {
      const targets = new Set();
      if (!busy) {
        if (hoverId) targets.add(hoverId);
        if (one) targets.add(one.id);
      } else if (act.target) targets.add(act.target);
      targets.forEach((id) => {
        const n = nodeMap.get(id);
        const ports = portsFor(n);
        if (!ports || (!busy && n.locked)) return;
        ports.forEach((p) => svgEl('circle', { cx: p.x, cy: p.y, r: px(5.5), class: 'ov-port' + (busy && act.targetSide === p.side ? ' is-hot' : ''), 'data-port': p.side, 'data-node': n.id }, ov));
      });
    }
    // トピック：子を足す＋ボタン／折りたたみ
    if (!editing && !busy) {
      const foldFor = new Set();
      if (hoverId) foldFor.add(hoverId);
      if (one) foldFor.add(one.id);
      board.nodes.forEach((n) => { if (n.type === 'topic' && T.hiddenCount.get(n.id) && !T.hidden.has(n.id)) foldFor.add(n.id); });
      foldFor.forEach((id) => {
        const n = nodeMap.get(id);
        if (!n || n.type !== 'topic' || T.hidden.has(id)) return;
        const kids = T.kids.get(id);
        if (!kids || !kids.length) return;
        const fp = foldPoint(n, T);
        const g = svgEl('g', { class: 'ov-fold', 'data-fold': id, transform: `translate(${f2(n.x + fp.x)},${f2(n.y + fp.y)})` }, ov);
        if (n.collapsed) svgEl('circle', { r: 10, fill: 'transparent', stroke: 'none' }, g);
        else {
          svgEl('circle', { r: px(7) }, g);
          svgEl('path', { d: `M${f2(-px(3.5))},0H${f2(px(3.5))}` }, g);
        }
      });
      // 子が見えているときは枝と重なるので出さない（Tab か詳細パネルで追加できる）
      const oneKids = one && one.type === 'topic' ? (T.kids.get(one.id) || []) : [];
      if (one && one.type === 'topic' && !one.locked && (!oneKids.length || one.collapsed)) {
        const d = childDir(one, T);
        const hasKids = oneKids.length > 0;
        const off = (hasKids ? 12 + 10 : 0) + px(16);
        let ax = one.x + one.w + off, ay = one.y + one.h / 2;
        if (d === 'l') ax = one.x - off;
        if (d === 'd') { ax = one.x + one.w / 2; ay = one.y + one.h + off; }
        const g = svgEl('g', { class: 'ov-add', 'data-add': one.id, transform: `translate(${f2(ax)},${f2(ay)})` }, ov);
        const t = svgEl('title', null, g); t.textContent = '子トピックを追加（Tab）';
        svgEl('circle', { r: px(9) }, g);
        svgEl('path', { d: `M${f2(-px(4))},0H${f2(px(4))}M0,${f2(-px(4))}V${f2(px(4))}` }, g);
      }
    }
    // 線の端（付け替え用）
    const oneEdge = singleEdge();
    if (oneEdge && !editing && (!busy || act.type === 'endDrag')) {
      const g = geoCache.get(oneEdge.id);
      if (g) {
        svgEl('circle', { cx: g.p1.x, cy: g.p1.y, r: px(6), class: 'ov-end', 'data-end': 'from', 'data-edge-end': oneEdge.id }, ov);
        svgEl('circle', { cx: g.p2.x, cy: g.p2.y, r: px(6), class: 'ov-end', 'data-end': 'to', 'data-edge-end': oneEdge.id }, ov);
      }
    }
    if (!act) return;
    // 操作中の表示
    if (act.type === 'marquee') {
      const r = normRect(act.start, act.cur);
      svgEl('rect', { x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1, class: 'ov-marquee' }, ov);
    }
    if (act.guides) act.guides.forEach((g) => svgEl('line', { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: 'ov-guide' }, ov));
    if (act.type === 'create' && act.dragged) {
      const r = normRect(act.start, act.cur);
      svgEl('rect', { x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1, class: 'ov-ghost' }, ov);
    }
    if (act.type === 'connect' || act.type === 'arrowDraw') {
      const from = act.fromPoint;
      let to = act.cur;
      const tn = act.target && nodeMap.get(act.target);
      if (tn) to = act.targetSide && act.targetSide !== 'a' ? sidePoint(tn, act.targetSide) : center(tn);
      if (from) svgEl('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'ov-preview' }, ov);
    }
    if (act.type === 'topicDrag' && act.moved) {
      svgEl('rect', { x: act.ghost.x, y: act.ghost.y, width: act.ghost.w, height: act.ghost.h, class: 'ov-ghost' }, ov);
      const tn = act.target && nodeMap.get(act.target);
      if (tn) svgEl('rect', Object.assign(rectOf(tn, px(4)), { class: 'ov-target' }), ov);
      else if (act.insertLine) svgEl('line', Object.assign({}, act.insertLine, { class: 'ov-insert' }), ov);
    }
  }
  function normRect(a, b) { return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }; }

  /* =====================================================================
     選択・ツール
  ===================================================================== */
  function setSelection(ids, opts) {
    selection = new Set(ids);
    selectionChanged(opts);
  }
  function selectionChanged(opts) {
    requestRender();
    scheduleInspector(true);
    updateSelBar();
    if (opts && opts.focus) refocusCanvas(true);
  }
  const selectedNodes = () => Array.from(selection).map((id) => nodeMap.get(id)).filter(Boolean);
  const selectedEdges = () => Array.from(selection).map((id) => edgeMap.get(id)).filter(Boolean);
  function boardIdSet() {
    const s = new Set();
    board.nodes.forEach((n) => s.add(n.id));
    board.edges.forEach((e) => s.add(e.id));
    return s;
  }
  function descendants(id) {
    ensureLayout();
    const out = [];
    const stack = [id];
    while (stack.length) (T.kids.get(stack.pop()) || []).forEach((c) => { out.push(c.id); stack.push(c.id); });
    return out;
  }
  function framedNodes(f) {
    ensureLayout();
    const fb = { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.h };
    return board.nodes.filter((n) => n !== f && !n.locked && !T.hidden.has(n.id) && !(n.type === 'topic' && n.parent) && boxInside({ x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }, fb));
  }
  const editableText = (n) => !!n && !n.locked && n.type !== 'image' && !(n.type === 'ui' && UI_NO_TEXT.includes(n.ui));
  const snapV = (v) => Math.round(v / GRID) * GRID;
  function snapNode(n) { if (board.settings.snap) { n.x = snapV(n.x); n.y = snapV(n.y); } }
  function toastLimit() { toast(`1つのボードに置けるのは${MAX_NODES}個までです。ボードを分けてください`, 'warn'); }
  function nextFrameName() { return '画面' + (board.nodes.filter((n) => n.type === 'frame').length + 1); }

  const PLACE_TOOLS = ['topic', 'shape', 'sticky', 'text', 'frame', 'ui'];
  function setTool(t, sub) {
    if (editing) commitEdit();
    if (t === 'shape' && sub && SHAPES[sub]) shapeKind = sub;
    if (t === 'frame' && sub && FRAME_DEVICES[sub]) frameKind = sub;
    if (t === 'ui' && sub) uiKind = sub;
    tool = t;
    toolRail.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === t));
    document.querySelectorAll('.fly-item[data-kind]').forEach((b) => {
      const k = b.dataset.kind;
      b.classList.toggle('is-active', (t === 'shape' && k === 'shape:' + shapeKind) || (t === 'frame' && k === 'frame:' + frameKind) || (t === 'ui' && k === 'ui:' + uiKind));
    });
    if (t !== 'select') { hoverId = null; }
    updateCursor();
    updatePlaceHint();
    requestRender();
  }
  function placeLabel() {
    switch (tool) {
      case 'topic': return 'クリックした所に中心トピックを置きます';
      case 'shape': return `クリックで「${SHAPES[shapeKind].label}」を置きます（ドラッグで大きさを指定）`;
      case 'sticky': return 'クリックで付箋を置きます';
      case 'text': return 'クリックした所から文字を書けます';
      case 'frame': return frameKind === 'free' ? 'ドラッグしてフレームの大きさを決めます' : `クリックで「${FRAME_DEVICES[frameKind].label}」の画面フレームを置きます`;
      case 'ui': return uiKind.startsWith('text:') ? `クリックで「${UI_TEXT_PRESETS[uiKind.slice(5)].label}」を置きます` : `クリックで「${UI_KIT[uiKind].label}」を置きます（ドラッグで大きさを指定）`;
      case 'arrow': return 'ドラッグで矢印を引きます（図形の上で離すとつながります）';
      case 'hand': return 'ドラッグで画面を動かします';
      default: return '';
    }
  }
  function updatePlaceHint() {
    const t = placeLabel();
    placeHint.textContent = t ? t + '　Esc で戻る' : '';
    placeHint.classList.toggle('is-shown', !!t && currentView === 'editor');
  }
  function updateCursor() {
    const panning = !!(act && act.type === 'pan');
    canvasWrap.classList.toggle('cur-grabbing', panning);
    canvasWrap.classList.toggle('cur-grab', !panning && (tool === 'hand' || spaceDown));
    canvasWrap.classList.toggle('cur-cross', !panning && !spaceDown && (PLACE_TOOLS.includes(tool) || tool === 'arrow'));
  }

  /* =====================================================================
     ポインタ操作（マウス・タッチ・ペン共通）
  ===================================================================== */
  const touches = new Map();
  let lastTap = null;
  let lastTouchAt = 0;

  function hitInfo(target) {
    if (!target || !target.closest) return { kind: 'empty' };
    let el;
    if ((el = target.closest('[data-h]'))) return { kind: 'handle', dir: el.getAttribute('data-h') };
    if ((el = target.closest('[data-port]'))) return { kind: 'port', id: el.getAttribute('data-node'), side: el.getAttribute('data-port') };
    if ((el = target.closest('[data-edge-end]'))) return { kind: 'end', id: el.getAttribute('data-edge-end'), end: el.getAttribute('data-end') };
    if ((el = target.closest('[data-add]'))) return { kind: 'add', id: el.getAttribute('data-add') };
    if ((el = target.closest('[data-fold]'))) return { kind: 'fold', id: el.getAttribute('data-fold') };
    if ((el = target.closest('[data-node]'))) return { kind: 'node', id: el.getAttribute('data-node') };
    if ((el = target.closest('[data-edge]'))) return { kind: 'edge', id: el.getAttribute('data-edge') };
    return { kind: 'empty' };
  }
  // 座標から一番手前のノード（フレームはふち・名前の近くだけ）
  function nodeAt(pt, exclude, tolPx) {
    ensureLayout();
    const tol = (tolPx || 3) / view.zoom;
    for (let i = board.nodes.length - 1; i >= 0; i--) {
      const n = board.nodes[i];
      if (n.type === 'frame' || T.hidden.has(n.id) || (exclude && exclude.has(n.id))) continue;
      if (pt.x >= n.x - tol && pt.x <= n.x + n.w + tol && pt.y >= n.y - tol && pt.y <= n.y + n.h + tol) return n;
    }
    const band = 10 / view.zoom;
    for (let i = board.nodes.length - 1; i >= 0; i--) {
      const n = board.nodes[i];
      if (n.type !== 'frame' || (exclude && exclude.has(n.id))) continue;
      const outer = pt.x >= n.x - band && pt.x <= n.x + n.w + band && pt.y >= n.y - 26 && pt.y <= n.y + n.h + band;
      const inner = pt.x > n.x + band && pt.x < n.x + n.w - band && pt.y > n.y + band && pt.y < n.y + n.h - band;
      if (outer && !inner) return n;
    }
    return null;
  }

  function onPointerDown(e) {
    if (!board) return;
    closeMenu();
    closeFlyouts();
    if (editing) commitEdit();
    const pt = toWorld(e.clientX, e.clientY);
    lastPointer = pt;
    pointerInCanvas = true;
    if (e.pointerType === 'touch') {
      lastTouchAt = Date.now();
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { startPinch(); return; }
      if (touches.size > 2) return;
    }
    if (act) {
      if (act.type !== 'pinch' && act.pointerId === e.pointerId) cancelAct(); // 離した合図を取りこぼしていた
      else return;
    }
    if (e.button === 2) return;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 取れない環境は無視 */ }
    const base = { pointerId: e.pointerId, pointerType: e.pointerType, sx: e.clientX, sy: e.clientY, start: pt, cur: pt, moved: false };
    if (e.button === 1 || spaceDown || tool === 'hand') {
      act = Object.assign(base, { type: 'pan', vx: view.x, vy: view.y });
      updateCursor();
      e.preventDefault();
      return;
    }
    const hit = hitInfo(e.target);
    if (tool === 'arrow') { startArrowDraw(base, hit); refocusCanvas(true); return; }
    if (PLACE_TOOLS.includes(tool)) { act = Object.assign(base, { type: 'create' }); refocusCanvas(true); return; }
    switch (hit.kind) {
      case 'handle': startResize(base, hit.dir); break;
      case 'port': startConnect(base, hit.id, hit.side); break;
      case 'end': startEndDrag(base, hit.id, hit.end); break;
      case 'add': addChildTopic(hit.id); return;
      case 'fold': toggleCollapse(hit.id); refocusCanvas(true); return;
      case 'node': nodeDown(base, hit.id, e); break;
      case 'edge': edgeDown(base, hit.id, e); break;
      default: emptyDown(base, e, null);
    }
    refocusCanvas(true);
    requestRender();
  }
  function nodeDown(base, id, e) {
    const n = nodeMap.get(id);
    if (!n) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (n.locked) { emptyDown(base, e, id); return; } // ロック中：クリックで選ぶだけ。ドラッグは空白と同じ
    const wasSelected = selection.has(id);
    if (additive) {
      if (wasSelected) { selection.delete(id); selectionChanged(); return; }
      selection.add(id);
      selectionChanged();
    } else if (!wasSelected) setSelection([id]);
    act = Object.assign(base, { type: 'press', id, wasSelected, additive });
  }
  function edgeDown(base, id, e) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const wasSelected = selection.has(id);
    if (additive) {
      if (wasSelected) { selection.delete(id); selectionChanged(); return; }
      selection.add(id);
      selectionChanged();
    } else if (!wasSelected) setSelection([id]);
    act = Object.assign(base, { type: 'press', id, wasSelected, additive });
  }
  function emptyDown(base, e, clickSelect) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (base.pointerType === 'touch') {
      act = Object.assign(base, { type: 'pan', vx: view.x, vy: view.y, clickSelect, tap: true });
      return;
    }
    if (!additive && !clickSelect && selection.size) setSelection([]);
    act = Object.assign(base, { type: 'marquee', base: additive ? new Set(selection) : new Set(), clickSelect, additive });
  }

  function onPointerMove(e) {
    if (!board) return;
    const pt = toWorld(e.clientX, e.clientY);
    lastPointer = pt;
    pointerInCanvas = true;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (act && act.type === 'pinch') { updatePinch(); return; }
    }
    if (!act) { updateHover(pt); return; }
    if (e.pointerId !== act.pointerId) return;
    const dist = Math.hypot(e.clientX - act.sx, e.clientY - act.sy);
    if (!act.moved && dist < (act.pointerType === 'touch' ? 8 : 3)) return;
    act.moved = true;
    act.cur = pt;
    if (act.type === 'press') beginMove();
    switch (act.type) {
      case 'pan':
        view.x = act.vx + (e.clientX - act.sx);
        view.y = act.vy + (e.clientY - act.sy);
        viewChanged();
        return;
      case 'move': moveTo(pt, e.altKey); break;
      case 'topicDrag': topicDragTo(pt); break;
      case 'marquee': updateMarquee(); break;
      case 'resize': resizeTo(pt, e.shiftKey, e.altKey); break;
      case 'connect': case 'arrowDraw': connectTo(pt); break;
      case 'endDrag': endDragTo(pt); break;
      case 'create': act.dragged = true; break;
      default: break;
    }
    requestRender();
  }
  function updateHover(pt) {
    if (tool !== 'select' || editing) { if (hoverId) { hoverId = null; requestRender(); } return; }
    const n = nodeAt(pt, null, 18);
    const id = n ? n.id : null;
    if (id !== hoverId) { hoverId = id; requestRender(); }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (act && act.type === 'pinch') { if (!touches.size) act = null; return; }
    }
    if (!act || e.pointerId !== act.pointerId) return;
    const a = act;
    try { finishAct(a, e); }
    catch (err) { console.error('操作の確定に失敗しました', err); }
    finally {
      if (act === a) act = null;
      canvasWrap.classList.remove('cur-move');
      updateCursor();
      requestRender();
      scheduleInspector(true);
    }
  }
  function onPointerCancel(e) {
    touches.delete(e.pointerId);
    if (act && (act.pointerId === e.pointerId || act.type === 'pinch')) cancelAct();
  }
  function finishAct(a, e) {
    switch (a.type) {
      case 'press':
        if (!a.additive && a.wasSelected && selection.size > 1) setSelection([a.id]);
        maybeDoubleTap(a, e);
        break;
      case 'move':
      case 'resize':
      case 'endDrag':
        afterModelChange();
        commitIfChanged(a.before);
        break;
      case 'topicDrag': finishTopicDrag(a); break;
      case 'connect': finishConnect(a); break;
      case 'arrowDraw': finishArrowDraw(a); break;
      case 'marquee':
        if (!a.moved && a.clickSelect) {
          if (a.additive) { if (selection.has(a.clickSelect)) selection.delete(a.clickSelect); else selection.add(a.clickSelect); selectionChanged(); }
          else setSelection([a.clickSelect]);
        }
        break;
      case 'pan':
        if (!a.moved && a.tap) {
          if (a.clickSelect) setSelection([a.clickSelect]);
          else if (selection.size) setSelection([]);
          maybeDoubleTap(a, e);
        }
        break;
      case 'create': finishCreate(a); break;
      default: break;
    }
  }
  // 操作の取り消し（Esc・タッチの中断）：ドラッグ前の状態に戻す
  function cancelAct() {
    const a = act;
    act = null;
    if (!a) return;
    if (a.before && ['move', 'resize', 'topicDrag', 'endDrag'].includes(a.type)) {
      const o = JSON.parse(a.before);
      board.nodes = o.n;
      board.edges = o.e;
      afterModelChange();
    }
    canvasWrap.classList.remove('cur-move');
    updateCursor();
    requestRender();
  }
  function maybeDoubleTap(a, e) {
    if (a.pointerType !== 'touch') return;
    const now = Date.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(a.sx - lastTap.x, a.sy - lastTap.y) < 24) {
      lastTap = null;
      handleDouble(document.elementFromPoint(a.sx, a.sy) || e.target, a.start);
      return;
    }
    lastTap = { t: now, x: a.sx, y: a.sy };
  }

  /* ---- 移動 ---- */
  function beginMove() {
    const pressed = nodeMap.get(act.id);
    // 子トピックを1つだけつかんだ：付け替え・並べ替え
    if (pressed && pressed.type === 'topic' && pressed.parent && selection.size === 1) {
      act.type = 'topicDrag';
      act.before = snapshot();
      act.off = { x: act.start.x - pressed.x, y: act.start.y - pressed.y };
      act.ghost = { x: pressed.x, y: pressed.y, w: pressed.w, h: pressed.h };
      act.exclude = new Set([pressed.id].concat(descendants(pressed.id)));
      return;
    }
    const moving = new Map();
    const addNode = (n) => {
      if (!n || n.locked || moving.has(n.id) || (n.type === 'topic' && n.parent)) return;
      moving.set(n.id, { x0: n.x, y0: n.y });
    };
    const sel = selectedNodes();
    sel.forEach(addNode);
    const frames = sel.filter((n) => n.type === 'frame' && !n.locked);
    frames.forEach((f) => framedNodes(f).forEach(addNode)); // フレームは中身ごと動かす
    const fboxes = frames.map((f) => ({ x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.h }));
    const edgePts = [];
    board.edges.forEach((ed) => {
      ['from', 'to'].forEach((k) => {
        const end = ed[k];
        if (end.node) return;
        const inFrame = fboxes.some((b) => end.x >= b.x1 && end.x <= b.x2 && end.y >= b.y1 && end.y <= b.y2);
        if (selection.has(ed.id) || inFrame) edgePts.push({ id: ed.id, k, x0: end.x, y0: end.y });
      });
    });
    if (!moving.size && !edgePts.length) { act.type = 'none'; return; }
    act.type = 'move';
    act.before = snapshot();
    act.moving = moving;
    act.edgePts = edgePts;
    let box = null;
    moving.forEach((m, id) => { if (selection.has(id)) { const n = nodeMap.get(id); box = unionBox(box, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }); } });
    if (!box) moving.forEach((m, id) => { const n = nodeMap.get(id); box = unionBox(box, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }); });
    act.box0 = box;
    act.targets = box ? guideTargets(moving) : null;
    canvasWrap.classList.add('cur-move');
  }
  function guideTargets(moving) {
    const vb = visibleWorldBox(200 / view.zoom);
    const roots = new Set();
    moving.forEach((m, id) => { if (nodeMap.get(id).type === 'topic') roots.add(id); });
    const xs = [], ys = [];
    board.nodes.forEach((n) => {
      if (moving.has(n.id) || T.hidden.has(n.id)) return;
      if (n.type === 'topic' && roots.has(T.root.get(n.id))) return;
      const b = { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h };
      if (!rectsTouch(b, vb)) return;
      [b.x1, (b.x1 + b.x2) / 2, b.x2].forEach((v) => xs.push({ v, b }));
      [b.y1, (b.y1 + b.y2) / 2, b.y2].forEach((v) => ys.push({ v, b }));
    });
    return { xs, ys };
  }
  function snapDelta(b0, dx, dy, tg) {
    const thr = 6 / view.zoom;
    let bestX = null, bestY = null;
    if (board.settings.guides && tg) {
      const b = { x1: b0.x1 + dx, x2: b0.x2 + dx, y1: b0.y1 + dy, y2: b0.y2 + dy };
      [b.x1, (b.x1 + b.x2) / 2, b.x2].forEach((s) => tg.xs.forEach((t) => { const d = t.v - s; if (Math.abs(d) <= thr && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, v: t.v }; }));
      [b.y1, (b.y1 + b.y2) / 2, b.y2].forEach((s) => tg.ys.forEach((t) => { const d = t.v - s; if (Math.abs(d) <= thr && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, v: t.v }; }));
    }
    let rdx = dx, rdy = dy;
    if (bestX) rdx += bestX.d; else if (board.settings.snap) rdx = snapV(b0.x1 + dx) - b0.x1;
    if (bestY) rdy += bestY.d; else if (board.settings.snap) rdy = snapV(b0.y1 + dy) - b0.y1;
    const nb = { x1: b0.x1 + rdx, x2: b0.x2 + rdx, y1: b0.y1 + rdy, y2: b0.y2 + rdy };
    const guides = [];
    if (bestX) {
      let y1 = nb.y1, y2 = nb.y2;
      tg.xs.forEach((t) => { if (Math.abs(t.v - bestX.v) < 0.5) { y1 = Math.min(y1, t.b.y1); y2 = Math.max(y2, t.b.y2); } });
      guides.push({ x1: bestX.v, y1: y1 - 10, x2: bestX.v, y2: y2 + 10 });
    }
    if (bestY) {
      let x1 = nb.x1, x2 = nb.x2;
      tg.ys.forEach((t) => { if (Math.abs(t.v - bestY.v) < 0.5) { x1 = Math.min(x1, t.b.x1); x2 = Math.max(x2, t.b.x2); } });
      guides.push({ x1: x1 - 10, y1: bestY.v, x2: x2 + 10, y2: bestY.v });
    }
    return { dx: rdx, dy: rdy, guides };
  }
  function moveTo(pt, noSnap) {
    let dx = pt.x - act.start.x, dy = pt.y - act.start.y;
    act.guides = null;
    if (!noSnap && act.box0) { const s = snapDelta(act.box0, dx, dy, act.targets); dx = s.dx; dy = s.dy; act.guides = s.guides; }
    act.moving.forEach((m, id) => {
      const n = nodeMap.get(id);
      if (n) { n.x = clamp(m.x0 + dx, -COORD_LIMIT, COORD_LIMIT); n.y = clamp(m.y0 + dy, -COORD_LIMIT, COORD_LIMIT); }
    });
    act.edgePts.forEach((p) => { const ed = edgeMap.get(p.id); if (ed && !ed[p.k].node) { ed[p.k].x = p.x0 + dx; ed[p.k].y = p.y0 + dy; } });
    needsLayout = true;
  }

  /* ---- 子トピックのドラッグ：別のトピックへ付け替え／同じ親の中で並べ替え ---- */
  function topicDragTo(pt) {
    const n = nodeMap.get(act.id);
    if (!n) return;
    act.ghost.x = pt.x - act.off.x;
    act.ghost.y = pt.y - act.off.y;
    act.target = null; act.insert = null; act.insertLine = null;
    const t = nodeAt(pt, act.exclude);
    if (t && t.type === 'topic') { act.target = t.id; return; }
    const parent = nodeMap.get(n.parent);
    if (!parent) return;
    let sibs = (T.kids.get(parent.id) || []).filter((c) => c.id !== n.id && !T.hidden.has(c.id));
    let side = null;
    if (!parent.parent && parent.layout === 'both') {
      side = pt.x < parent.x + parent.w / 2 ? 'l' : 'r';
      sibs = sibs.filter((c) => T.dir.get(c.id) === side);
    }
    const vertical = T.dir.get(n.id) !== 'd';
    const pos = (c) => (vertical ? c.y + c.h / 2 : c.x + c.w / 2);
    const p = vertical ? pt.y : pt.x;
    let idx = sibs.findIndex((c) => p < pos(c));
    if (idx < 0) idx = sibs.length;
    act.insert = { idx, sibs: sibs.map((c) => c.id), side };
    if (sibs.length) {
      const ref = sibs[Math.min(idx, sibs.length - 1)];
      if (vertical) {
        const y = idx < sibs.length ? ref.y - V_GAP / 2 : ref.y + ref.h + V_GAP / 2;
        act.insertLine = { x1: ref.x, y1: y, x2: ref.x + ref.w, y2: y };
      } else {
        const x = idx < sibs.length ? ref.x - D_HGAP / 2 : ref.x + ref.w + D_HGAP / 2;
        act.insertLine = { x1: x, y1: ref.y, x2: x, y2: ref.y + ref.h };
      }
    } else {
      const x = side === 'l' ? parent.x - H_GAP / 2 : parent.x + parent.w + H_GAP / 2;
      act.insertLine = vertical ? { x1: x, y1: parent.y, x2: x, y2: parent.y + parent.h } : { x1: parent.x, y1: parent.y + parent.h + D_VGAP / 2, x2: parent.x + parent.w, y2: parent.y + parent.h + D_VGAP / 2 };
    }
  }
  function finishTopicDrag(a) {
    const n = nodeMap.get(a.id);
    if (!a.moved || !n) return;
    if (a.target) {
      const t = nodeMap.get(a.target);
      if (!t) return;
      n.parent = t.id;
      n.order = maxChildOrder(t.id) + 1;
      n.side = !t.parent && t.layout === 'both' ? (a.cur.x < t.x + t.w / 2 ? 'l' : 'r') : '';
      t.collapsed = false;
    } else if (a.insert) {
      const all = board.nodes.filter((c) => c.type === 'topic' && c.parent === n.parent && c.id !== n.id).sort((x, y) => x.order - y.order);
      const s = a.insert.sibs;
      let pos;
      if (a.insert.idx < s.length) pos = all.findIndex((c) => c.id === s[a.insert.idx]);
      else if (s.length) pos = all.findIndex((c) => c.id === s[s.length - 1]) + 1;
      else pos = all.length;
      if (pos < 0) pos = all.length;
      all.splice(pos, 0, n);
      all.forEach((c, i) => { c.order = i; });
      if (a.insert.side) n.side = a.insert.side;
    }
    afterModelChange();
    commitIfChanged(a.before);
  }

  /* ---- 大きさの変更 ---- */
  function startResize(base, dir) {
    const n = singleNode();
    if (!n || !canResize(n)) return;
    act = Object.assign(base, { type: 'resize', id: n.id, dir, r0: { x: n.x, y: n.y, w: n.w, h: n.h }, before: snapshot() });
  }
  function resizeTo(pt, shift, alt) {
    const n = nodeMap.get(act.id);
    if (!n) return;
    const r0 = act.r0, d = act.dir;
    let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
    const dx = pt.x - act.start.x, dy = pt.y - act.start.y;
    if (d.includes('w')) x1 += dx;
    if (d.includes('e')) x2 += dx;
    if (d.includes('n')) y1 += dy;
    if (d.includes('s')) y2 += dy;
    if (board.settings.snap && !alt) {
      if (d.includes('w')) x1 = snapV(x1);
      if (d.includes('e')) x2 = snapV(x2);
      if (d.includes('n')) y1 = snapV(y1);
      if (d.includes('s')) y2 = snapV(y2);
    }
    const MIN = n.type === 'text' ? 24 : 12;
    if (x2 - x1 < MIN) { if (d.includes('w')) x1 = x2 - MIN; else x2 = x1 + MIN; }
    if (y2 - y1 < MIN) { if (d.includes('n')) y1 = y2 - MIN; else y2 = y1 + MIN; }
    const keep = (n.type === 'image') !== shift; // 画像は比率を保つ（Shiftで自由に）。ほかはShiftで比率を保つ
    if (keep && d.length === 2 && r0.h > 0) {
      const ratio = r0.w / r0.h;
      let w = x2 - x1, hh = y2 - y1;
      if (w / hh > ratio) w = hh * ratio; else hh = w / ratio;
      if (d.includes('w')) x1 = x2 - w; else x2 = x1 + w;
      if (d.includes('n')) y1 = y2 - hh; else y2 = y1 + hh;
    }
    n.x = Math.round(x1); n.y = Math.round(y1);
    n.w = Math.max(MIN, Math.round(x2 - x1));
    n.h = Math.max(MIN, Math.round(y2 - y1));
    needsLayout = true;
  }

  /* ---- つなぐ（接続点から）・矢印ツール・線の端の付け替え ---- */
  function nearestSide(t, pt) {
    const near = 16 / view.zoom;
    let best = 'a', bd = Infinity;
    ['t', 'r', 'b', 'l'].forEach((s) => {
      const p = sidePoint(t, s);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < near && d < bd) { bd = d; best = s; }
    });
    return best;
  }
  function startConnect(base, nodeId, side) {
    const n = nodeMap.get(nodeId);
    if (!n) return;
    act = Object.assign(base, { type: 'connect', from: nodeId, fromSide: side, fromPoint: sidePoint(n, side), target: null, targetSide: 'a' });
  }
  function connectTo(pt) {
    const t = nodeAt(pt, act.from ? new Set([act.from]) : null);
    act.target = t ? t.id : null;
    act.targetSide = t ? nearestSide(t, pt) : 'a';
    hoverId = act.target;
  }
  function newEdge(from, to, used, o) {
    return { id: localId('e', used), from, to, route: (o && o.route) || 'elbow', arrow: (o && o.arrow) || 'end', label: '', style: {} };
  }
  function cloneForChain(src, used) {
    const n = { id: localId('n', used), type: src.type, x: 0, y: 0, w: src.w, h: src.h, text: '', style: JSON.parse(JSON.stringify(src.style || {})), locked: false };
    if (src.type === 'shape') n.shape = src.shape;
    else if (src.type === 'ui') { n.ui = src.ui; n.on = src.on; n.text = UI_KIT[src.ui].text; }
    else if (src.type === 'frame') { n.device = src.device; n.text = nextFrameName(); }
    else if (src.type === 'image') { n.type = 'shape'; n.shape = 'rect'; n.w = SHAPES.rect.w; n.h = SHAPES.rect.h; n.style = {}; }
    if (src.type === 'text') n.h = 24;
    return n;
  }
  function finishConnect(a) {
    const src = nodeMap.get(a.from);
    if (!src) return;
    if (a.target) {
      mutate(() => { board.edges.push(newEdge({ node: src.id, side: a.fromSide }, { node: a.target, side: a.targetSide }, boardIdSet())); });
      return;
    }
    const dist = Math.hypot(a.cur.x - a.start.x, a.cur.y - a.start.y) * view.zoom;
    if (!a.moved || dist < 12) { quickAdd(src.id, a.fromSide); return; }
    chainNewNode(src, a.fromSide, a.cur);
  }
  function occupied(b, ignoreId) {
    return board.nodes.some((m) => m.id !== ignoreId && m.type !== 'frame' && !T.hidden.has(m.id) && rectsTouch(b, { x1: m.x - 10, y1: m.y - 10, x2: m.x + m.w + 10, y2: m.y + m.h + 10 }));
  }
  // 接続点をクリック：その方向に同じ種類のノードを作ってつなぐ（空いていなければ横にずらす）
  function quickAdd(srcId, side) {
    const src = nodeMap.get(srcId);
    if (!src || !DIRV[side]) return;
    if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
    ensureLayout();
    let newId = null;
    mutate(() => {
      const used = boardIdSet();
      const n = cloneForChain(src, used);
      const d = DIRV[side];
      const gap = src.type === 'frame' ? 120 : 56;
      const sc = center(src);
      const cx = sc.x + d.x * (src.w / 2 + gap + n.w / 2);
      const cy = sc.y + d.y * (src.h / 2 + gap + n.h / 2);
      const perp = { x: d.y !== 0 ? 1 : 0, y: d.x !== 0 ? 1 : 0 };
      const step = perp.x ? n.w + 40 : n.h + 32;
      let px = cx, py = cy;
      for (const k of [0, 1, -1, 2, -2, 3, -3]) {
        const tx = cx + perp.x * step * k, ty = cy + perp.y * step * k;
        if (!occupied({ x1: tx - n.w / 2, y1: ty - n.h / 2, x2: tx + n.w / 2, y2: ty + n.h / 2 })) { px = tx; py = ty; break; }
      }
      n.x = Math.round(px - n.w / 2); n.y = Math.round(py - n.h / 2);
      snapNode(n);
      board.nodes.push(n);
      board.edges.push(newEdge({ node: src.id, side }, { node: n.id, side: 'a' }, used));
      newId = n.id;
    });
    if (!newId) return;
    setSelection([newId]);
    const n = nodeMap.get(newId);
    if (n.type !== 'frame' && editableText(n)) beginEdit(newId, { selectAll: true, isNew: true });
  }
  function chainNewNode(src, side, pt) {
    if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
    let newId = null;
    mutate(() => {
      const used = boardIdSet();
      const n = cloneForChain(src, used);
      // 出した方向の軸に近ければ、軸にそろえる（まっすぐな線にする）
      const sc = center(src);
      const near = 32 / view.zoom;
      let cx = pt.x, cy = pt.y;
      if ((side === 'l' || side === 'r') && Math.abs(cy - sc.y) < near) cy = sc.y;
      if ((side === 't' || side === 'b') && Math.abs(cx - sc.x) < near) cx = sc.x;
      n.x = Math.round(cx - n.w / 2); n.y = Math.round(cy - n.h / 2);
      snapNode(n);
      board.nodes.push(n);
      board.edges.push(newEdge({ node: src.id, side }, { node: n.id, side: 'a' }, used));
      newId = n.id;
    });
    if (!newId) return;
    setSelection([newId]);
    const n = nodeMap.get(newId);
    if (n.type !== 'frame' && editableText(n)) beginEdit(newId, { selectAll: true, isNew: true });
  }
  function startArrowDraw(base, hit) {
    const hn = hit.kind === 'node' ? nodeMap.get(hit.id) : null;
    const s = hn && hn.type !== 'frame' ? hn : nodeAt(base.start);
    act = Object.assign(base, { type: 'arrowDraw', from: s ? s.id : null, fromPoint: s ? center(s) : base.start, target: null, targetSide: 'a' });
  }
  function finishArrowDraw(a) {
    const dist = Math.hypot(a.cur.x - a.start.x, a.cur.y - a.start.y) * view.zoom;
    setTool('select');
    if (!a.moved || dist < 10) { toast('ドラッグして矢印を引いてください'); return; }
    if (a.from && a.target === a.from) return;
    let id = null;
    mutate(() => {
      const from = a.from ? { node: a.from, side: 'a' } : { x: Math.round(a.start.x), y: Math.round(a.start.y) };
      const to = a.target ? { node: a.target, side: a.targetSide } : { x: Math.round(a.cur.x), y: Math.round(a.cur.y) };
      const ed = newEdge(from, to, boardIdSet(), { route: a.from && a.target ? 'elbow' : 'straight' });
      board.edges.push(ed);
      id = ed.id;
    });
    if (id) setSelection([id]);
  }
  function startEndDrag(base, edgeId, k) {
    const ed = edgeMap.get(edgeId);
    if (!ed || (k !== 'from' && k !== 'to')) return;
    const other = ed[k === 'from' ? 'to' : 'from'];
    act = Object.assign(base, { type: 'endDrag', id: edgeId, k, before: snapshot(), otherNode: other.node || null, target: null, targetSide: 'a', fromPoint: null });
  }
  function endDragTo(pt) {
    const ed = edgeMap.get(act.id);
    if (!ed) return;
    const t = nodeAt(pt, act.otherNode ? new Set([act.otherNode]) : null);
    act.target = t ? t.id : null;
    act.targetSide = t ? nearestSide(t, pt) : 'a';
    ed[act.k] = t ? { node: t.id, side: act.targetSide } : { x: Math.round(pt.x), y: Math.round(pt.y) };
    hoverId = act.target;
  }

  /* ---- 範囲選択 ---- */
  function updateMarquee() {
    const r = normRect(act.start, act.cur);
    const sel = new Set(act.base);
    board.nodes.forEach((n) => {
      if (T.hidden.has(n.id) || n.locked) return;
      const b = { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h };
      if (n.type === 'frame' ? boxInside(b, r) : rectsTouch(b, r)) sel.add(n.id);
    });
    board.edges.forEach((ed) => { const g = geoCache.get(ed.id); if (g && boxInside(g.box, r)) sel.add(ed.id); });
    selection = sel;
    scheduleInspector(true);
    updateSelBar();
  }

  /* ---- ピンチ（2本指で拡大縮小・移動） ---- */
  function startPinch() {
    if (act && act.before) cancelAct();
    act = null;
    const pts = Array.from(touches.values());
    const r = stageRect();
    const mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    act = { type: 'pinch', pointerId: -1, d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, z0: view.zoom, w0: { x: (mid.x - view.x) / view.zoom, y: (mid.y - view.y) / view.zoom } };
  }
  function updatePinch() {
    const pts = Array.from(touches.values());
    if (pts.length < 2) return;
    const r = stageRect();
    const mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const z = clamp(act.z0 * d / act.d0, ZOOM_MIN, ZOOM_MAX);
    view.zoom = z;
    view.x = mid.x - act.w0.x * z;
    view.y = mid.y - act.w0.y * z;
    viewChanged();
  }

  /* ---- 置く（ツール） ---- */
  function makeNodeForTool(t, used, pt, rect) {
    const id = localId('n', used);
    const place = (n, dw, dh) => {
      if (rect) { n.x = Math.round(rect.x1); n.y = Math.round(rect.y1); n.w = Math.max(12, Math.round(rect.x2 - rect.x1)); n.h = Math.max(12, Math.round(rect.y2 - rect.y1)); }
      else { n.w = dw; n.h = dh; n.x = Math.round(pt.x - dw / 2); n.y = Math.round(pt.y - dh / 2); }
      snapNode(n);
      return n;
    };
    switch (t) {
      case 'topic': {
        const n = { id, type: 'topic', x: Math.round(pt.x - 60), y: Math.round(pt.y - 22), w: 120, h: 44, text: '中心テーマ', style: {}, locked: false, parent: null, order: 0, collapsed: false, layout: 'both', side: '' };
        snapNode(n);
        return n;
      }
      case 'shape': return place({ id, type: 'shape', shape: shapeKind, text: '', style: {}, locked: false }, SHAPES[shapeKind].w, SHAPES[shapeKind].h);
      case 'sticky': return place({ id, type: 'sticky', text: '', style: { color: stickyColor }, locked: false }, 180, 160);
      case 'text': {
        const n = { id, type: 'text', x: Math.round(pt.x), y: Math.round(pt.y - 12), w: 240, h: 24, text: '', style: {}, locked: false };
        if (rect) { n.x = Math.round(rect.x1); n.y = Math.round(rect.y1); n.w = Math.max(40, Math.round(rect.x2 - rect.x1)); }
        snapNode(n);
        return n;
      }
      case 'frame': {
        const dev = FRAME_DEVICES[frameKind];
        return place({ id, type: 'frame', device: frameKind, text: nextFrameName(), style: {}, locked: false }, dev.w, dev.h);
      }
      case 'ui': {
        if (uiKind.startsWith('text:')) {
          const p = UI_TEXT_PRESETS[uiKind.slice(5)] || UI_TEXT_PRESETS.body;
          const n = { id, type: 'text', x: Math.round(pt.x - p.w / 2), y: Math.round(pt.y - 16), w: rect ? Math.max(40, Math.round(rect.x2 - rect.x1)) : p.w, h: 30, text: p.text, style: { fs: p.fs, bold: p.bold }, locked: false };
          if (rect) { n.x = Math.round(rect.x1); n.y = Math.round(rect.y1); }
          snapNode(n);
          return n;
        }
        const kit = UI_KIT[uiKind] || UI_KIT.button;
        return place({ id, type: 'ui', ui: UI_KIT[uiKind] ? uiKind : 'button', on: true, text: kit.text, style: {}, locked: false }, kit.w, kit.h);
      }
      default: return null;
    }
  }
  function finishCreate(a) {
    const r = normRect(a.start, a.cur);
    const dragged = a.moved && (r.x2 - r.x1) * view.zoom > 8 && (r.y2 - r.y1) * view.zoom > 8;
    const t = tool;
    setTool('select');
    if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
    let created = null;
    mutate(() => {
      const n = makeNodeForTool(t, boardIdSet(), a.start, dragged && t !== 'topic' ? r : null);
      if (!n) return;
      board.nodes.push(n);
      created = n;
    });
    if (!created) return;
    setSelection([created.id]);
    if (['topic', 'shape', 'sticky', 'text'].includes(created.type)) beginEdit(created.id, { selectAll: true, isNew: true });
    else refocusCanvas(true);
  }

  /* ---- ダブルクリック（ダブルタップ） ---- */
  function handleDouble(target, pt) {
    if (!board || tool !== 'select') return;
    const hit = hitInfo(target);
    if (hit.kind === 'node') {
      const n = nodeMap.get(hit.id);
      if (!n) return;
      if (n.locked) { toast('ロック中です（詳細パネルか Ctrl+L で解除できます）'); return; }
      if (editableText(n)) { setSelection([n.id]); beginEdit(n.id, {}); }
      return;
    }
    if (hit.kind === 'edge') { setSelection([hit.id]); beginEditEdge(hit.id); return; }
    if (hit.kind === 'empty') {
      if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
      let id = null;
      mutate(() => { const n = makeNodeForTool('text', boardIdSet(), pt, null); board.nodes.push(n); id = n.id; });
      setSelection([id]);
      beginEdit(id, { isNew: true });
    }
  }

  /* ---- ホイール ---- */
  function onWheel(e) {
    if (!board) return;
    e.preventDefault();
    const r = stageRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= r.width; dy *= r.height; }
    const zoomMode = e.ctrlKey || e.metaKey || (prefs.wheel === 'zoom' && !e.shiftKey);
    if (zoomMode) {
      const k = Math.abs(dy) >= 40 ? 0.0015 : 0.01; // マウスのホイール（大きな刻み）とトラックパッドのピンチ（細かい刻み）
      zoomAt(mx, my, view.zoom * Math.exp(-dy * k));
    } else {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      view.x -= dx;
      view.y -= dy;
      viewChanged();
    }
  }

  /* =====================================================================
     文字の編集（キャンバスの上に textarea を重ねる）
     マウス環境では、トピックを選んでいる間この textarea を透明のままフォーカスしておき、
     文字を打ち始めた（日本語入力の変換開始を含む）瞬間に編集へ切り替える
  ===================================================================== */
  let composing = false;
  function sinkTarget() {
    if (!useSink || editing || currentView !== 'editor' || !board) return null;
    const n = singleNode();
    return n && n.type === 'topic' && !n.locked && !T.hidden.has(n.id) ? n : null;
  }
  // force=false のときは、利用者が他の入力欄（詳細パネル・ボード名など）にいるならフォーカスを奪わない
  function refocusCanvas(force) {
    if (currentView !== 'editor' || editing || !board) return;
    const a = document.activeElement;
    if (!force && a && a !== document.body && a !== canvasWrap && a !== textEditor && !toolRail.contains(a)) return;
    const n = sinkTarget();
    if (n) {
      if (!composing) textEditor.value = '';
      positionSink(n);
      if (document.activeElement !== textEditor) textEditor.focus({ preventScroll: true });
    } else {
      if (document.activeElement === textEditor) textEditor.blur();
      if (document.activeElement !== canvasWrap) canvasWrap.focus({ preventScroll: true });
    }
  }
  function positionSink(n) {
    const s = textEditor.style;
    s.left = f2(view.x + (n.x + n.w / 2) * view.zoom) + 'px';
    s.top = f2(view.y + (n.y + n.h / 2) * view.zoom) + 'px';
    s.width = '2px';
    s.height = '2px';
  }
  function editSpec() {
    if (!editing) return null;
    if (editing.kind === 'edge') {
      const g = geoCache.get(editing.id);
      if (!g) return null;
      return { box: { x: g.mid.x - 110, y: g.mid.y - 9, w: 220, h: 18 }, fs: 12, bold: false, align: 'center', valign: 'middle', color: rgbCss(pal.text), bg: rgbCss(pal.bg) };
    }
    const n = nodeMap.get(editing.id);
    if (!n) return null;
    const P = pal;
    switch (n.type) {
      case 'topic': {
        const depth = T.depth.get(n.id) || 0;
        const m = topicMetrics(n, depth);
        const bc = colorRgb(T.branch.get(n.id) || 'cyan', P);
        const solid = (n.style.fill || (depth === 0 ? 'solid' : 'tint')) === 'solid';
        return { box: { x: n.x + m.padX, y: n.y + m.padY, w: n.w - m.padX * 2, h: n.h - m.padY * 2 }, fs: m.fs, bold: m.bold, align: n.style.align || 'center', valign: 'middle', color: solid ? onColor(bc) : rgbCss(P.text), extra: 8 };
      }
      case 'shape': { const b = shapeBox(n); return { box: { x: n.x + b.x, y: n.y + b.y, w: b.w, h: b.h }, fs: styleOf(n, 'fs'), bold: styleOf(n, 'bold'), align: styleOf(n, 'align'), valign: 'middle', color: colorsOf(n, P).text }; }
      case 'sticky': return { box: { x: n.x + 12, y: n.y + 10, w: n.w - 24, h: n.h - 20 }, fs: styleOf(n, 'fs'), bold: styleOf(n, 'bold'), align: styleOf(n, 'align'), valign: 'top', color: STICKY_INK };
      case 'text': { const key = styleOf(n, 'color'); return { box: { x: n.x, y: n.y + 2, w: n.w, h: n.h - 4 }, fs: styleOf(n, 'fs'), bold: styleOf(n, 'bold'), align: styleOf(n, 'align'), valign: 'top', color: key === 'default' ? rgbCss(P.text) : rgbCss(colorRgb(key, P)) }; }
      case 'frame': return { box: { x: n.x, y: n.y - 22, w: Math.max(n.w, 160), h: 17 }, fs: 12, bold: false, align: 'left', valign: 'top', color: rgbCss(P.textDim), bg: rgbCss(P.bg) };
      case 'ui': {
        const multi = n.ui === 'card' || n.ui === 'list' || n.ui === 'tabs' || n.ui === 'tabbar';
        return { box: { x: n.x + 8, y: n.y, w: Math.max(40, n.w - 16), h: n.h }, fs: styleOf(n, 'fs'), bold: styleOf(n, 'bold'), align: multi ? 'left' : styleOf(n, 'align'), valign: multi ? 'top' : 'middle', color: rgbCss(P.text), bg: multi ? rgbCss(P.panel) : null };
      }
      default: return null;
    }
  }
  function positionEditor() {
    if (!editing) { const n = sinkTarget(); if (n) positionSink(n); return; }
    const spec = editSpec();
    if (!spec) return;
    const z = view.zoom;
    const s = textEditor.style;
    s.fontSize = f2(spec.fs * z) + 'px';
    s.lineHeight = f2(lineH(spec.fs) * z) + 'px';
    s.fontWeight = spec.bold ? '700' : '400';
    s.textAlign = spec.align;
    s.color = spec.color;
    s.background = spec.bg || 'transparent';
    const w = Math.max(spec.box.w + (spec.extra || 2), spec.fs * 2) * z + 4;
    s.width = f2(w) + 'px';
    s.height = '0px';
    const hh = Math.max(textEditor.scrollHeight, lineH(spec.fs) * z);
    s.height = f2(hh) + 'px';
    const left = view.x + (spec.box.x + spec.box.w / 2) * z - w / 2;
    const top = spec.valign === 'middle' ? view.y + (spec.box.y + spec.box.h / 2) * z - hh / 2 : view.y + spec.box.y * z;
    s.left = f2(left) + 'px';
    s.top = f2(top) + 'px';
    if (editTip.classList.contains('is-shown')) {
      editTip.style.left = f2(Math.max(4, left)) + 'px';
      editTip.style.top = f2(top + hh + 6) + 'px';
    }
  }
  function showEditTip(kind) {
    const tips = {
      topic: 'Enter で確定 ／ Shift+Enter で改行 ／ Tab で確定して子を追加',
      edge: 'Enter で確定 ／ Esc でも確定',
      frame: 'Enter で確定',
      other: 'Esc か外をクリックで確定 ／ Ctrl+Enter でも確定',
    };
    editTip.textContent = tips[kind] || tips.other;
    editTip.classList.toggle('is-shown', useSink);
  }
  function beginEdit(id, opts) {
    const o = opts || {};
    if (editing) commitEdit();
    const n = nodeMap.get(id);
    if (!n || !editableText(n)) return;
    ensureLayout();
    let before;
    if (o.isNew && undoStack.length) { before = undoStack.pop(); updateUndoButtons(); } // 作成と最初の入力を1回の「元に戻す」にまとめる
    else before = snapshot();
    editing = { kind: n.type === 'frame' ? 'frame' : 'node', id, before };
    if (o.fromSink) n.text = textEditor.value.slice(0, MAX_TEXT); // 日本語入力の途中なので入力欄には触らない
    else textEditor.value = n.text;
    textEditor.classList.add('is-editing');
    guardTouchEditor();
    needsLayout = true;
    renderNow();
    if (document.activeElement !== textEditor) textEditor.focus({ preventScroll: true });
    if (!o.fromSink) {
      if (o.selectAll) textEditor.select();
      else { const L = textEditor.value.length; textEditor.setSelectionRange(L, L); }
    }
    showEditTip(n.type === 'topic' ? 'topic' : n.type === 'frame' ? 'frame' : 'other');
    positionEditor();
    updateSelBar();
  }
  // タッチで編集を始めた直後は、指を離したときの後追いのタップ（＝マウス互換のクリック）が
  // 出てきた入力欄に当たって文字が全選択されたりカーソルが動いたりするので、少しの間だけ受け付けない
  let touchGuardTimer = null;
  function guardTouchEditor() {
    if (Date.now() - lastTouchAt > 700) return;
    textEditor.style.pointerEvents = 'none';
    clearTimeout(touchGuardTimer);
    touchGuardTimer = setTimeout(() => { textEditor.style.pointerEvents = ''; }, 450);
  }
  function beginEditEdge(id) {
    if (editing) commitEdit();
    const ed = edgeMap.get(id);
    if (!ed) return;
    editing = { kind: 'edge', id, before: snapshot() };
    textEditor.value = ed.label;
    textEditor.classList.add('is-editing');
    guardTouchEditor();
    renderNow();
    textEditor.focus({ preventScroll: true });
    textEditor.select();
    showEditTip('edge');
    positionEditor();
    updateSelBar();
  }
  function applyEditValue() {
    if (!editing) return;
    const v = textEditor.value;
    if (editing.kind === 'edge') {
      const ed = edgeMap.get(editing.id);
      if (ed) ed.label = v.slice(0, 500);
    } else {
      const n = nodeMap.get(editing.id);
      if (n) { n.text = v.slice(0, MAX_TEXT); needsLayout = true; }
    }
    requestRender();
  }
  function commitEdit() {
    const ed = editing;
    if (!ed) return;
    applyEditValue();
    editing = null;
    composing = false;
    textEditor.classList.remove('is-editing');
    editTip.classList.remove('is-shown');
    textEditor.value = '';
    if (ed.kind === 'edge') {
      const e = edgeMap.get(ed.id);
      if (e && !e.label.trim()) e.label = '';
    } else {
      const n = nodeMap.get(ed.id);
      // 空のテキストノードは残さない
      if (n && n.type === 'text' && !n.text.trim()) {
        board.nodes = board.nodes.filter((x) => x.id !== n.id);
        board.edges = board.edges.filter((x) => x.from.node !== n.id && x.to.node !== n.id);
      }
    }
    afterModelChange();
    commitIfChanged(ed.before);
    updateSelBar();
    setTimeout(() => refocusCanvas(false), 0);
  }

  textEditor.addEventListener('input', () => {
    if (!editing) {
      const n = sinkTarget();
      if (!n) { textEditor.value = ''; return; }
      if (composing || !textEditor.value) return;
      beginEdit(n.id, { fromSink: true });
      return;
    }
    applyEditValue();
  });
  textEditor.addEventListener('compositionstart', () => {
    composing = true;
    if (!editing) { const n = sinkTarget(); if (n) beginEdit(n.id, { fromSink: true }); }
  });
  textEditor.addEventListener('compositionend', () => { composing = false; if (editing) applyEditValue(); });
  textEditor.addEventListener('keydown', (e) => {
    if (!editing) return; // 透明な待機中はキャンバスのショートカットとして扱う（document 側）
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    const n = editing.kind === 'node' ? nodeMap.get(editing.id) : null;
    if (e.key === 'Escape') { e.preventDefault(); commitEdit(); return; }
    if (n && n.type === 'topic') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); return; }
      if (e.key === 'Tab') { e.preventDefault(); const id = n.id; commitEdit(); addChildTopic(id); return; }
      return;
    }
    if (editing.kind === 'edge' || editing.kind === 'frame') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); return; }
    if (e.key === 'Tab') { e.preventDefault(); commitEdit(); }
  });
  textEditor.addEventListener('blur', () => { if (editing) commitEdit(); });

  /* =====================================================================
     マインドマップの操作
  ===================================================================== */
  function maxChildOrder(pid) {
    let m = -1;
    board.nodes.forEach((n) => { if (n.type === 'topic' && n.parent === pid) m = Math.max(m, n.order); });
    return m;
  }
  function newTopic(used, parent, text) {
    return {
      id: localId('n', used), type: 'topic', x: parent ? parent.x : 0, y: parent ? parent.y : 0, w: 80, h: 30,
      text: text || '', style: {}, locked: false, parent: parent ? parent.id : null,
      order: parent ? maxChildOrder(parent.id) + 1 : 0, collapsed: false, layout: 'both', side: '',
    };
  }
  // 左右レイアウトの中心に子を足すとき、トピックの少ない側を返す（足すたびに数を更新する）
  function sideBalancer(root) {
    ensureLayout();
    let r = 0, l = 0;
    (T.kids.get(root.id) || []).forEach((c) => {
      const cnt = 1 + descendants(c.id).length;
      if (T.dir.get(c.id) === 'l' || (T.hidden.has(c.id) && c.side === 'l')) l += cnt; else r += cnt;
    });
    return (size) => { const s = r <= l ? 'r' : 'l'; if (s === 'r') r += size || 1; else l += size || 1; return s; };
  }
  function addChildTopic(pid) {
    const p = nodeMap.get(pid);
    if (!p || p.type !== 'topic' || p.locked) return;
    if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
    ensureLayout();
    let id = null;
    mutate(() => {
      const n = newTopic(boardIdSet(), p, '');
      if (!p.parent && p.layout === 'both') n.side = sideBalancer(p)(1);
      p.collapsed = false;
      board.nodes.push(n);
      id = n.id;
    });
    setSelection([id]);
    beginEdit(id, { isNew: true });
  }
  function addSiblingTopic(tid) {
    const n = nodeMap.get(tid);
    if (!n || n.type !== 'topic') return;
    if (!n.parent) { addChildTopic(tid); return; }
    if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
    ensureLayout();
    let nid = null;
    mutate(() => {
      const p = nodeMap.get(n.parent);
      const sibs = board.nodes.filter((c) => c.type === 'topic' && c.parent === p.id).sort((a, b) => a.order - b.order);
      const t = newTopic(boardIdSet(), p, '');
      if (!p.parent && p.layout === 'both') t.side = T.dir.get(n.id) === 'l' ? 'l' : 'r';
      sibs.splice(sibs.findIndex((c) => c.id === n.id) + 1, 0, t);
      sibs.forEach((c, i) => { c.order = i; });
      board.nodes.push(t);
      nid = t.id;
    });
    setSelection([nid]);
    beginEdit(nid, { isNew: true });
  }
  function toggleCollapse(id) {
    const n = nodeMap.get(id);
    if (!n || n.type !== 'topic') return;
    ensureLayout();
    if (!(T.kids.get(id) || []).length) return;
    mutate(() => { n.collapsed = !n.collapsed; });
  }
  function ensureVisible(n) {
    const vb = visibleWorldBox(-40 / view.zoom);
    if (!boxInside({ x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }, vb)) centerOn(center(n));
  }
  function navTopic(n, key) {
    ensureLayout();
    const kids = (T.kids.get(n.id) || []).filter((c) => !T.hidden.has(c.id));
    const parent = n.parent ? nodeMap.get(n.parent) : null;
    const myDir = n.parent ? T.dir.get(n.id) : null;
    const sibs = parent ? (T.kids.get(parent.id) || []).filter((c) => !T.hidden.has(c.id) && T.dir.get(c.id) === myDir) : [];
    const idx = sibs.findIndex((c) => c.id === n.id);
    const firstKid = (side) => kids.find((c) => T.dir.get(c.id) === side);
    let t = null;
    if (childDir(n, T) === 'd' || myDir === 'd') {
      if (key === 'ArrowDown') t = kids[0];
      else if (key === 'ArrowUp') t = parent;
      else if (key === 'ArrowLeft') t = sibs[idx - 1];
      else if (key === 'ArrowRight') t = sibs[idx + 1];
    } else if (key === 'ArrowUp') t = sibs[idx - 1];
    else if (key === 'ArrowDown') t = sibs[idx + 1];
    else if (key === 'ArrowRight') t = !parent ? firstKid('r') : myDir === 'l' ? parent : kids[0];
    else if (key === 'ArrowLeft') t = !parent ? firstKid('l') : myDir === 'l' ? kids[0] : parent;
    if (t) { setSelection([t.id], { focus: true }); ensureVisible(t); }
  }
  function moveTopicOrder(n, delta) {
    if (!n.parent) return;
    ensureLayout();
    const myDir = T.dir.get(n.id);
    mutate(() => {
      const all = board.nodes.filter((c) => c.type === 'topic' && c.parent === n.parent).sort((a, b) => a.order - b.order);
      const same = all.filter((c) => T.dir.get(c.id) === myDir);
      const i = same.findIndex((c) => c.id === n.id);
      const other = same[i + delta];
      if (!other) return;
      const ai = all.indexOf(n), bi = all.indexOf(other);
      all[ai] = other; all[bi] = n;
      all.forEach((c, k) => { c.order = k; });
    });
    refocusCanvas(true);
  }
  function detachTopic(n) {
    if (!n || n.type !== 'topic' || !n.parent) return;
    ensureLayout();
    const root = nodeMap.get(T.root.get(n.id));
    mutate(() => {
      n.parent = null;
      n.side = '';
      n.layout = root ? root.layout : 'both';
      n.x += 40; n.y += 40;
    });
  }

  /* =====================================================================
     編集コマンド（削除・複製・重なり順・ロック・整列）
  ===================================================================== */
  function deleteSelection() {
    if (!selection.size) return;
    ensureLayout();
    const ids = new Set();
    let skipped = 0;
    selectedNodes().forEach((n) => {
      if (n.locked) { skipped++; return; }
      ids.add(n.id);
      if (n.type === 'topic') descendants(n.id).forEach((d) => ids.add(d));
    });
    const edgeIds = new Set(selectedEdges().map((e) => e.id));
    if (!ids.size && !edgeIds.size) { if (skipped) toast('ロック中のものは削除できません（Ctrl+L で解除）', 'warn'); return; }
    const one = singleNode();
    const next = one && one.type === 'topic' && one.parent && !one.locked ? one.parent : null;
    mutate(() => {
      board.nodes = board.nodes.filter((n) => !ids.has(n.id));
      board.edges = board.edges.filter((e) => !edgeIds.has(e.id) && !(e.from.node && ids.has(e.from.node)) && !(e.to.node && ids.has(e.to.node)));
    });
    setSelection(next ? [next] : [], { focus: true });
    const total = ids.size + edgeIds.size;
    if (total >= 3 || skipped) toast(`${total}個を削除しました（Ctrl+Z で元に戻せます）` + (skipped ? `\nロック中の${skipped}個は残しました` : ''), skipped ? 'warn' : undefined);
  }
  function selectAll() {
    ensureLayout();
    const ids = board.nodes.filter((n) => !T.hidden.has(n.id) && !n.locked).map((n) => n.id).concat(board.edges.filter((e) => geoCache.has(e.id)).map((e) => e.id));
    setSelection(ids, { focus: true });
  }
  function zOrder(mode) {
    const sel = new Set(selectedNodes().map((n) => n.id));
    if (!sel.size) return;
    mutate(() => {
      const arr = board.nodes;
      if (mode === 'front') board.nodes = arr.filter((n) => !sel.has(n.id)).concat(arr.filter((n) => sel.has(n.id)));
      else if (mode === 'back') board.nodes = arr.filter((n) => sel.has(n.id)).concat(arr.filter((n) => !sel.has(n.id)));
      else if (mode === 'forward') { for (let i = arr.length - 2; i >= 0; i--) if (sel.has(arr[i].id) && !sel.has(arr[i + 1].id)) { const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t; } }
      else if (mode === 'backward') { for (let i = 1; i < arr.length; i++) if (sel.has(arr[i].id) && !sel.has(arr[i - 1].id)) { const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t; } }
    });
  }
  function toggleLock() {
    const nodes = selectedNodes();
    if (!nodes.length) return;
    const lock = nodes.some((n) => !n.locked);
    mutate(() => nodes.forEach((n) => { n.locked = lock; }));
    toast(lock ? 'ロックしました（動かす・消す・書き換えることができなくなります）' : 'ロックを解除しました');
    scheduleInspector(true);
  }
  const movableSelected = () => selectedNodes().filter((n) => !n.locked && !(n.type === 'topic' && n.parent));
  // ノードを動かす（フレームなら中身も）。skip に入っているものは中身として動かさない
  function moveNodeBy(n, dx, dy, skip) {
    if (!dx && !dy) return;
    if (n.type === 'frame') {
      const fb = { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h };
      framedNodes(n).forEach((m) => { if (!skip || !skip.has(m.id)) { m.x += dx; m.y += dy; } });
      board.edges.forEach((e) => ['from', 'to'].forEach((k) => {
        const end = e[k];
        if (!end.node && end.x >= fb.x1 && end.x <= fb.x2 && end.y >= fb.y1 && end.y <= fb.y2) { end.x += dx; end.y += dy; }
      }));
    }
    n.x += dx; n.y += dy;
  }
  function alignNodes(mode) {
    const nodes = movableSelected();
    if (nodes.length < 2) return;
    let bb = null;
    nodes.forEach((n) => { bb = unionBox(bb, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }); });
    const skip = new Set(nodes.map((n) => n.id));
    mutate(() => nodes.forEach((n) => {
      let dx = 0, dy = 0;
      if (mode === 'left') dx = bb.x1 - n.x;
      else if (mode === 'hcenter') dx = (bb.x1 + bb.x2) / 2 - (n.x + n.w / 2);
      else if (mode === 'right') dx = bb.x2 - (n.x + n.w);
      else if (mode === 'top') dy = bb.y1 - n.y;
      else if (mode === 'vcenter') dy = (bb.y1 + bb.y2) / 2 - (n.y + n.h / 2);
      else if (mode === 'bottom') dy = bb.y2 - (n.y + n.h);
      moveNodeBy(n, Math.round(dx), Math.round(dy), skip);
    }));
  }
  function distributeNodes(axis) {
    const nodes = movableSelected();
    if (nodes.length < 3) return;
    const k = axis === 'h' ? 'x' : 'y', s = axis === 'h' ? 'w' : 'h';
    const sorted = nodes.slice().sort((a, b) => a[k] - b[k]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const span = last[k] + last[s] - first[k];
    const total = sorted.reduce((a, n) => a + n[s], 0);
    const gap = (span - total) / (sorted.length - 1);
    const skip = new Set(nodes.map((n) => n.id));
    mutate(() => {
      let pos = first[k];
      sorted.forEach((n) => {
        const d = Math.round(pos - n[k]);
        moveNodeBy(n, axis === 'h' ? d : 0, axis === 'v' ? d : 0, skip);
        pos += n[s] + gap;
      });
    });
  }
  // 選んだ図形を、線のつながりから階層的に並べ直す（フローチャート向け）
  function autoArrange(dir) {
    const nodes = selectedNodes().filter((n) => !n.locked && n.type !== 'topic' && n.type !== 'frame');
    if (nodes.length < 2) { toast('図形を2つ以上選んでください', 'warn'); return; }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = board.edges.filter((e) => e.from.node && e.to.node && ids.has(e.from.node) && ids.has(e.to.node));
    const pos = IO.layered(nodes.map((n) => ({ id: n.id, w: n.w, h: n.h })), edges.map((e) => ({ from: e.from.node, to: e.to.node })), dir, { layerGap: 56, nodeGap: 40 });
    let bb = null;
    nodes.forEach((n) => { bb = unionBox(bb, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }); });
    mutate(() => {
      nodes.forEach((n) => { const p = pos.get(n.id); if (p) { n.x = Math.round(bb.x1 + p.x); n.y = Math.round(bb.y1 + p.y); } });
      edges.forEach((e) => setFlowSides(e, nodeMap.get(e.from.node), nodeMap.get(e.to.node), dir));
    });
    if (!edges.length) toast('線でつながっていないため、並べるだけにしました');
  }
  // 流れの向きに沿った線は、決まった辺から出入りさせる（見た目を揃える）
  function setFlowSides(e, a, b, dir) {
    if (!a || !b) return;
    let fs = 'a', ts = 'a';
    const down = b.y >= a.y + a.h * 0.5, up = b.y + b.h <= a.y + a.h * 0.5;
    const right = b.x >= a.x + a.w * 0.5, left = b.x + b.w <= a.x + a.w * 0.5;
    if (dir === 'TD' && down) { fs = 'b'; ts = 't'; }
    else if (dir === 'BT' && up) { fs = 't'; ts = 'b'; }
    else if (dir === 'LR' && right) { fs = 'r'; ts = 'l'; }
    else if (dir === 'RL' && left) { fs = 'l'; ts = 'r'; }
    // 流れに逆らって戻る線（ループ）は、図形を横切らないよう外側を回す
    else if ((dir === 'TD' && up) || (dir === 'BT' && down)) { fs = 'r'; ts = 'r'; }
    else if ((dir === 'LR' && left) || (dir === 'RL' && right)) { fs = 'b'; ts = 'b'; }
    e.from.side = fs;
    e.to.side = ts;
  }
  // 矢印キーでの微調整（続けて押した分は1回の「元に戻す」にまとめる）
  let nudgeState = null;
  function nudge(key, big) {
    const nodes = movableSelected();
    const edges = selectedEdges();
    if (!nodes.length && !edges.length) return;
    const step = big ? 10 : board.settings.snap ? GRID : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    if (!nudgeState) nudgeState = { before: snapshot(), timer: null };
    const skip = new Set(nodes.map((n) => n.id));
    nodes.forEach((n) => moveNodeBy(n, dx, dy, skip));
    edges.forEach((e) => ['from', 'to'].forEach((k) => { if (!e[k].node) { e[k].x += dx; e[k].y += dy; } }));
    afterModelChange();
    clearTimeout(nudgeState.timer);
    nudgeState.timer = setTimeout(() => { const st = nudgeState; nudgeState = null; if (board) commitIfChanged(st.before); }, 600);
  }
  function flushNudge() {
    if (!nudgeState) return;
    clearTimeout(nudgeState.timer);
    const st = nudgeState;
    nudgeState = null;
    if (board) commitIfChanged(st.before);
  }

  /* =====================================================================
     キーボード
  ===================================================================== */
  function isTypingTarget(t) {
    if (!t || t === document.body) return false;
    if (t === textEditor) return !!editing;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(t.type);
    return !!t.isContentEditable;
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (confirmOpen()) { e.preventDefault(); closeConfirm(null); return; }
      if (closeTopModal()) { e.preventDefault(); return; }
      if (menuPanel.classList.contains('is-open')) { closeMenu(); return; }
      if (anyFlyoutOpen()) { closeFlyouts(); return; }
    }
    if (confirmOpen() || anyModalOpen()) return;
    if (currentView !== 'editor' || !board || editing) return;
    const t = e.target;
    const inSink = t === textEditor;
    if (!inSink && isTypingTarget(t)) return;
    if (e.isComposing || e.keyCode === 229) return;
    canvasKey(e, inSink);
  }
  function canvasKey(e, inSink) {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const one = singleNode();
    const topic = one && one.type === 'topic' && !one.locked ? one : null;
    if (e.code === 'Space' && !ctrl) {
      if (!e.repeat && !spaceDown) { spaceDown = true; updateCursor(); }
      e.preventDefault();
      return;
    }
    if (ctrl) {
      const k = key.toLowerCase();
      if (k === 'z') { e.preventDefault(); flushNudge(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === 'y') { e.preventDefault(); flushNudge(); redo(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (k === 'a') { e.preventDefault(); selectAll(); return; }
      if (k === 'l') { e.preventDefault(); toggleLock(); return; }
      if (k === 'f') { e.preventDefault(); openSearch(); return; }
      if (k === 's') { e.preventDefault(); flushAll(); toast(dbReady ? '保存しました' : 'このブラウザでは保存できません', dbReady ? undefined : 'warn'); return; }
      if (k === '/') { e.preventDefault(); if (topic) toggleCollapse(topic.id); return; }
      if (key === ']' || key === '}') { e.preventDefault(); zOrder(e.shiftKey ? 'front' : 'forward'); return; }
      if (key === '[' || key === '{') { e.preventDefault(); zOrder(e.shiftKey ? 'back' : 'backward'); return; }
      if (key === '=' || key === '+' || key === ';') { e.preventDefault(); zoomBy(1.2); return; }
      if (key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
      if (key === '0') { e.preventDefault(); setZoom100(); return; }
      return; // Ctrl+C / X / V は copy・cut・paste イベントで扱う
    }
    if (e.altKey && topic && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
      e.preventDefault();
      const down = T.dir.get(topic.id) === 'd';
      const delta = down ? (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0) : (key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0);
      if (delta) moveTopicOrder(topic, delta);
      return;
    }
    switch (key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault(); deleteSelection(); return;
      case 'Escape':
        e.preventDefault();
        if (act) cancelAct();
        else if (tool !== 'select') setTool('select');
        else if (search.open) closeSearch();
        else if (selection.size) setSelection([], { focus: true });
        return;
      case 'Tab':
        e.preventDefault();
        if (topic) addChildTopic(topic.id);
        return;
      case 'Enter':
        e.preventDefault();
        if (topic) addSiblingTopic(topic.id);
        else if (one && editableText(one)) beginEdit(one.id, {});
        else if (singleEdge()) beginEditEdge(singleEdge().id);
        return;
      case 'F2':
        e.preventDefault();
        if (one && editableText(one)) beginEdit(one.id, {});
        else if (singleEdge()) beginEditEdge(singleEdge().id);
        return;
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
        e.preventDefault();
        if (topic) navTopic(topic, key); else nudge(key, e.shiftKey);
        return;
      default: break;
    }
    // 表示の切り替え（Shift+1/2/0）は、トピックを選んでいても入力より優先する（「!」などが入ってしまう事故を防ぐ）
    if (e.shiftKey && !e.altKey && e.code === 'Digit1') { e.preventDefault(); fitAll(); return; }
    if (e.shiftKey && !e.altKey && e.code === 'Digit2') { e.preventDefault(); fitSelection(); return; }
    if (e.shiftKey && !e.altKey && e.code === 'Digit0') { e.preventDefault(); setZoom100(); return; }
    if (inSink || e.altKey) return; // トピック選択中の文字キーはそのまま入力になる
    if (key === '?') { e.preventDefault(); openModal('helpModal'); return; }
    if (e.shiftKey) return;
    const map = { KeyV: 'select', KeyH: 'hand', KeyM: 'topic', KeyR: 'shape', KeyN: 'sticky', KeyT: 'text', KeyA: 'arrow', KeyF: 'frame' };
    if (map[e.code]) { e.preventDefault(); setTool(map[e.code]); return; }
    if (e.code === 'KeyU') { e.preventDefault(); setTool('ui'); openFlyout('flyUi'); return; }
    if (e.code === 'KeyI') { e.preventDefault(); pickImage(); }
  }
  function setZoom100() { const r = stageRect(); zoomAt(r.width / 2, r.height / 2, 1); }
  function fitSelection() {
    if (!selection.size) { fitAll(); return; }
    const b = contentBox(selection);
    if (b) fitBox(b, 2);
  }

  /* =====================================================================
     クリップボード（ノードのコピー・貼り付け、画像・文字の貼り付け）
  ===================================================================== */
  function clipboardTarget() {
    if (currentView !== 'editor' || !board || editing || anyModalOpen() || confirmOpen()) return false;
    const a = document.activeElement;
    return !a || a === document.body || a === canvasWrap || a === textEditor || toolRail.contains(a);
  }
  function treeOf(n) { return { text: n.text, children: (T.kids.get(n.id) || []).map(treeOf) }; }
  function buildClip() {
    ensureLayout();
    if (!selection.size) return null;
    const ids = new Set();
    selectedNodes().forEach((n) => {
      ids.add(n.id);
      if (n.type === 'topic') descendants(n.id).forEach((d) => ids.add(d));
      if (n.type === 'frame') framedNodes(n).forEach((m) => { ids.add(m.id); if (m.type === 'topic') descendants(m.id).forEach((d) => ids.add(d)); });
    });
    const nodes = board.nodes.filter((n) => ids.has(n.id));
    const edges = board.edges.filter((e) => selection.has(e.id) || (e.from.node && e.to.node && ids.has(e.from.node) && ids.has(e.to.node)))
      .map((e) => { const g = geoCache.get(e.id); const c = JSON.parse(JSON.stringify(e)); if (g) { c._p1 = { x: g.p1.x, y: g.p1.y }; c._p2 = { x: g.p2.x, y: g.p2.y }; } return c; });
    if (!nodes.length && !edges.length) return null;
    const images = [];
    nodes.forEach((n) => { if (n.type === 'image' && n.imageId) { const c = imageCache.get(n.imageId); if (c) images.push(c.rec); } });
    // 文字としても使えるように：トピックは箇条書き、それ以外は1行ずつ
    const roots = nodes.filter((n) => n.type === 'topic' && !(n.parent && ids.has(n.parent)));
    const parts = [];
    if (roots.length) parts.push(IO.toOutline(roots.map(treeOf)));
    nodes.forEach((n) => { if (n.type !== 'topic' && n.text && n.type !== 'image') parts.push(n.text); });
    const text = parts.join('\n') || ' ';
    const data = { app: APP_KEY, v: 1, nodes: JSON.parse(JSON.stringify(nodes)), edges };
    return { data, text, images, raw: JSON.stringify(data) };
  }
  function pastePoint() { return pointerInCanvas && lastPointer ? lastPointer : viewCenterWorld(); }
  function pasteClip(data, mem, opts) {
    const o = opts || {};
    if (!data || !Array.isArray(data.nodes)) return;
    const srcNodes = data.nodes.map(normalizeNode).filter(Boolean);
    const srcEdges = Array.isArray(data.edges) ? data.edges : [];
    if (!srcNodes.length && !srcEdges.length) return;
    if (board.nodes.length + srcNodes.length > MAX_NODES) { toastLimit(); return; }
    ensureLayout();
    const used = boardIdSet();
    const idMap = new Map();
    srcNodes.forEach((n) => idMap.set(n.id, localId('n', used)));
    // 画像は新しいIDで複製する（ボードごとに持つ）
    const imgMap = new Map();
    const imgUsed = new Set(imageCache.keys());
    srcNodes.forEach((n) => {
      if (n.type !== 'image' || !n.imageId || imgMap.has(n.imageId)) return;
      const rec = (mem && mem.images.find((r) => r.id === n.imageId)) || (imageCache.get(n.imageId) || {}).rec;
      if (!rec) return;
      const nid = genId('im', imgUsed);
      imgUsed.add(nid);
      const r = { id: nid, boardId: board.id, blob: rec.blob, type: rec.type, name: rec.name, w: rec.w, h: rec.h, createdAt: Date.now() };
      imgMap.set(n.imageId, nid);
      cacheImage(r);
      if (dbReady) dbPut(S.images, r).catch((err) => { console.error(err); toast('画像を保存できませんでした', 'error'); });
    });
    let bb = null;
    srcNodes.forEach((n) => { if (!(n.type === 'topic' && n.parent && idMap.has(n.parent))) bb = unionBox(bb, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }); });
    srcEdges.forEach((e) => ['from', 'to'].forEach((k) => { const end = e[k]; if (end && !end.node && isFinite(end.x) && isFinite(end.y)) bb = unionBox(bb, { x1: end.x, y1: end.y, x2: end.x, y2: end.y }); }));
    let dx = 0, dy = 0;
    if (o.offset) { dx = o.offset; dy = o.offset; }
    else if (bb) { const tp = pastePoint(); dx = Math.round(tp.x - (bb.x1 + bb.x2) / 2); dy = Math.round(tp.y - (bb.y1 + bb.y2) / 2); }
    let parentTarget = o.parentId ? nodeMap.get(o.parentId) : null;
    const hasRootTopics = srcNodes.some((n) => n.type === 'topic' && !(n.parent && idMap.has(n.parent)));
    if (!o.parentId && !o.offset && hasRootTopics) { const one = singleNode(); if (one && one.type === 'topic' && !one.locked) parentTarget = one; }
    const newIds = [];
    mutate(() => {
      const balance = parentTarget && !parentTarget.parent && parentTarget.layout === 'both' ? sideBalancer(parentTarget) : null;
      let order = parentTarget ? maxChildOrder(parentTarget.id) + 1 : 0;
      const pastedRoots = [];
      srcNodes.forEach((n) => {
        const c = Object.assign({}, n, { id: idMap.get(n.id), x: n.x + dx, y: n.y + dy, style: Object.assign({}, n.style), locked: false });
        let isRoot = true;
        if (c.type === 'topic') {
          if (n.parent && idMap.has(n.parent)) { c.parent = idMap.get(n.parent); isRoot = false; }
          else if (parentTarget) { c.parent = parentTarget.id; c.order = order++; c.side = balance ? balance(1) : ''; pastedRoots.push(c); }
          else { c.parent = null; c.side = ''; }
        }
        if (c.type === 'image') c.imageId = imgMap.get(n.imageId) || '';
        board.nodes.push(c);
        if (isRoot) newIds.push(c.id);
      });
      srcEdges.forEach((e0) => {
        const e = normalizeEdge(Object.assign({}, e0, { id: localId('e', used) }));
        if (!e) return;
        const fix = (end, p) => {
          if (end.node) return idMap.has(end.node) ? { node: idMap.get(end.node), side: end.side } : (p ? { x: Math.round(p.x + dx), y: Math.round(p.y + dy) } : null);
          return { x: end.x + dx, y: end.y + dy };
        };
        const from = fix(e.from, e0._p1), to = fix(e.to, e0._p2);
        if (!from || !to) return;
        e.from = from; e.to = to;
        board.edges.push(e);
        newIds.push(e.id);
      });
      if (parentTarget) {
        parentTarget.collapsed = false;
        if (o.afterId && pastedRoots.length) {
          const all = board.nodes.filter((c) => c.type === 'topic' && c.parent === parentTarget.id && !pastedRoots.includes(c)).sort((a, b) => a.order - b.order);
          all.splice(all.findIndex((c) => c.id === o.afterId) + 1, 0, ...pastedRoots);
          all.forEach((c, i) => { c.order = i; });
          if (!parentTarget.parent && parentTarget.layout === 'both') { const ref = nodeMap.get(o.afterId); pastedRoots.forEach((c) => { c.side = ref ? ref.side || (T.dir.get(ref.id) === 'l' ? 'l' : 'r') : c.side; }); }
        }
      }
    });
    setSelection(newIds, { focus: true });
  }
  function duplicateSelection() {
    const clip = buildClip();
    if (!clip) return;
    const one = singleNode();
    if (one && one.type === 'topic' && one.parent) { pasteClip(clip.data, clip, { parentId: one.parent, afterId: one.id }); return; }
    pasteClip(clip.data, clip, { offset: 24 });
  }
  function onCopy(e, cut) {
    if (!clipboardTarget()) return;
    const clip = buildClip();
    if (!clip) return;
    e.preventDefault();
    try {
      e.clipboardData.setData('text/plain', clip.text);
      e.clipboardData.setData(CLIP_MIME, clip.raw);
    } catch (err) { /* 独自形式を受け付けない環境：アプリ内のクリップボードだけで扱う */ }
    memClip = clip;
    if (cut) deleteSelection();
    else toast('コピーしました');
  }
  function onPaste(e) {
    if (!clipboardTarget()) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files || []).filter((f) => IMAGE_TYPES.includes(f.type));
    if (files.length) { e.preventDefault(); addImages(files, pastePoint()); return; }
    let raw = '';
    try { raw = dt.getData(CLIP_MIME); } catch (err) { raw = ''; }
    const text = dt.getData('text/plain') || '';
    if (raw) {
      let data = null;
      try { data = JSON.parse(raw); } catch (err) { data = null; }
      if (data && data.app === APP_KEY) { e.preventDefault(); pasteClip(data, memClip && memClip.raw === raw ? memClip : null); return; }
    }
    if (memClip && text && text === memClip.text) { e.preventDefault(); pasteClip(memClip.data, memClip); return; }
    if (text.trim()) { e.preventDefault(); pasteText(text); }
  }
  function pasteText(raw) {
    const text = raw.replace(/\r\n?/g, '\n');
    const fmt = IO.detectFormat(text);
    const one = singleNode();
    if (fmt === 'mermaid') { addTextToBoard(text, 'mermaid', pastePoint()); toast('Mermaid を図にしました（Ctrl+Z で取り消せます）'); return; }
    if (one && one.type === 'topic' && !one.locked) {
      const forest = fmt === 'mindmap' ? IO.parseMindmap(text) : IO.parseOutline(text);
      addForestUnder(one, forest.length ? forest : [{ text: text.trim().slice(0, MAX_TEXT), children: [] }]);
      return;
    }
    const lines = text.split('\n').filter((l) => l.trim());
    const outlineLike = fmt === 'mindmap' || (lines.length >= 2 && lines.some((l) => /^\s*(?:[-*+・]|\d{1,3}[.)]|#{1,6})\s/.test(l) || /^\s+\S/.test(l)));
    if (outlineLike) { addTextToBoard(text, fmt, pastePoint()); return; }
    if (board.nodes.length >= MAX_NODES) { toastLimit(); return; }
    const p = pastePoint();
    let id = null;
    mutate(() => {
      const t = text.trim().slice(0, MAX_TEXT);
      const w = clamp(Math.ceil(linesWidth(t.split('\n'), 14, false)) + 8, 60, 480);
      const n = { id: localId('n', boardIdSet()), type: 'text', x: Math.round(p.x - w / 2), y: Math.round(p.y - 12), w, h: 24, text: t, style: {}, locked: false };
      board.nodes.push(n);
      id = n.id;
    });
    setSelection([id], { focus: true });
  }
  function addForestUnder(parent, forest) {
    let count = 0;
    const cnt = (t) => { count++; t.children.forEach(cnt); };
    forest.forEach(cnt);
    if (board.nodes.length + count > MAX_NODES) { toastLimit(); return; }
    const ids = [];
    mutate(() => {
      const used = boardIdSet();
      const balance = !parent.parent && parent.layout === 'both' ? sideBalancer(parent) : null;
      let order = maxChildOrder(parent.id) + 1;
      const make = (item, pid, ord, side) => {
        const n = { id: localId('n', used), type: 'topic', x: parent.x, y: parent.y, w: 80, h: 30, text: String(item.text || '').slice(0, MAX_TEXT), style: {}, locked: false, parent: pid, order: ord, collapsed: false, layout: 'both', side: side || '' };
        board.nodes.push(n);
        item.children.forEach((c, i) => make(c, n.id, i, ''));
        return n;
      };
      forest.forEach((t) => {
        let size = 0;
        const c2 = (x) => { size++; x.children.forEach(c2); };
        c2(t);
        ids.push(make(t, parent.id, order++, balance ? balance(size) : '').id);
      });
      parent.collapsed = false;
    });
    setSelection(ids.length === 1 ? ids : [parent.id], { focus: true });
    if (count > 1) toast(`トピックを${count}個追加しました`);
  }

  /* ---- 画像 ---- */
  function readDims(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { const r = { w: img.naturalWidth, h: img.naturalHeight }; URL.revokeObjectURL(url); resolve(r.w && r.h ? r : null); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  async function addImages(files, at) {
    if (!board) return;
    const ok = [];
    if (files.length > 20) toast(`一度に置ける画像は20枚までです（${files.length - 20}枚は置きませんでした）`, 'warn');
    for (const f of files.slice(0, 20)) {
      if (!IMAGE_TYPES.includes(f.type)) { toast('置ける画像は PNG・JPEG・WebP・GIF です', 'warn'); continue; }
      if (f.size > IMAGE_MAX_BYTES) { toast(`画像が大きすぎます（5MBまで）${f.name ? '：' + f.name : ''}`, 'warn'); continue; }
      const dims = await readDims(f);
      if (!dims) { toast('画像として読み込めませんでした（ファイルが壊れているか、形式が違います）', 'error'); continue; }
      ok.push({ file: f, dims });
    }
    if (!ok.length) return;
    if (board.nodes.length + ok.length > MAX_NODES) { toastLimit(); return; }
    const used = new Set(imageCache.keys());
    const recs = ok.map(({ file, dims }) => {
      const id = genId('im', used);
      used.add(id);
      return { id, boardId: board.id, blob: file, type: file.type, name: str(file.name || 'image', 200), w: dims.w, h: dims.h, createdAt: Date.now() };
    });
    try {
      for (const r of recs) { if (dbReady) await dbPut(S.images, r); cacheImage(r); }
    } catch (err) {
      console.error('画像の保存に失敗しました', err);
      toast('画像を保存できませんでした。容量不足の可能性があります', 'error');
      return;
    }
    const ids = [];
    mutate(() => {
      const nid = boardIdSet();
      recs.forEach((r, i) => {
        const w = Math.min(r.w, 480), hh = Math.max(4, Math.round(w * r.h / r.w));
        const n = { id: localId('n', nid), type: 'image', x: Math.round(at.x - w / 2 + i * 24), y: Math.round(at.y - hh / 2 + i * 24), w, h: hh, text: '', style: {}, locked: false, imageId: r.id, iw: r.w, ih: r.h };
        board.nodes.push(n);
        ids.push(n.id);
      });
    });
    setSelection(ids, { focus: true });
  }
  function pickImage() {
    if (!board) return;
    setTool('select');
    $('imageFile').click();
  }
  // 使われなくなった画像を消す（ボードを閉じたとき・起動時。元に戻す履歴は閉じると消えるので安全）
  async function gcImages(onlyBoardId) {
    if (!dbReady) return;
    const used = new Set();
    const alive = new Set(boards.map((b) => b.id));
    boards.forEach((b) => b.nodes.forEach((n) => { if (n.type === 'image' && n.imageId) used.add(n.imageId); }));
    const all = await dbGetAll(S.images);
    for (const r of all) {
      if (onlyBoardId && r.boardId !== onlyBoardId) continue;
      if (!alive.has(r.boardId) || !used.has(r.id)) await dbDelSafe(S.images, r.id);
    }
  }

  /* ---- ボード内の検索 ---- */
  function openSearch() {
    if (!board) return;
    search.open = true;
    $('searchBox').classList.add('is-open');
    const inp = $('searchInput');
    inp.focus();
    inp.select();
    runSearch();
  }
  function closeSearch() {
    search.open = false;
    search.hits = [];
    search.idx = -1;
    $('searchBox').classList.remove('is-open');
    requestRender();
    refocusCanvas(true);
  }
  function runSearch() {
    const q = norm($('searchInput').value.trim());
    search.hits = [];
    search.idx = -1;
    if (q && board) {
      search.hits = board.nodes.filter((n) => n.text && norm(n.text).includes(q)).sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id);
    }
    if (search.hits.length) gotoHit(0);
    else { $('searchCount').textContent = q ? '0件' : ''; requestRender(); }
  }
  function gotoHit(i) {
    if (!search.hits.length) return;
    search.idx = ((i % search.hits.length) + search.hits.length) % search.hits.length;
    const id = search.hits[search.idx];
    $('searchCount').textContent = `${search.idx + 1}/${search.hits.length}`;
    ensureLayout();
    if (T.hidden.has(id)) {
      // 折りたたまれた枝の中：親をたどって開く
      mutate(() => { let p = nodeMap.get(nodeMap.get(id).parent); while (p) { p.collapsed = false; p = p.parent ? nodeMap.get(p.parent) : null; } });
      ensureLayout();
    }
    const n = nodeMap.get(id);
    if (!n) return;
    selection = new Set([id]);
    selectionChanged();
    centerOn(center(n));
  }

  /* =====================================================================
     詳細パネル（右。スマホでは下から出る）
  ===================================================================== */
  let inspQueued = false;
  function scheduleInspector() {
    if (inspQueued) return;
    inspQueued = true;
    requestAnimationFrame(() => { inspQueued = false; renderInspector(); });
  }
  const insSec = (title, first) => h('div', { class: 'insp-sec' + (first ? ' first' : '') }, title ? h('div', { class: 'insp-title', text: title }) : null);
  function segCtl(options, current, onPick, disabled) {
    return h('div', { class: 'seg' }, options.map(([v, label, tip]) => h('button', {
      type: 'button', class: current === v ? 'is-on' : '', text: label, title: tip || label, disabled: !!disabled,
      onclick: (e) => { e.currentTarget.blur(); onPick(v); },
    })));
  }
  function insBtn(label, onClick, cls, tip) {
    return h('button', { type: 'button', class: 'btn small ' + (cls || ''), text: label, title: tip || null, onclick: (e) => { e.currentTarget.blur(); onClick(); } });
  }
  function iconBtn(name, tip, onClick, disabled) {
    return h('button', { type: 'button', title: tip, 'aria-label': tip, disabled: !!disabled, onclick: (e) => { e.currentTarget.blur(); onClick(); } }, icon(name));
  }
  function common(list, fn) {
    if (!list.length) return undefined;
    const v = fn(list[0]);
    return list.every((x) => fn(x) === v) ? v : undefined;
  }
  function applyStyle(list, key, value) {
    mutate(() => list.forEach((n) => {
      if (n.locked) return;
      if (value == null) delete n.style[key]; else n.style[key] = value;
    }));
    scheduleInspector();
  }
  function swatches(keys, colorOf, current, onPick, auto) {
    const row = h('div', { class: 'swatches' });
    if (auto) row.appendChild(h('button', { type: 'button', class: 'swatch auto' + (current === null ? ' is-on' : ''), title: '自動（枝ごとの色）', 'aria-label': '自動', onclick: (e) => { e.currentTarget.blur(); onPick(null); } }));
    keys.forEach((k) => row.appendChild(h('button', {
      type: 'button', class: 'swatch' + (current === k ? ' is-on' : ''), title: colorOf.label(k), 'aria-label': colorOf.label(k),
      style: `background:${colorOf.css(k)}`, onclick: (e) => { e.currentTarget.blur(); onPick(k); },
    })));
    return row;
  }
  const genericColors = { label: (k) => COLOR_LABEL[k], css: (k) => (k === 'default' ? rgbCss(pal.panel) : rgbCss(colorRgb(k, pal))) };
  const stickyColors = { label: (k) => STICKY_LABEL[k], css: (k) => STICKY_COLORS[k] };
  function numField(label, value, onCommit, disabled) {
    const inp = h('input', { type: 'number', value: String(Math.round(value)), step: 1, disabled: !!disabled, 'aria-label': label });
    inp.addEventListener('change', () => { const v = Number(inp.value); if (isFinite(v)) onCommit(v); else inp.value = String(Math.round(value)); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    return h('label', { class: 'num-field' }, h('span', { text: label }), inp);
  }

  function renderInspector() {
    if (currentView !== 'editor' || !board) return;
    if (act) return; // 操作中は作り直さない（離したときに作り直す）
    const a = document.activeElement;
    if (a && inspector.contains(a) && isTypingTarget(a)) return; // 入力中は作り直さない
    ensureLayout();
    inspector.textContent = '';
    const nodes = selectedNodes();
    const edges = selectedEdges();
    const close = h('button', { type: 'button', class: 'sq-btn insp-close', text: '✕', 'aria-label': '閉じる', onclick: () => { inspector.classList.remove('is-sheet-open'); applyInspectorVisibility(); } });
    if (!nodes.length && !edges.length) { buildBoardPanel(close); return; }
    if (nodes.length) buildNodePanel(nodes, edges, close);
    else buildEdgePanel(edges, close);
  }

  function buildBoardPanel(close) {
    inspector.appendChild(h('div', { class: 'insp-head' }, 'ボード', h('span', { class: 'sub', text: `${board.nodes.length}個・線${board.edges.length}本` }), close));
    const s1 = insSec('種類（一覧での分類）', true);
    const sel = h('select', { class: 'insp-select', 'aria-label': 'ボードの種類' }, Object.keys(KINDS).map((k) => h('option', { value: k, text: KINDS[k] })));
    sel.value = board.kind;
    sel.addEventListener('change', () => { board.kind = KINDS[sel.value] ? sel.value : 'free'; markDirty(); });
    s1.appendChild(sel);
    inspector.appendChild(s1);
    const s2 = insSec('表示');
    const check = (label, key, tip) => {
      const c = h('input', { type: 'checkbox', checked: !!board.settings[key] });
      c.addEventListener('change', () => { board.settings[key] = c.checked; markDirty(); requestRender(); });
      return h('label', { class: 'insp-check', title: tip || '' }, c, label);
    };
    s2.appendChild(check('グリッドを表示', 'grid'));
    s2.appendChild(check('グリッドに吸着（20px）', 'snap', 'ドラッグ・大きさ変更をグリッドに合わせます'));
    s2.appendChild(check('ガイド線に吸着', 'guides', '他の要素のふち・中心にそろえます（Alt を押している間は無効）'));
    inspector.appendChild(s2);
    const s3 = insSec('はじめ方');
    s3.appendChild(h('div', { class: 'insp-note' },
      h('div', { text: '・マインドマップ：左の ' }, h('kbd', { text: 'M' }), ' で中心トピック → ', h('kbd', { text: 'Tab' }), ' で子、', h('kbd', { text: 'Enter' }), ' で兄弟'),
      h('div', { text: '・フローチャート：' }, h('kbd', { text: 'R' }), ' で図形 → ふちの○をクリック／ドラッグでつなぐ'),
      h('div', { text: '・UIラフ：' }, h('kbd', { text: 'F' }), ' で画面フレーム → ', h('kbd', { text: 'U' }), ' でUI部品'),
      h('div', { text: '・空いている所をダブルクリックで文字、貼り付けで画像・箇条書き・Mermaid' })));
    s3.appendChild(h('div', { style: 'margin-top:8px' }, insBtn('使い方・ショートカット', () => openModal('helpModal'))));
    inspector.appendChild(s3);
    const s4 = insSec('情報');
    s4.appendChild(h('div', { class: 'insp-note' }, h('div', { text: `作成：${formatDateTime(board.createdAt)}` }), h('div', { text: `更新：${formatDateTime(board.updatedAt)}` }), h('div', { text: `ID：${board.id}` })));
    inspector.appendChild(s4);
  }

  function buildNodePanel(nodes, edges, close) {
    const one = nodes.length === 1 && !edges.length ? nodes[0] : null;
    const title = one ? (one.type === 'shape' ? `図形（${SHAPES[one.shape].label}）` : one.type === 'ui' ? `UI部品（${UI_KIT[one.ui].label}）` : TYPE_LABEL[one.type]) : `${nodes.length + edges.length}個を選択中`;
    inspector.appendChild(h('div', { class: 'insp-head' }, title, close));
    const editable = nodes.filter((n) => !n.locked);
    if (!editable.length) {
      const s = insSec('ロック中', true);
      s.appendChild(h('div', { class: 'insp-note', text: 'ロック中は動かす・消す・書き換えることができません。下敷きの画像などに使えます。' }));
      s.appendChild(h('div', { style: 'margin-top:8px' }, insBtn('ロックを解除', toggleLock, 'primary')));
      inspector.appendChild(s);
      return;
    }
    // マインドマップ
    if (one && one.type === 'topic') inspector.appendChild(topicSection(one));
    // 図形の種類
    if (editable.every((n) => n.type === 'shape')) {
      const s = insSec('形');
      const sel = h('select', { class: 'insp-select', 'aria-label': '形' }, SHAPE_ORDER.map((k) => h('option', { value: k, text: SHAPES[k].label })));
      const cur = common(editable, (n) => n.shape);
      sel.value = cur || '';
      sel.addEventListener('change', () => { if (SHAPES[sel.value]) { mutate(() => editable.forEach((n) => { n.shape = sel.value; })); sel.blur(); } });
      s.appendChild(sel);
      inspector.appendChild(s);
    }
    if (one && one.type === 'ui' && UI_KIT[one.ui].toggle) {
      const s = insSec('状態');
      const c = h('input', { type: 'checkbox', checked: !!one.on });
      c.addEventListener('change', () => mutate(() => { one.on = c.checked; }));
      s.appendChild(h('label', { class: 'insp-check' }, c, one.ui === 'tabs' || one.ui === 'tabbar' ? '先頭を選択中にする' : 'オンの状態で表示'));
      if (['tabs', 'tabbar', 'list'].includes(one.ui)) s.appendChild(h('div', { class: 'insp-note', text: '項目は「|」か改行で区切ります（ダブルクリックで編集）' }));
      inspector.appendChild(s);
    }
    if (one && one.type === 'frame') inspector.appendChild(frameSection(one));
    if (one && one.type === 'image') inspector.appendChild(imageSection(one));
    // 色
    const stickies = editable.filter((n) => n.type === 'sticky');
    const colorable = editable.filter((n) => n.type !== 'sticky' && n.type !== 'image');
    if (stickies.length) {
      const s = insSec('付箋の色');
      s.appendChild(swatches(STICKY_KEYS, stickyColors, common(stickies, (n) => styleOf(n, 'color')), (k) => { stickyColor = k; applyStyle(stickies, 'color', k); }));
      inspector.appendChild(s);
    }
    if (colorable.length || edges.length) {
      const s = insSec('色');
      const topicsOnly = colorable.length && colorable.every((n) => n.type === 'topic');
      const cur = common(colorable.concat(edges), (n) => (n.type === 'topic' ? (n.style.color || null) : n.style && n.style.color != null ? n.style.color : n.type ? styleOf(n, 'color') : 'default'));
      s.appendChild(swatches(COLOR_KEYS, genericColors, cur === undefined ? undefined : cur, (k) => {
        mutate(() => {
          colorable.forEach((n) => { if (k == null) delete n.style.color; else n.style.color = k; });
          edges.forEach((e) => { if (k == null || k === 'default') delete e.style.color; else e.style.color = k; });
        });
        scheduleInspector();
      }, topicsOnly));
      if (topicsOnly) s.appendChild(h('div', { class: 'insp-note', style: 'margin-top:6px', text: '斜線は「自動」：枝ごとに色分けします' }));
      inspector.appendChild(s);
    }
    // 塗り・線
    const boxy = editable.filter((n) => ['shape', 'topic', 'ui', 'frame'].includes(n.type));
    if (boxy.length) {
      const s = insSec('塗り');
      s.appendChild(segCtl([['tint', '薄く'], ['solid', '塗る'], ['none', 'なし']], common(boxy, (n) => n.type === 'topic' ? n.style.fill : styleOf(n, 'fill')), (v) => applyStyle(boxy, 'fill', v)));
      inspector.appendChild(s);
      const s2 = insSec('線');
      s2.appendChild(h('div', { class: 'insp-row' }, segCtl([['solid', '実線'], ['dashed', '破線'], ['dotted', '点線'], ['none', 'なし']], common(boxy, (n) => n.type === 'topic' ? n.style.stroke : styleOf(n, 'stroke')), (v) => applyStyle(boxy, 'stroke', v))));
      s2.appendChild(h('div', { class: 'insp-row' }, segCtl([[1, '細'], [2, '標準'], [3, '太'], [4, '極太']], common(boxy, (n) => n.type === 'topic' ? n.style.sw : styleOf(n, 'sw')), (v) => applyStyle(boxy, 'sw', v))));
      inspector.appendChild(s2);
    }
    // 文字
    const texty = editable.filter((n) => n.type !== 'image' && n.type !== 'frame');
    if (texty.length) {
      const s = insSec('文字');
      const fsCur = common(texty, (n) => (n.type === 'topic' ? n.style.fs || null : styleOf(n, 'fs')));
      const sel = h('select', { class: 'insp-select', 'aria-label': '文字の大きさ' });
      if (texty.some((n) => n.type === 'topic')) sel.appendChild(h('option', { value: '', text: '自動（階層ごと）' }));
      FS_LIST.forEach((v) => sel.appendChild(h('option', { value: String(v), text: `${v}px` })));
      sel.value = fsCur == null ? '' : String(fsCur);
      sel.addEventListener('change', () => { applyStyle(texty, 'fs', sel.value ? Number(sel.value) : null); sel.blur(); });
      const boldCur = common(texty, (n) => (n.type === 'topic' ? (n.style.bold != null ? n.style.bold : (T.depth.get(n.id) || 0) <= 1) : styleOf(n, 'bold')));
      s.appendChild(h('div', { class: 'insp-row' }, h('div', { class: 'grow' }, sel), insBtn(boldCur ? '太字：オン' : '太字：オフ', () => applyStyle(texty, 'bold', !boldCur), boldCur ? 'primary' : '')));
      s.appendChild(segCtl([['left', '左揃え'], ['center', '中央'], ['right', '右揃え']], common(texty, (n) => n.style.align || styleOf(n, 'align')), (v) => applyStyle(texty, 'align', v)));
      inspector.appendChild(s);
    }
    // 位置とサイズ
    if (one && !one.locked) {
      const child = one.type === 'topic' && one.parent;
      const s = insSec(child ? '位置とサイズ（トピックは自動で並びます）' : '位置とサイズ');
      const g = h('div', { class: 'num-grid' });
      g.appendChild(numField('X', one.x, (v) => mutate(() => moveNodeBy(one, clamp(Math.round(v), -COORD_LIMIT, COORD_LIMIT) - one.x, 0)), child));
      g.appendChild(numField('Y', one.y, (v) => mutate(() => moveNodeBy(one, 0, clamp(Math.round(v), -COORD_LIMIT, COORD_LIMIT) - one.y)), child));
      g.appendChild(numField('W', one.w, (v) => mutate(() => { one.w = clamp(Math.round(v), 12, 20000); }), one.type === 'topic'));
      g.appendChild(numField('H', one.h, (v) => mutate(() => { one.h = clamp(Math.round(v), 12, 20000); }), one.type === 'topic' || one.type === 'text'));
      s.appendChild(g);
      inspector.appendChild(s);
    }
    // 並び・整列
    const movable = movableSelected();
    const s5 = insSec('重なり順');
    s5.appendChild(h('div', { class: 'insp-btns' }, insBtn('最前面へ', () => zOrder('front'), '', 'Ctrl+Shift+]'), insBtn('最背面へ', () => zOrder('back'), '', 'Ctrl+Shift+['), insBtn('前面へ', () => zOrder('forward'), '', 'Ctrl+]'), insBtn('背面へ', () => zOrder('backward'), '', 'Ctrl+[')));
    inspector.appendChild(s5);
    if (movable.length >= 2) {
      const s = insSec('整列');
      s.appendChild(h('div', { class: 'icon-grid' },
        iconBtn('al-left', '左揃え', () => alignNodes('left')), iconBtn('al-hc', '左右中央', () => alignNodes('hcenter')), iconBtn('al-right', '右揃え', () => alignNodes('right')),
        iconBtn('al-top', '上揃え', () => alignNodes('top')), iconBtn('al-vc', '上下中央', () => alignNodes('vcenter')), iconBtn('al-bottom', '下揃え', () => alignNodes('bottom'))));
      s.appendChild(h('div', { class: 'icon-grid', style: 'margin-top:4px' },
        iconBtn('dist-h', '横に等間隔（3つ以上）', () => distributeNodes('h'), movable.length < 3), iconBtn('dist-v', '縦に等間隔（3つ以上）', () => distributeNodes('v'), movable.length < 3)));
      const flowable = editable.filter((n) => n.type !== 'topic' && n.type !== 'frame');
      if (flowable.length >= 2) {
        s.appendChild(h('div', { class: 'insp-title', style: 'margin-top:10px', text: '自動整列（線のつながりで並べ直す）' }));
        s.appendChild(h('div', { class: 'insp-btns' }, insBtn('上 → 下', () => autoArrange('TD')), insBtn('左 → 右', () => autoArrange('LR'))));
      }
      inspector.appendChild(s);
    }
    // その他
    const s6 = insSec('');
    s6.appendChild(h('div', { class: 'insp-btns three' },
      insBtn('ロック', toggleLock, '', 'Ctrl+L：動かせなくする'),
      insBtn('複製', duplicateSelection, '', 'Ctrl+D'),
      insBtn('削除', deleteSelection, 'danger', 'Delete')));
    inspector.appendChild(s6);
  }

  function topicSection(n) {
    const s = insSec('マインドマップ', true);
    s.appendChild(h('div', { class: 'insp-btns' }, insBtn('子を追加', () => addChildTopic(n.id), 'primary', 'Tab'), insBtn('兄弟を追加', () => addSiblingTopic(n.id), '', 'Enter')));
    const kids = (T.kids.get(n.id) || []).length;
    if (kids) s.appendChild(h('div', { class: 'insp-btns', style: 'margin-top:6px' }, insBtn(n.collapsed ? `広げる（${T.hiddenCount.get(n.id) || kids}）` : '折りたたむ', () => toggleCollapse(n.id), '', 'Ctrl+/')));
    if (!n.parent) {
      s.appendChild(h('div', { class: 'insp-title', style: 'margin-top:10px', text: '枝の配置' }));
      s.appendChild(segCtl(LAYOUTS.map((k) => [k, LAYOUT_LABEL[k]]), n.layout, (v) => mutate(() => { n.layout = v; })));
    } else {
      const p = nodeMap.get(n.parent);
      if (p && !p.parent && p.layout === 'both') {
        s.appendChild(h('div', { class: 'insp-title', style: 'margin-top:10px', text: 'どちら側に出すか' }));
        s.appendChild(segCtl([['l', '左'], ['r', '右']], T.dir.get(n.id), (v) => mutate(() => { n.side = v; })));
      }
      s.appendChild(h('div', { class: 'insp-btns', style: 'margin-top:8px' }, insBtn('独立させる', () => detachTopic(n), '', '親から切り離して別の中心トピックにします')));
    }
    return s;
  }
  function frameSection(n) {
    const s = insSec('画面フレーム');
    const inp = h('input', { type: 'text', class: 'insp-input', value: n.text, 'aria-label': 'フレームの名前' });
    inp.maxLength = 100;
    inp.addEventListener('change', () => mutate(() => { n.text = inp.value.slice(0, 100); }));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    s.appendChild(inp);
    s.appendChild(h('div', { class: 'insp-title', style: 'margin-top:10px', text: '大きさ（左上を保ったまま変えます）' }));
    s.appendChild(segCtl(FRAME_ORDER.filter((k) => k !== 'free').map((k) => [k, FRAME_DEVICES[k].label, `${FRAME_DEVICES[k].w}×${FRAME_DEVICES[k].h}`]), n.device, (k) => mutate(() => { n.device = k; n.w = FRAME_DEVICES[k].w; n.h = FRAME_DEVICES[k].h; })));
    s.appendChild(h('div', { class: 'insp-btns', style: 'margin-top:8px' }, insBtn('この画面を書き出す', () => openExport('frame:' + n.id)), insBtn('横に並べて複製', () => duplicateFrameRight(n))));
    s.appendChild(h('div', { class: 'insp-note', style: 'margin-top:6px', text: 'フレームを動かすと、中に完全に入っている部品も一緒に動きます。ふちの○から別の画面へ矢印を引くと画面遷移図になります。' }));
    return s;
  }
  function duplicateFrameRight(f) {
    ensureLayout();
    const members = framedNodes(f);
    const ids = new Set([f.id].concat(members.map((m) => m.id)));
    const edges = board.edges.filter((e) => e.from.node && e.to.node && ids.has(e.from.node) && ids.has(e.to.node));
    const data = { app: APP_KEY, v: 1, nodes: JSON.parse(JSON.stringify(board.nodes.filter((n) => ids.has(n.id)))), edges: JSON.parse(JSON.stringify(edges)) };
    const newName = nextFrameName(); // 貼り付ける前に数える（後だと自分も数えてしまう）
    const prevSel = selection;
    selection = new Set();
    pasteClip(data, { images: [] }, { offset: 1 });
    // offset は仮。実際の位置を右隣へ動かす
    const pasted = selectedNodes();
    const frame = pasted.find((n) => n.type === 'frame');
    if (!frame) { selection = prevSel; return; }
    const before = undoStack.length ? undoStack.pop() : snapshot();
    const dx = f.x + f.w + 80 - frame.x, dy = f.y - frame.y;
    pasted.forEach((n) => { n.x += dx; n.y += dy; });
    frame.text = newName;
    afterModelChange();
    commitIfChanged(before);
    setSelection([frame.id]);
    ensureVisible(frame);
  }
  function imageSection(n) {
    const s = insSec('画像');
    const range = h('input', { type: 'range', min: 10, max: 100, step: 5, value: String(Math.round(styleOf(n, 'opacity') * 100)), 'aria-label': '不透明度' });
    const val = h('span', { text: Math.round(styleOf(n, 'opacity') * 100) + '%' });
    let before = null;
    range.addEventListener('input', () => {
      if (!before) before = snapshot();
      n.style.opacity = Number(range.value) / 100;
      val.textContent = range.value + '%';
      afterModelChange();
    });
    range.addEventListener('change', () => { if (before) { commitIfChanged(before); before = null; } });
    s.appendChild(h('div', { class: 'insp-title', text: '不透明度（下敷きにするときは薄く）' }));
    s.appendChild(h('div', { class: 'range-row' }, range, val));
    s.appendChild(h('div', { class: 'insp-btns', style: 'margin-top:8px' }, insBtn('元の比率に戻す', () => mutate(() => { n.h = Math.max(4, Math.round(n.w * n.ih / n.iw)); })), insBtn('ロックして下敷きに', () => { mutate(() => { n.locked = true; n.style.opacity = Math.min(styleOf(n, 'opacity'), 0.6); }); zOrder('back'); })));
    const rec = imageCache.get(n.imageId);
    if (rec) s.appendChild(h('div', { class: 'insp-note', style: 'margin-top:6px', text: `${rec.rec.w}×${rec.rec.h}px・${(rec.rec.blob.size / 1024).toFixed(0)}KB` }));
    else s.appendChild(h('div', { class: 'insp-note', style: 'margin-top:6px', text: '画像のデータが見つかりません' }));
    return s;
  }

  function buildEdgePanel(edges, close) {
    inspector.appendChild(h('div', { class: 'insp-head' }, edges.length === 1 ? '線' : `線（${edges.length}本）`, close));
    const setE = (fn) => { mutate(() => edges.forEach(fn)); scheduleInspector(); };
    const s1 = insSec('線の形', true);
    s1.appendChild(segCtl(ROUTES.map((k) => [k, ROUTE_LABEL[k]]).sort((a, b) => ['straight', 'elbow', 'curve'].indexOf(a[0]) - ['straight', 'elbow', 'curve'].indexOf(b[0])), common(edges, (e) => e.route), (v) => setE((e) => { e.route = v; })));
    inspector.appendChild(s1);
    const s2 = insSec('矢印');
    s2.appendChild(segCtl(['none', 'end', 'start', 'both'].map((k) => [k, ARROW_LABEL[k]]), common(edges, (e) => e.arrow), (v) => setE((e) => { e.arrow = v; })));
    inspector.appendChild(s2);
    const s3 = insSec('色');
    s3.appendChild(swatches(COLOR_KEYS, genericColors, common(edges, (e) => e.style.color || 'default'), (k) => setE((e) => { if (k === 'default') delete e.style.color; else e.style.color = k; })));
    inspector.appendChild(s3);
    const s4 = insSec('線の種類');
    s4.appendChild(h('div', { class: 'insp-row' }, segCtl([['solid', '実線'], ['dashed', '破線'], ['dotted', '点線']], common(edges, (e) => e.style.stroke || 'solid'), (v) => setE((e) => { if (v === 'solid') delete e.style.stroke; else e.style.stroke = v; }))));
    s4.appendChild(h('div', { class: 'insp-row' }, segCtl([[1, '細'], [2, '標準'], [3, '太'], [4, '極太']], common(edges, (e) => e.style.sw || 2), (v) => setE((e) => { if (v === 2) delete e.style.sw; else e.style.sw = v; }))));
    inspector.appendChild(s4);
    if (edges.length === 1) {
      const e = edges[0];
      const s5 = insSec('ラベル');
      const inp = h('input', { type: 'text', class: 'insp-input', value: e.label, placeholder: '例：はい／いいえ', 'aria-label': '線のラベル' });
      inp.maxLength = 500;
      inp.addEventListener('change', () => mutate(() => { e.label = inp.value.slice(0, 500); }));
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
      s5.appendChild(inp);
      s5.appendChild(h('div', { class: 'insp-note', style: 'margin-top:6px', text: '線をダブルクリックしても書けます' }));
      inspector.appendChild(s5);
    }
    const s6 = insSec('');
    s6.appendChild(h('div', { class: 'insp-btns' }, insBtn('向きを反転', () => setE((e) => { const t = e.from; e.from = e.to; e.to = t; })), insBtn('削除', deleteSelection, 'danger', 'Delete')));
    inspector.appendChild(s6);
  }

  const isNarrow = () => !!(window.matchMedia && matchMedia('(max-width: 640px)').matches);
  function applyInspectorVisibility() {
    inspector.classList.toggle('is-collapsed', !prefs.inspector);
    $('panelBtn').classList.toggle('is-active', isNarrow() ? inspector.classList.contains('is-sheet-open') : prefs.inspector);
  }

  /* ---- スマホ用：選択中の操作ボタン ---- */
  function updateSelBar() {
    selBar.textContent = '';
    const show = currentView === 'editor' && !!board && selection.size > 0 && !editing;
    selBar.classList.toggle('is-shown', show);
    if (!show) return;
    const one = singleNode(), edge = singleEdge();
    const b = (label, fn, cls) => selBar.appendChild(h('button', { type: 'button', class: cls || '', text: label, onclick: fn }));
    if (one && editableText(one)) b('編集', () => beginEdit(one.id, {}));
    if (one && one.type === 'topic' && !one.locked) { b('＋子', () => addChildTopic(one.id)); b('＋兄弟', () => addSiblingTopic(one.id)); }
    if (edge) b('ラベル', () => beginEditEdge(edge.id));
    b('複製', duplicateSelection);
    b('削除', deleteSelection, 'danger');
    b('詳細', () => { inspector.classList.add('is-sheet-open'); applyInspectorVisibility(); renderInspector(); });
  }

  /* =====================================================================
     ツール欄・パレット（フライアウト）
  ===================================================================== */
  const FLYOUTS = ['flyShape', 'flyFrame', 'flyUi'];
  function closeFlyouts() { FLYOUTS.forEach((id) => $(id).classList.remove('is-open')); }
  const anyFlyoutOpen = () => FLYOUTS.some((id) => $(id).classList.contains('is-open'));
  function openFlyout(id) {
    closeFlyouts();
    if (isNarrow() && inspector.classList.contains('is-sheet-open')) { inspector.classList.remove('is-sheet-open'); applyInspectorVisibility(); }
    const fly = $(id);
    const btn = toolRail.querySelector(`[data-fly="${id}"]`);
    if (btn && !isNarrow()) {
      const top = btn.offsetTop - toolRail.scrollTop;
      fly.style.top = Math.max(8, top) + 'px';
    } else fly.style.top = '';
    fly.classList.add('is-open');
  }
  function previewSvg(w, h, draw) {
    const s = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
    draw(s);
    return s;
  }
  function buildFlyouts() {
    const sg = $('flyShapeGrid');
    sg.textContent = '';
    SHAPE_ORDER.forEach((k) => {
      const def = SHAPES[k];
      const sc = Math.min(50 / def.w, 30 / def.h);
      const w = def.w * sc, hh = def.h * sc;
      const svg = previewSvg(54, 34, (s) => {
        const g = svgEl('g', { transform: `translate(${f2((54 - w) / 2)},${f2((34 - hh) / 2)})`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }, s);
        svgEl('path', { d: def.path(w, hh) }, g);
        if (def.deco) svgEl('path', { d: def.deco(w, hh) }, g);
      });
      sg.appendChild(h('button', { type: 'button', class: 'fly-item', 'data-kind': 'shape:' + k, onclick: () => { setTool('shape', k); closeFlyouts(); } }, svg, def.label));
    });
    const fg = $('flyFrameGrid');
    fg.textContent = '';
    FRAME_ORDER.forEach((k) => {
      const d = FRAME_DEVICES[k];
      const sc = Math.min(48 / d.w, 30 / d.h);
      const w = d.w * sc, hh = d.h * sc;
      const svg = previewSvg(54, 34, (s) => svgEl('rect', { x: f2((54 - w) / 2), y: f2((34 - hh) / 2), width: f2(w), height: f2(hh), rx: k === 'phone' ? 3 : k === 'tablet' ? 2 : 0, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-dasharray': k === 'free' ? '3 2' : null }, s));
      fg.appendChild(h('button', { type: 'button', class: 'fly-item', 'data-kind': 'frame:' + k, onclick: () => { setTool('frame', k); closeFlyouts(); } }, svg, k === 'free' ? '自由' : d.label, k === 'free' ? h('small', { text: 'ドラッグ' }) : h('small', { text: `${d.w}×${d.h}` })));
    });
    const ug = $('flyUiGrid');
    ug.textContent = '';
    const T0 = emptyTree();
    UI_ORDER.forEach((k) => {
      const kit = UI_KIT[k];
      const node = { id: 'preview', type: 'ui', ui: k, on: true, x: 0, y: 0, w: kit.w, h: kit.h, text: kit.text, style: {} };
      const pad = 6;
      const svg = previewSvg(kit.w + pad * 2, kit.h + pad * 2, (s) => appendPrims(svgEl('g', { transform: `translate(${pad},${pad})` }, s), nodePrims(node, pal, T0), { imageHref: () => null, thumb: true }));
      ug.appendChild(h('button', { type: 'button', class: 'fly-item', 'data-kind': 'ui:' + k, onclick: () => { setTool('ui', k); closeFlyouts(); } }, svg, kit.label));
    });
    ug.appendChild(h('div', { class: 'fly-sub', style: 'grid-column:1/-1', text: '文字' }));
    Object.keys(UI_TEXT_PRESETS).forEach((k) => {
      const p = UI_TEXT_PRESETS[k];
      const svg = previewSvg(54, 34, (s) => { const t = svgEl('text', { x: 27, y: 22, 'text-anchor': 'middle', 'font-size': p.fs >= 20 ? 16 : 11, 'font-weight': p.bold ? 700 : 400, fill: 'currentColor' }, s); t.textContent = p.fs >= 20 ? 'Aa見出' : 'Aa本文'; });
      ug.appendChild(h('button', { type: 'button', class: 'fly-item', 'data-kind': 'ui:text:' + k, onclick: () => { setTool('ui', 'text:' + k); closeFlyouts(); } }, svg, p.label));
    });
    setTool(tool);
  }

  /* =====================================================================
     モーダル・確認ダイアログ・メニュー
  ===================================================================== */
  const MODALS = ['newModal', 'textModal', 'exportModal', 'textOutModal', 'importModal', 'helpModal'];
  function openModal(id) { closeMenu(); closeFlyouts(); $(id).classList.add('is-open'); }
  function closeModal(id) { $(id).classList.remove('is-open'); if (id === 'importModal') pendingImport = null; }
  const anyModalOpen = () => MODALS.some((id) => $(id).classList.contains('is-open'));
  function closeTopModal() {
    for (const id of MODALS.slice().reverse()) if ($(id).classList.contains('is-open')) { closeModal(id); return true; }
    return false;
  }
  let confirmResolve = null;
  const confirmOpen = () => $('confirmOverlay').classList.contains('is-open');
  // 確認：既定は OK／キャンセル（true/false）。buttons を渡すと選んだ value（キャンセルは null）
  function ask(message, opts) {
    const o = opts || {};
    if (confirmResolve) closeConfirm(null);
    $('confirmMsg').textContent = message;
    const acts = $('confirmActions');
    acts.textContent = '';
    const cancelValue = o.buttons ? null : false;
    const cancel = h('button', { type: 'button', class: 'btn', text: o.cancel || 'キャンセル', onclick: () => closeConfirm(cancelValue) });
    acts.appendChild(cancel);
    (o.buttons || [{ value: true, label: o.ok || 'OK', kind: o.danger ? 'danger' : 'primary' }]).forEach((b) => {
      acts.appendChild(h('button', { type: 'button', class: 'btn ' + (b.kind || ''), text: b.label, onclick: () => closeConfirm(b.value) }));
    });
    $('confirmBox').classList.toggle('is-danger', !!o.danger);
    $('confirmOverlay').classList.add('is-open');
    setTimeout(() => cancel.focus(), 0);
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  function closeConfirm(v) {
    $('confirmOverlay').classList.remove('is-open');
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(v);
  }
  function closeMenu() { menuPanel.classList.remove('is-open'); menuBtn.setAttribute('aria-expanded', 'false'); }

  /* =====================================================================
     ボード一覧
  ===================================================================== */
  let homeKind = 'all';
  const thumbCache = new Map();
  let thumbObserver = null;
  function showView(name) {
    currentView = name;
    appShell.dataset.mode = name;
    $('homeView').classList.toggle('is-active', name === 'home');
    $('editorView').classList.toggle('is-active', name === 'editor');
    closeMenu();
    closeFlyouts();
    updatePlaceHint();
    updateSelBar();
    if (name === 'editor') applyInspectorVisibility();
  }
  function renderHome() {
    boardListEl.textContent = '';
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (!boards.length) {
      boardListEl.appendChild(h('div', { class: 'empty-state' },
        h('div', { class: 'big', text: 'まだボードがありません' }),
        h('div', { class: 'small', text: 'マインドマップで考えを広げる、フローチャートで手順を整理する、画面フレームとUI部品で画面のラフを描く――1枚のボードでどれでもできます。' }),
        h('div', { class: 'ai-row' }, h('button', { type: 'button', class: 'btn primary', text: '＋ 新規ボード', onclick: openNewModal }), h('button', { type: 'button', class: 'btn', text: 'テキストから作る', onclick: () => openTextModal('new', '') }))));
      return;
    }
    const q = norm(boardSearch.value.trim());
    let list = boards.filter((b) => homeKind === 'all' || b.kind === homeKind);
    if (q) list = list.filter((b) => norm(b.title).includes(q) || b.nodes.some((n) => n.text && norm(n.text).includes(q)));
    const sort = boardSort.value;
    list.sort((a, b) => (sort === 'title' ? (a.title || '').localeCompare(b.title || '', 'ja') : sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
    if (!list.length) { boardListEl.appendChild(h('div', { class: 'empty-state' }, h('div', { class: 'big', text: '条件に合うボードがありません' }))); return; }
    const grid = h('div', { class: 'board-grid' });
    list.forEach((b) => {
      const untitled = !b.title.trim();
      grid.appendChild(h('div', { class: 'board-card' },
        h('button', { type: 'button', class: 'bc-open', 'aria-label': (b.title || '無題のボード') + 'を開く', onclick: () => openBoard(b.id) },
          h('div', { class: 'bc-thumb', 'data-thumb': b.id }),
          h('div', { class: 'bc-info' },
            h('div', { class: 'bc-title' + (untitled ? ' is-untitled' : ''), text: untitled ? '（無題のボード）' : b.title }),
            h('div', { class: 'bc-meta' }, h('span', { class: 'kind-badge', 'data-kind': b.kind, text: KINDS[b.kind] }), h('span', { text: `${b.nodes.length}個` }), h('span', { text: formatDateTime(b.updatedAt) })))),
        h('div', { class: 'bc-actions' },
          h('button', { type: 'button', class: 'mini-btn', title: '複製', 'aria-label': '複製', onclick: () => duplicateBoard(b.id) }, icon('copy')),
          h('button', { type: 'button', class: 'mini-btn del', title: '削除', 'aria-label': '削除', onclick: () => deleteBoard(b.id) }, icon('trash')))));
    });
    boardListEl.appendChild(grid);
    const els = boardListEl.querySelectorAll('[data-thumb]');
    if (!('IntersectionObserver' in window)) { els.forEach(fillThumb); return; }
    thumbObserver = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      thumbObserver.unobserve(en.target);
      fillThumb(en.target);
    }), { root: boardListEl, rootMargin: '300px' });
    els.forEach((el) => thumbObserver.observe(el));
  }
  function fillThumb(el) {
    const b = boards.find((x) => x.id === el.dataset.thumb);
    if (!b) return;
    if (!b.nodes.length) { el.textContent = '（空のボード）'; return; }
    if (b.nodes.length > 1500) { el.textContent = `${b.nodes.length}個のノード`; return; }
    const key = b.updatedAt + ':' + palVersion;
    let c = thumbCache.get(b.id);
    if (!c || c.key !== key) {
      try {
        const sc = boardScene(b, pal, {});
        if (!sc.box) { el.textContent = ''; return; }
        const w = Math.max(1, sc.box.x2 - sc.box.x1), hh = Math.max(1, sc.box.y2 - sc.box.y1);
        const p = Math.max(w, hh) * 0.06;
        const svg = svgEl('svg', { viewBox: `${f2(sc.box.x1 - p)} ${f2(sc.box.y1 - p)} ${f2(w + p * 2)} ${f2(hh + p * 2)}`, preserveAspectRatio: 'xMidYMid meet', 'font-family': FONT_STACK, 'aria-hidden': 'true' });
        appendPrims(svg, sc.items, { imageHref: () => null, thumb: true });
        c = { key, svg };
        thumbCache.set(b.id, c);
      } catch (err) { console.error('サムネイルの作成に失敗しました', err); el.textContent = ''; return; }
    }
    el.textContent = '';
    el.appendChild(c.svg.cloneNode(true));
  }

  /* =====================================================================
     ボードを開く・閉じる・作る・複製・削除
  ===================================================================== */
  async function openBoard(id) {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    board = b;
    baseUpdatedAt = b.updatedAt;
    undoStack = [];
    redoStack = [];
    selection = new Set();
    act = null;
    editing = null;
    hoverId = null;
    nudgeState = null;
    search = { open: false, hits: [], idx: -1 };
    $('searchBox').classList.remove('is-open');
    dropRenderCache();
    updateUndoButtons();
    boardTitle.value = b.title;
    showView('editor');
    setTool('select');
    setSaveState('');
    afterModelChange();
    await preloadImages(b);
    if (board !== b) return;
    let v = null;
    try { v = dbReady ? await dbGet(S.views, b.id) : null; } catch (err) { v = null; }
    if (board !== b) return;
    ensureLayout();
    renderNow();
    if (v && [v.x, v.y, v.zoom].every((x) => typeof x === 'number' && isFinite(x))) { view = { x: v.x, y: v.y, zoom: clamp(v.zoom, ZOOM_MIN, ZOOM_MAX) }; requestRender(); }
    else fitAll();
    renderInspector();
    refocusCanvas(true);
  }
  async function closeBoard() {
    if (!board) { showView('home'); renderHome(); return; }
    if (editing) commitEdit();
    if (act) cancelAct();
    flushNudge();
    await boardSaver.flush();
    await viewSaver.flush();
    const id = board.id;
    board = null;
    selection = new Set();
    dropRenderCache();
    showView('home');
    renderHome();
    gcImages(id).catch((err) => console.error('画像の整理に失敗しました', err)).finally(() => { if (!board) dropImageCache(); });
  }
  function fillTemplate(b, key) {
    const used = new Set();
    const N = (o) => Object.assign({ id: localId('n', used), text: '', style: {}, locked: false }, o);
    const E = (a, c, o) => Object.assign({ id: localId('e', used), from: { node: a, side: 'b' }, to: { node: c, side: 't' }, route: 'elbow', arrow: 'end', label: '', style: {} }, o);
    if (key === 'mindmap') {
      b.nodes.push(N({ type: 'topic', x: -70, y: -24, w: 140, h: 48, text: '中心テーマ', parent: null, order: 0, collapsed: false, layout: 'both', side: '' }));
    } else if (key === 'flow') {
      const s = N({ type: 'shape', shape: 'pill', x: -70, y: 0, w: 140, h: 52, text: '開始' });
      const p = N({ type: 'shape', shape: 'rect', x: -75, y: 112, w: 150, h: 64, text: '処理' });
      const d = N({ type: 'shape', shape: 'diamond', x: -80, y: 236, w: 160, h: 96, text: '条件を満たす？' });
      const yes = N({ type: 'shape', shape: 'rect', x: -75, y: 392, w: 150, h: 64, text: '処理（はい）' });
      const no = N({ type: 'shape', shape: 'rect', x: 170, y: 252, w: 150, h: 64, text: '処理（いいえ）' });
      const end = N({ type: 'shape', shape: 'pill', x: -70, y: 516, w: 140, h: 52, text: '終了' });
      b.nodes.push(s, p, d, yes, no, end);
      b.edges.push(E(s.id, p.id), E(p.id, d.id), E(d.id, yes.id, { label: 'はい' }),
        E(d.id, no.id, { from: { node: d.id, side: 'r' }, to: { node: no.id, side: 'l' }, label: 'いいえ' }),
        E(yes.id, end.id), E(no.id, end.id, { from: { node: no.id, side: 'b' }, to: { node: end.id, side: 'r' } }));
    } else if (key === 'ui-phone') {
      b.nodes.push(
        N({ type: 'frame', device: 'phone', x: 0, y: 0, w: 390, h: 844, text: '画面1　ログイン' }),
        N({ type: 'ui', ui: 'navbar', on: true, x: 0, y: 0, w: 390, h: 56, text: 'ログイン' }),
        N({ type: 'text', x: 24, y: 96, w: 342, h: 36, text: 'おかえりなさい', style: { fs: 24, bold: true } }),
        N({ type: 'ui', ui: 'lines', on: true, x: 24, y: 144, w: 342, h: 40 }),
        N({ type: 'ui', ui: 'input', on: true, x: 24, y: 212, w: 342, h: 48, text: 'メールアドレス' }),
        N({ type: 'ui', ui: 'input', on: true, x: 24, y: 276, w: 342, h: 48, text: 'パスワード' }),
        N({ type: 'ui', ui: 'checkbox', on: true, x: 24, y: 340, w: 220, h: 24, text: 'ログインしたままにする' }),
        N({ type: 'ui', ui: 'button', on: true, x: 24, y: 388, w: 342, h: 48, text: 'ログイン' }),
        N({ type: 'ui', ui: 'tabbar', on: true, x: 0, y: 780, w: 390, h: 64, text: 'ホーム|検索|通知|設定' }));
    } else if (key === 'ui-pc') {
      b.nodes.push(
        N({ type: 'frame', device: 'pc', x: 0, y: 0, w: 1440, h: 900, text: '画面1　トップ' }),
        N({ type: 'ui', ui: 'navbar', on: true, x: 0, y: 0, w: 1440, h: 64, text: 'サービス名' }),
        N({ type: 'text', x: 96, y: 128, w: 760, h: 60, text: '見出しがここに入ります', style: { fs: 40, bold: true } }),
        N({ type: 'ui', ui: 'lines', on: true, x: 96, y: 204, w: 640, h: 58 }),
        N({ type: 'ui', ui: 'button', on: true, x: 96, y: 290, w: 200, h: 52, text: '詳しく見る' }),
        N({ type: 'ui', ui: 'card', on: true, x: 96, y: 400, w: 400, h: 380, text: 'カード1\n説明文が入ります。' }),
        N({ type: 'ui', ui: 'card', on: true, x: 520, y: 400, w: 400, h: 380, text: 'カード2\n説明文が入ります。' }),
        N({ type: 'ui', ui: 'card', on: true, x: 944, y: 400, w: 400, h: 380, text: 'カード3\n説明文が入ります。' }));
    }
  }
  function newBoardRecord(title, kind) {
    const now = Date.now();
    return { id: genId('mf', new Set(boards.map((x) => x.id))), title: str(title, 100).trim(), kind: KINDS[kind] ? kind : 'free', nodes: [], edges: [], settings: { grid: true, snap: false, guides: true }, createdAt: now, updatedAt: now };
  }
  async function storeNewBoard(b) {
    boards.unshift(b);
    if (!dbReady) return true;
    try { await dbPut(S.boards, serializeBoard(b)); return true; }
    catch (err) { console.error(err); toast('ボードを保存できませんでした。容量不足の可能性があります', 'error'); return false; }
  }
  async function createBoard(tplKey, title) {
    const tpl = TEMPLATES.find((t) => t.key === tplKey) || TEMPLATES[0];
    const b = newBoardRecord(title, tpl.kind);
    fillTemplate(b, tpl.key);
    await storeNewBoard(b);
    await openBoard(b.id);
    if (tpl.key === 'mindmap' && b.nodes[0]) { setSelection([b.nodes[0].id]); beginEdit(b.nodes[0].id, { selectAll: true }); }
  }
  async function duplicateBoard(id) {
    const src = boards.find((x) => x.id === id);
    if (!src) return;
    if (board && board.id === id) { if (editing) commitEdit(); await boardSaver.flush(); }
    const copy = normalizeBoard(JSON.parse(JSON.stringify(serializeBoard(src))));
    if (!copy) return;
    const now = Date.now();
    copy.id = genId('mf', new Set(boards.map((x) => x.id)));
    copy.title = ((src.title || '無題のボード') + '（複製）').slice(0, 100);
    copy.createdAt = now;
    copy.updatedAt = now;
    const imgMap = new Map();
    const used = new Set(imageCache.keys());
    for (const n of copy.nodes) {
      if (n.type !== 'image' || !n.imageId) continue;
      if (!imgMap.has(n.imageId)) {
        let rec = imageCache.has(n.imageId) ? imageCache.get(n.imageId).rec : null;
        if (!rec && dbReady) { try { rec = await dbGet(S.images, n.imageId); } catch (err) { rec = null; } }
        if (rec) {
          const nid = genId('im', used);
          used.add(nid);
          const r = Object.assign({}, rec, { id: nid, boardId: copy.id, createdAt: now });
          try { if (dbReady) await dbPut(S.images, r); imgMap.set(n.imageId, nid); if (!dbReady) cacheImage(r); } catch (err) { console.error(err); }
        }
      }
      n.imageId = imgMap.get(n.imageId) || '';
    }
    if (await storeNewBoard(copy)) toast('複製しました');
    if (currentView === 'home') renderHome();
    return copy;
  }
  async function deleteBoard(id) {
    const b = boards.find((x) => x.id === id);
    if (!b) return;
    const imgs = b.nodes.filter((n) => n.type === 'image').length;
    const ok = await ask(`ボード「${b.title || '無題のボード'}」を削除しますか？\nノード${b.nodes.length}個・線${b.edges.length}本${imgs ? `・画像${imgs}枚` : ''}がすべて消えます。\nこの操作は元に戻せません（必要ならJSONで書き出してから）。`, { ok: '削除する', danger: true });
    if (!ok) return;
    const wasOpen = board && board.id === id;
    if (wasOpen) { editing = null; act = null; board = null; selection = new Set(); dropRenderCache(); showView('home'); }
    boards = boards.filter((x) => x.id !== id);
    thumbCache.delete(id);
    if (dbReady) {
      try {
        await dbDel(S.boards, id);
        await dbDelSafe(S.views, id);
        const all = await dbGetAll(S.images);
        for (const r of all) if (r.boardId === id) await dbDelSafe(S.images, r.id);
      } catch (err) { console.error(err); toast('削除に失敗しました。ページを読み込み直してください', 'error'); }
    }
    if (wasOpen) dropImageCache();
    renderHome();
    updateBackupAlert();
    toast('削除しました');
  }
  async function reloadBoardFrom(rec) {
    const b = normalizeBoard(rec);
    if (!b || !board) return;
    const idx = boards.findIndex((x) => x.id === b.id);
    if (idx >= 0) boards[idx] = b;
    toast('別の画面で保存された内容を読み込みました', 'warn');
    await openBoard(b.id);
  }
  async function saveAsCopy(b) {
    const copy = normalizeBoard(JSON.parse(JSON.stringify(serializeBoard(b))));
    const now = Date.now();
    copy.id = genId('mf', new Set(boards.map((x) => x.id)));
    copy.title = ((b.title || '無題のボード') + '（こちらの内容）').slice(0, 100);
    copy.createdAt = now;
    copy.updatedAt = now;
    // 画像は同じものを別IDで持つ
    const imgMap = new Map();
    const used = new Set(imageCache.keys());
    for (const n of copy.nodes) {
      if (n.type !== 'image' || !n.imageId) continue;
      if (!imgMap.has(n.imageId)) {
        const c = imageCache.get(n.imageId);
        if (c) { const nid = genId('im', used); used.add(nid); const r = Object.assign({}, c.rec, { id: nid, boardId: copy.id }); await dbPut(S.images, r); cacheImage(r); imgMap.set(n.imageId, nid); }
      }
      n.imageId = imgMap.get(n.imageId) || '';
    }
    await dbPut(S.boards, serializeBoard(copy));
    boards.unshift(copy);
    // 元のボードは相手の内容を読み込み直す
    const cur = await dbGet(S.boards, b.id);
    const orig = normalizeBoard(cur);
    const idx = boards.findIndex((x) => x.id === b.id);
    if (orig && idx >= 0) boards[idx] = orig;
    toast('こちらの内容を別のボードとして保存しました', 'warn');
    await openBoard(copy.id);
  }

  /* ---- 新規ボードのモーダル ---- */
  let newTpl = 'mindmap';
  function tplPreview(key) {
    return previewSvg(120, 56, (s) => {
      const g = svgEl('g', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }, s);
      const P = (d, extra) => svgEl('path', Object.assign({ d }, extra || {}), g);
      if (key === 'mindmap') {
        P(rrPath(46, 22, 28, 12, 3), { fill: 'currentColor', 'fill-opacity': 0.25 });
        [[16, 10], [16, 40], [104, 10], [104, 40]].forEach(([x, y]) => { P(rrPath(x - 12, y - 4, 24, 8, 2)); P(`M${x < 60 ? 46 : 74},28C${60 + (x < 60 ? -20 : 20)},28 ${x + (x < 60 ? 20 : -20)},${y} ${x + (x < 60 ? 12 : -12)},${y}`); });
      } else if (key === 'flow') {
        P(rrPath(46, 2, 28, 9, 4.5)); P(rrPath(46, 18, 28, 10, 1)); P('M60,34L72,41L60,48L48,41Z'); P('M60,11V18M60,28V34'); P('M72,41H88V30'); P(rrPath(80, 20, 16, 10, 1));
      } else if (key === 'ui-phone') {
        P(rrPath(46, 2, 28, 52, 4)); P('M46,10H74'); P(rrPath(50, 16, 20, 5, 1)); P(rrPath(50, 25, 20, 5, 1)); P(rrPath(50, 34, 20, 6, 2), { fill: 'currentColor', 'fill-opacity': 0.3 }); P('M46,47H74');
      } else if (key === 'ui-pc') {
        P(rrPath(18, 4, 84, 48, 2)); P('M18,12H102'); P(rrPath(24, 18, 30, 5, 1)); [24, 50, 76].forEach((x) => P(rrPath(x, 30, 20, 16, 1)));
      } else if (key === 'blank') {
        P(rrPath(30, 6, 60, 44, 2), { 'stroke-dasharray': '3 3' });
      } else {
        P('M14,12H40M18,20H44M18,28H40M22,36H46M22,44H38'); P('M54,28H66M62,24L66,28L62,32');
        P(rrPath(74, 23, 16, 10, 2)); P('M90,28C96,28 96,14 102,14M90,28C96,28 96,42 102,42'); P(rrPath(102, 10, 12, 8, 2)); P(rrPath(102, 38, 12, 8, 2));
      }
    });
  }
  function openNewModal() {
    $('newTitle').value = '';
    const grid = $('tplGrid');
    grid.textContent = '';
    TEMPLATES.forEach((t) => {
      const card = h('button', { type: 'button', class: 'tpl-card' + (t.key === newTpl ? ' is-on' : ''), 'data-tpl': t.key,
        onclick: () => { newTpl = t.key; grid.querySelectorAll('.tpl-card').forEach((c) => c.classList.toggle('is-on', c.dataset.tpl === t.key)); },
        ondblclick: () => { newTpl = t.key; runNewBoard(); } }, tplPreview(t.key), h('b', { text: t.label }), h('span', { text: t.desc }));
      grid.appendChild(card);
    });
    openModal('newModal');
    setTimeout(() => $('newTitle').focus(), 0);
  }
  async function runNewBoard() {
    const title = $('newTitle').value;
    closeModal('newModal');
    if (newTpl === 'text') { openTextModal('new', title); return; }
    await createBoard(newTpl, title);
  }

  /* =====================================================================
     テキストから図を作る（箇条書き → マインドマップ／Mermaid → フローチャート）
  ===================================================================== */
  function fitShapeSize(shape, text) {
    const def = SHAPES[shape] || SHAPES.rect;
    const lines = wrapText(text || ' ', 200, 14, false);
    const tw = linesWidth(lines, 14, false), th = lines.length * lineH(14);
    let w = clamp(Math.ceil(tw) + 40, def.w * 0.8, 260), hh = Math.max(def.h, Math.ceil(th) + 24);
    if (shape === 'diamond') { w = clamp(Math.ceil(tw * 1.5) + 40, 140, 320); hh = Math.max(88, Math.ceil(th * 1.9) + 24); }
    else if (shape === 'ellipse') { w = hh = Math.max(88, Math.ceil(Math.max(tw, th) * 1.35) + 20); }
    else if (shape === 'pill') w += 24;
    else if (shape === 'cyl') hh += 24;
    else if (shape === 'para' || shape === 'hex') w += 32;
    return { w: Math.round(w), h: Math.round(hh) };
  }
  function chosenFormat(text) {
    const r = document.querySelector('input[name="textFormat"]:checked');
    const v = r ? r.value : 'auto';
    if (v === 'mermaid') return 'mermaid';
    if (v === 'outline') return IO.detectFormat(text) === 'mindmap' ? 'mindmap' : 'outline';
    return IO.detectFormat(text);
  }
  function buildFromText(text, fmt, used) {
    const u = used || new Set();
    if (fmt === 'mermaid') {
      const r = IO.parseMermaid(text);
      if (!r.nodes.length) throw new Error('Mermaid のノードが見つかりません（1行目は flowchart TD などにしてください）');
      if (r.nodes.length > MAX_NODES) throw new Error(`ノードが多すぎます（${MAX_NODES}個まで）`);
      const idOf = new Map();
      const nodes = r.nodes.map((m) => {
        const id = localId('n', u);
        idOf.set(m.id, id);
        const shape = SHAPES[m.shape] ? m.shape : 'rect';
        const sz = fitShapeSize(shape, m.text);
        return { id, type: 'shape', shape, x: 0, y: 0, w: sz.w, h: sz.h, text: String(m.text).slice(0, MAX_TEXT), style: {}, locked: false };
      });
      const pos = IO.layered(nodes.map((n) => ({ id: n.id, w: n.w, h: n.h })), r.edges.map((e) => ({ from: idOf.get(e.from), to: idOf.get(e.to) })), r.dir, { layerGap: 56, nodeGap: 40 });
      nodes.forEach((n) => { const p = pos.get(n.id); if (p) { n.x = p.x; n.y = p.y; } });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const edges = r.edges.slice(0, MAX_EDGES).map((m) => {
        const a = byId.get(idOf.get(m.from)), b = byId.get(idOf.get(m.to));
        const style = {};
        if (m.dashed) style.stroke = 'dashed';
        if (m.thick) style.sw = 3;
        const e = { id: localId('e', u), from: { node: a.id, side: 'a' }, to: { node: b.id, side: 'a' }, route: 'elbow', arrow: m.arrow, label: String(m.label || '').slice(0, 500), style };
        setFlowSides(e, a, b, r.dir);
        return e;
      });
      return { kind: 'flow', title: '', nodes, edges, count: nodes.length, skipped: r.skipped };
    }
    const forest = fmt === 'mindmap' ? IO.parseMindmap(text) : IO.parseOutline(text);
    if (!forest.length) throw new Error('項目が見つかりません');
    const rootItem = forest.length === 1 ? forest[0] : { text: '中心テーマ', children: forest };
    const nodes = [];
    const make = (item, parentId, order) => {
      if (nodes.length >= MAX_NODES) return null;
      const n = { id: localId('n', u), type: 'topic', x: 0, y: 0, w: 80, h: 30, text: String(item.text || '').slice(0, MAX_TEXT), style: {}, locked: false, parent: parentId, order, collapsed: false, layout: 'both', side: '' };
      nodes.push(n);
      item.children.forEach((c, i) => make(c, n.id, i));
      return n;
    };
    const root = make(rootItem, null, 0);
    root.x = -70; root.y = -24;
    // 左右の振り分け：子孫の数で釣り合わせる（順番は保つ）
    const size = (item) => 1 + item.children.reduce((a, c) => a + size(c), 0);
    const sizes = rootItem.children.map(size);
    const total = sizes.reduce((a, s) => a + s, 0);
    let right = 0;
    const level1 = nodes.filter((n) => n.parent === root.id);
    level1.forEach((n, i) => { if (right < total / 2) { n.side = 'r'; right += sizes[i]; } else n.side = 'l'; });
    return { kind: 'mindmap', title: root.text, nodes, edges: [], count: nodes.length, skipped: 0 };
  }
  // 今のボードに追加（位置は at を中心に）
  function addBuiltToBoard(built, at) {
    if (board.nodes.length + built.nodes.length > MAX_NODES) { toastLimit(); return; }
    layoutNodes(built.nodes); // トピックの大きさ・位置を先に決めて、図全体の範囲を出す
    let bb = null;
    built.nodes.forEach((n) => { bb = unionBox(bb, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }); });
    let dx = Math.round(at.x - (bb.x1 + bb.x2) / 2), dy = Math.round(at.y - (bb.y1 + bb.y2) / 2);
    // 既にある図と重なる場所なら、ボード全体の右側に並べる（フレームの中は重なりとみなさない）
    ensureLayout();
    const placed = { x1: bb.x1 + dx - 24, y1: bb.y1 + dy - 24, x2: bb.x2 + dx + 24, y2: bb.y2 + dy + 24 };
    if (board.nodes.some((n) => n.type !== 'frame' && !T.hidden.has(n.id) && rectsTouch(placed, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }))) {
      const cb = contentBox();
      if (cb) { dx = Math.round(cb.x2 + 120 - bb.x1); dy = Math.round(cb.y1 - bb.y1); }
    }
    mutate(() => {
      built.nodes.forEach((n) => { n.x += dx; n.y += dy; board.nodes.push(n); });
      built.edges.forEach((e) => board.edges.push(e));
    });
    ensureLayout();
    renderNow();
    const ids = new Set(built.nodes.map((n) => n.id));
    const roots = built.nodes.filter((n) => !(n.type === 'topic' && n.parent)).map((n) => n.id);
    setSelection(roots, { focus: true });
    const box = contentBox(ids);
    if (box && !boxInside(box, visibleWorldBox(0))) fitBox(box, 1);
  }
  function addTextToBoard(text, fmt, at) {
    let built;
    try { built = buildFromText(text, fmt, boardIdSet()); } catch (err) { toast(err.message, 'error'); return; }
    addBuiltToBoard(built, at);
    if (built.skipped) toast(`解釈できなかった${built.skipped}行は飛ばしました`, 'warn');
  }
  let textTarget = 'new';
  function openTextModal(target, title) {
    textTarget = target;
    $('textNewTitleWrap').classList.toggle('is-hidden', target !== 'new');
    $('textNewTitle').value = title || '';
    $('textSource').value = '';
    $('textModalTitle').textContent = target === 'new' ? 'テキストから図を作成' : 'テキストから図を追加';
    $('textTargetNote').textContent = target === 'new' ? '新しいボードを作ります' : '今のボードの画面の中央に追加します';
    $('textCreateBtn').textContent = target === 'new' ? '作成' : '追加';
    updateDetect();
    openModal('textModal');
    setTimeout(() => $('textSource').focus(), 0);
  }
  let detectTimer = null;
  function updateDetect() {
    const t = $('textSource').value;
    $('textLen').textContent = t ? `${t.length}文字` : '';
    const line = $('textDetect');
    line.classList.remove('is-warn');
    if (!t.trim()) { line.textContent = ''; return; }
    const fmt = chosenFormat(t);
    try {
      const built = buildFromText(t, fmt, new Set());
      line.textContent = fmt === 'mermaid'
        ? `Mermaid（フローチャート）として読み込みます：図形${built.count}・線${built.edges.length}` + (built.skipped ? `（解釈できない${built.skipped}行は飛ばします）` : '')
        : `箇条書き（マインドマップ）として読み込みます：トピック${built.count}`;
      if (built.skipped) line.classList.add('is-warn');
    } catch (err) {
      line.textContent = err.message;
      line.classList.add('is-warn');
    }
  }
  async function runTextCreate() {
    const t = $('textSource').value;
    if (!t.trim()) { toast('テキストを貼り付けてください', 'warn'); return; }
    const fmt = chosenFormat(t);
    if (textTarget === 'current' && board) {
      closeModal('textModal');
      addTextToBoard(t, fmt, viewCenterWorld());
      return;
    }
    let built;
    try { built = buildFromText(t, fmt, new Set()); } catch (err) { toast(err.message, 'error'); return; }
    closeModal('textModal');
    const title = $('textNewTitle').value.trim() || built.title.split('\n')[0].slice(0, 40) || (built.kind === 'flow' ? 'フローチャート' : 'マインドマップ');
    const b = newBoardRecord(title, built.kind);
    b.nodes = built.nodes;
    b.edges = built.edges;
    await storeNewBoard(b);
    await openBoard(b.id);
    fitAll();
    if (built.skipped) toast(`解釈できなかった${built.skipped}行は飛ばしました`, 'warn');
  }
  function copyAiPrompt(kind) {
    const topic = $('aiTopic').value.trim();
    copyText(AI_PROMPTS[kind].replace('{{テーマ}}', topic || '（ここにテーマを書いてください）')).then(() => {
      if (!topic) toast('テーマが空だったので、依頼文の最後を自分で書き換えてください', 'warn');
    });
  }

  /* =====================================================================
     書き出し
  ===================================================================== */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  const radioValue = (name) => { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? r.value : ''; };
  function openExport(preset) {
    if (!board) return;
    if (editing) commitEdit();
    ensureLayout();
    const sel = $('exRange');
    sel.textContent = '';
    sel.appendChild(h('option', { value: 'all', text: 'ボード全体' }));
    if (selection.size) sel.appendChild(h('option', { value: 'sel', text: `選択中の${selection.size}個` }));
    board.nodes.filter((n) => n.type === 'frame').forEach((f) => sel.appendChild(h('option', { value: 'frame:' + f.id, text: `画面フレーム「${f.text || '名前なし'}」` })));
    sel.value = preset && Array.from(sel.options).some((o) => o.value === preset) ? preset : 'all';
    openModal('exportModal');
  }
  function collectImageIds(items, out) {
    items.forEach((p) => { if (p.k === 'g') collectImageIds(p.items, out); else if (p.k === 'image' && p.src) out.add(p.src); });
    return out;
  }
  async function exportImage() {
    if (!board) return;
    ensureLayout();
    const range = $('exRange').value;
    const fmt = radioValue('exFormat') || 'png';
    const bgMode = radioValue('exBg') || 'theme';
    const scale = Number(radioValue('exScale')) || 2;
    const P = bgMode === 'light' ? makePalette(LIGHT_BASE) : pal;
    const opts = {};
    let suffix = '';
    if (range === 'sel') {
      const ids = new Set();
      selectedNodes().forEach((n) => { ids.add(n.id); if (n.type === 'topic') descendants(n.id).forEach((d) => ids.add(d)); if (n.type === 'frame') framedNodes(n).forEach((m) => ids.add(m.id)); });
      opts.filter = (n) => ids.has(n.id);
      opts.freeFilter = () => true;
      opts.edgeFilter = (e) => selection.has(e.id) || (!!e.from.node && !!e.to.node);
      suffix = '_選択';
    } else if (range.startsWith('frame:')) {
      const f = nodeMap.get(range.slice(6));
      if (!f) { toast('フレームが見つかりません', 'error'); return; }
      const fb = { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.h };
      opts.filter = (n) => n.id === f.id || boxInside({ x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }, fb);
      opts.freeFilter = (end) => end.x >= fb.x1 && end.x <= fb.x2 && end.y >= fb.y1 && end.y <= fb.y2;
      suffix = '_' + safeFileName(f.text, '画面');
    }
    const scene = boardScene(board, P, opts);
    if (!scene.box) { toast('書き出すものがありません', 'warn'); return; }
    const pad = 32;
    const bx = Math.floor(scene.box.x1 - pad), by = Math.floor(scene.box.y1 - pad);
    const bw = Math.ceil(scene.box.x2 - scene.box.x1 + pad * 2), bh = Math.ceil(scene.box.y2 - scene.box.y1 + pad * 2);
    const bg = bgMode === 'clear' ? null : rgbCss(P.bg);
    const base = safeFileName(board.title, 'mindframe') + suffix + '_' + dateStamp(new Date());
    const imgIds = collectImageIds(scene.items, new Set());
    closeModal('exportModal');
    try {
      if (fmt === 'svg') {
        const hrefs = new Map();
        for (const id of imgIds) { const c = imageCache.get(id); if (c) hrefs.set(id, 'data:' + c.rec.type + ';base64,' + await blobToBase64(c.rec.blob)); }
        const svg = svgEl('svg', { xmlns: SVGNS, width: bw, height: bh, viewBox: `${bx} ${by} ${bw} ${bh}`, 'font-family': FONT_STACK });
        if (bg) svgEl('rect', { x: bx, y: by, width: bw, height: bh, fill: bg }, svg);
        appendPrims(svg, scene.items, { imageHref: (id) => hrefs.get(id) || null, forExport: true });
        const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
        downloadBlob(new Blob([text], { type: 'image/svg+xml' }), base + '.svg');
        toast('SVG を書き出しました');
        return;
      }
      let s = Math.min(scale, 8192 / bw, 8192 / bh, Math.sqrt(40e6 / (bw * bh)));
      if (s < 0.05) { toast('大きすぎて画像にできません。範囲を狭めてください', 'error'); return; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bw * s));
      canvas.height = Math.max(1, Math.round(bh * s));
      const ctx = canvas.getContext('2d');
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.scale(s, s);
      ctx.translate(-bx, -by);
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (err) { /* 無視 */ }
      const images = new Map();
      for (const id of imgIds) {
        const c = imageCache.get(id);
        if (!c) continue;
        try { images.set(id, window.createImageBitmap ? await createImageBitmap(c.rec.blob) : await loadImg(c.url)); } catch (err) { console.error(err); }
      }
      paintPrims(ctx, scene.items, images);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) { toast('書き出しに失敗しました', 'error'); return; }
      downloadBlob(blob, base + '.png');
      toast(s < scale - 0.01 ? `大きいため ${f2(s)} 倍で書き出しました` : 'PNG を書き出しました', s < scale - 0.01 ? 'warn' : undefined);
    } catch (err) {
      console.error('書き出しに失敗しました', err);
      toast('書き出しに失敗しました', 'error');
    }
  }
  function loadImg(url) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
  }
  let textOut = { name: '', ext: 'txt' };
  function showTextOut(title, text, ext, note) {
    $('textOutTitle').textContent = title;
    $('textOutBody').value = text;
    $('textOutNote').textContent = note || '';
    textOut = { name: safeFileName(board ? board.title : '', 'mindframe') + '_' + dateStamp(new Date()), ext };
    closeModal('exportModal');
    openModal('textOutModal');
  }
  function exportOutline() {
    ensureLayout();
    const roots = board.nodes.filter((n) => n.type === 'topic' && !n.parent).sort((a, b) => a.y - b.y || a.x - b.x);
    if (!roots.length) { toast('マインドマップ（トピック）がありません', 'warn'); return; }
    showTextOut('箇条書き（Markdown）', IO.toOutline(roots.map(treeOf)), 'md', 'マインドマップの階層をそのまま箇条書きにしています。AIに渡して続きを考えてもらうときにも使えます。');
  }
  function exportMermaid() {
    ensureLayout();
    const types = ['shape', 'topic', 'sticky', 'text'];
    const nodes = board.nodes.filter((n) => types.includes(n.type) && n.text.trim());
    if (!nodes.length) { toast('書き出せる図形・トピックがありません', 'warn'); return; }
    const key = new Map();
    nodes.forEach((n, i) => key.set(n.id, 'N' + (i + 1)));
    const outNodes = nodes.map((n) => ({ key: key.get(n.id), text: n.text, shape: n.type === 'shape' ? n.shape : n.type === 'topic' ? 'round' : 'rect' }));
    const outEdges = [];
    let hx = 0, vy = 0;
    const add = (a, b, e) => {
      outEdges.push({ from: key.get(a.id), to: key.get(b.id), label: e ? e.label : '', arrow: e ? e.arrow : 'none', dashed: !!(e && (e.style.stroke === 'dashed' || e.style.stroke === 'dotted')), thick: !!(e && (e.style.sw || 2) >= 3) });
      hx += Math.abs(center(b).x - center(a).x); vy += Math.abs(center(b).y - center(a).y);
    };
    nodes.forEach((n) => { if (n.type === 'topic' && n.parent && key.has(n.parent)) add(nodeMap.get(n.parent), n, null); });
    board.edges.forEach((e) => { if (e.from.node && e.to.node && key.has(e.from.node) && key.has(e.to.node)) add(nodeMap.get(e.from.node), nodeMap.get(e.to.node), e); });
    showTextOut('Mermaid', IO.toMermaid({ dir: hx > vy * 1.2 ? 'LR' : 'TD', nodes: outNodes, edges: outEdges }), 'mmd', 'GitHub・Notion など Mermaid に対応した場所に貼ると図になります（色や位置は引き継がれません）。');
  }
  async function buildExport(list, scope) {
    const ids = new Set(list.map((b) => b.id));
    const used = new Set();
    list.forEach((b) => b.nodes.forEach((n) => { if (n.type === 'image' && n.imageId) used.add(n.imageId); }));
    const recs = new Map();
    if (dbReady) { try { (await dbGetAll(S.images)).forEach((r) => recs.set(r.id, r)); } catch (err) { console.error(err); } }
    imageCache.forEach((c, id) => { if (!recs.has(id)) recs.set(id, c.rec); });
    const images = [];
    for (const r of recs.values()) {
      if (!ids.has(r.boardId) || !used.has(r.id)) continue;
      try { images.push({ id: r.id, boardId: r.boardId, type: r.type, name: r.name, w: r.w, h: r.h, createdAt: r.createdAt, data: await blobToBase64(r.blob) }); }
      catch (err) { console.error('画像の書き出しに失敗しました', err); }
    }
    return { app: APP_KEY, schemaVersion: SCHEMA_VERSION, scope, exportedAt: new Date().toISOString(), boards: list.map(serializeBoard), images };
  }
  async function exportBoardJson() {
    if (!board) return;
    if (editing) commitEdit();
    await boardSaver.flush();
    try {
      const payload = await buildExport([board], 'board');
      downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `mindframe_${safeFileName(board.title, '無題')}_${dateStamp(new Date())}.json`);
      toast('JSON を書き出しました');
    } catch (err) { console.error(err); toast('書き出しに失敗しました', 'error'); }
  }
  async function exportAll() {
    if (board) { if (editing) commitEdit(); await boardSaver.flush(); }
    if (!boards.length) { toast('ボードがありません', 'warn'); return; }
    try {
      const payload = await buildExport(boards, 'all');
      downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `mindframe_backup_${stamp(new Date())}.json`);
      meta.lastFullExportAt = Date.now();
      if (dbReady) { try { await dbPut(S.meta, { id: 'lastFullExportAt', value: meta.lastFullExportAt }); } catch (err) { console.error(err); } }
      updateBackupAlert();
      toast(`エクスポートしました（ボード${payload.boards.length}・画像${payload.images.length}）`);
    } catch (err) { console.error(err); toast('エクスポートに失敗しました', 'error'); }
  }
  function updateBackupAlert() {
    const last = meta.lastFullExportAt || 0;
    const oldest = boards.reduce((m, b) => Math.min(m, b.createdAt), Infinity);
    const since = last || (isFinite(oldest) ? oldest : Date.now());
    const days = Math.floor((Date.now() - since) / DAY_MS);
    const alert = boards.length > 0 && days >= BACKUP_ALERT_DAYS;
    menuBtn.classList.toggle('has-alert', alert);
    const note = $('menuBackupNote');
    note.textContent = last ? `最後のバックアップ：${days}日前` : boards.length ? 'まだ一度もバックアップしていません' : '';
    note.classList.toggle('is-alert', alert);
  }

  /* =====================================================================
     インポート（JSON）
  ===================================================================== */
  let pendingImport = null;
  function parseImport(obj) {
    let invalid = 0;
    const list = (Array.isArray(obj.boards) ? obj.boards : []).map((x) => { const b = normalizeBoard(x); if (!b) invalid++; return b; }).filter(Boolean);
    const bids = new Set(list.map((b) => b.id));
    const images = (Array.isArray(obj.images) ? obj.images : []).filter((x) => {
      const ok = x && validId(x.id) && validId(x.boardId) && bids.has(x.boardId) && typeof x.data === 'string' && x.data && IMAGE_TYPES.includes(x.type) && x.data.length * 0.75 <= IMAGE_MAX_BYTES * 1.05;
      if (!ok) invalid++;
      return ok;
    });
    return { boards: list, images, invalid, exportedAt: str(obj.exportedAt, 40), scope: str(obj.scope, 10) };
  }
  async function handleImportFile(file) {
    if (!/\.json$/i.test(file.name)) { toast('.json ファイルを選んでください', 'error'); return; }
    if (file.size > IMPORT_MAX_BYTES) { toast('ファイルが大きすぎます（200MBまで）', 'error'); return; }
    let obj;
    try { obj = JSON.parse(await file.text()); } catch (err) { toast('JSON として読み込めませんでした', 'error'); return; }
    if (!obj || obj.app !== APP_KEY) { toast('MINDFRAME のエクスポートファイルではありません', 'error'); return; }
    if (typeof obj.schemaVersion !== 'number' || obj.schemaVersion > SCHEMA_VERSION) { toast('このアプリより新しい形式のファイルです。アプリを更新してから取り込んでください', 'error'); return; }
    pendingImport = parseImport(obj);
    pendingImport.fileName = file.name;
    const p = pendingImport;
    const conflicts = p.boards.filter((b) => boards.some((x) => x.id === b.id)).length;
    const when = p.exportedAt ? formatDateTime(Date.parse(p.exportedAt)) : '';
    $('importSource').textContent = `${p.fileName}（${p.scope === 'board' ? 'ボード単位' : 'すべて'}・${when || '日時不明'} 書き出し）`;
    const table = $('importTable');
    table.textContent = '';
    table.appendChild(h('tr', null, h('th', { text: '種類' }), h('th', { text: '新規' }), h('th', { text: '同じIDあり' })));
    table.appendChild(h('tr', null, h('td', { text: 'ボード' }), h('td', { text: String(p.boards.length - conflicts) }), h('td', { text: String(conflicts) })));
    table.appendChild(h('tr', null, h('td', { text: '画像' }), h('td', { text: String(p.images.length), colspan: '2' })));
    $('importInvalid').textContent = p.invalid ? `形式が正しくない${p.invalid}件は取り込みません。` : '';
    $('importPolicyBlock').classList.toggle('is-disabled', !conflicts);
    document.querySelectorAll('input[name="importPolicy"]').forEach((r) => { r.disabled = !conflicts; });
    $('importRunBtn').disabled = !p.boards.length;
    openModal('importModal');
  }
  async function runImport() {
    const p = pendingImport;
    if (!p) return;
    if (!dbReady) { toast('このブラウザでは保存できないため、取り込めません', 'error'); return; }
    const policy = radioValue('importPolicy') || 'newer';
    $('importRunBtn').disabled = true;
    const res = { added: 0, updated: 0, dup: 0, skipped: 0, failed: 0 };
    const existingImgIds = new Set();
    try { (await dbGetAll(S.images)).forEach((r) => existingImgIds.add(r.id)); } catch (err) { console.error(err); }
    const boardIds = new Set(boards.map((b) => b.id));
    for (const b0 of p.boards) {
      const local = boards.find((x) => x.id === b0.id);
      let d = 'add';
      if (local) {
        if (policy === 'overwrite') d = 'overwrite';
        else if (policy === 'dup') d = 'dup';
        else if (policy === 'newer') d = b0.updatedAt > local.updatedAt ? 'overwrite' : 'skip';
        else d = 'skip';
      }
      if (d === 'skip') { res.skipped++; continue; }
      const b = JSON.parse(JSON.stringify(b0));
      if (d === 'dup') {
        b.id = genId('mf', boardIds);
        b.title = ((b.title || '無題のボード') + '（複製）').slice(0, 100);
      }
      boardIds.add(b.id);
      try {
        if (d === 'overwrite') {
          const all = await dbGetAll(S.images);
          for (const r of all) if (r.boardId === b.id) { await dbDelSafe(S.images, r.id); existingImgIds.delete(r.id); }
        }
        // 画像：IDがぶつかるときは新しいIDにして付け替える
        const imgMap = new Map();
        for (const im of p.images.filter((x) => x.boardId === b0.id)) {
          try {
            const blob = base64ToBlob(im.data, im.type);
            if (!blob.size || blob.size > IMAGE_MAX_BYTES) continue;
            let id = im.id;
            if (d === 'dup' || existingImgIds.has(id)) { id = genId('im', existingImgIds); }
            existingImgIds.add(id);
            await dbPut(S.images, { id, boardId: b.id, blob, type: im.type, name: str(im.name, 200) || 'image', w: numIn(im.w, 1, 100000, 1), h: numIn(im.h, 1, 100000, 1), createdAt: ts(im.createdAt) });
            imgMap.set(im.id, id);
          } catch (err) { console.error('画像の取り込みに失敗しました', err); res.failed++; }
        }
        b.nodes.forEach((n) => { if (n.type === 'image') n.imageId = imgMap.get(n.imageId) || ''; });
        await dbPut(S.boards, serializeBoard(b));
        if (d === 'add') res.added++; else if (d === 'dup') res.dup++; else res.updated++;
      } catch (err) { console.error('ボードの取り込みに失敗しました', err); res.failed++; }
    }
    closeModal('importModal');
    await loadAll();
    thumbCache.clear();
    renderHome();
    updateBackupAlert();
    toast(`取り込み完了：追加${res.added}・更新${res.updated}・複製${res.dup}・見送り${res.skipped}` + (res.failed ? `\n${res.failed}件は保存できませんでした` : ''), res.failed ? 'error' : undefined);
  }

  /* =====================================================================
     読み込み・設定
  ===================================================================== */
  async function loadAll() {
    const raw = await dbGetAll(S.boards);
    boards = raw.map(normalizeBoard).filter(Boolean);
    const m = await dbGetAll(S.meta);
    meta = {};
    m.forEach((r) => { if (r && typeof r.id === 'string') meta[r.id] = r.value; });
    const p = meta.prefs;
    if (p && typeof p === 'object') {
      if (p.wheel === 'zoom' || p.wheel === 'scroll') prefs.wheel = p.wheel;
      if (typeof p.inspector === 'boolean') prefs.inspector = p.inspector;
    }
    if (typeof meta.lastFullExportAt !== 'number') meta.lastFullExportAt = 0;
  }
  function savePrefs() {
    meta.prefs = Object.assign({}, prefs);
    if (dbReady) dbPut(S.meta, { id: 'prefs', value: meta.prefs }).catch((err) => console.error(err));
  }
  function updateWheelNote() {
    $('menuWheelNote').textContent = prefs.wheel === 'zoom' ? '今：拡大・縮小（Shift+ホイールで横に移動）' : '今：画面の移動（Ctrl+ホイールで拡大・縮小）';
  }
  function debounce(fn, ms) {
    let t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

  /* =====================================================================
     イベントの登録
  ===================================================================== */
  function bindEvents() {
    // キャンバス
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerCancel);
    stage.addEventListener('mousedown', (e) => e.preventDefault()); // フォーカス（入力待ち）と文字選択を奪わない
    stage.addEventListener('pointerleave', () => { pointerInCanvas = false; if (!act && hoverId) { hoverId = null; requestRender(); } });
    // ポインタを捕まえている（setPointerCapture）ため dblclick の target は常に svg になる。実際に下にある要素で判定する
    stage.addEventListener('dblclick', (e) => { if (Date.now() - lastTouchAt < 800) return; handleDouble(document.elementFromPoint(e.clientX, e.clientY) || e.target, toWorld(e.clientX, e.clientY)); });
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    canvasWrap.addEventListener('dragover', (e) => { if (hasFiles(e) && board) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    canvasWrap.addEventListener('drop', (e) => {
      if (!board || !hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.some((f) => /\.json$/i.test(f.name)) && !files.some((f) => IMAGE_TYPES.includes(f.type))) { toast('JSON の取り込みは ☰ →「JSONからインポート」から行ってください', 'warn'); return; }
      addImages(files, toWorld(e.clientX, e.clientY));
    });
    // 枠の外に落としたファイルでブラウザが画面を離れないように
    document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

    // キーボード・クリップボード
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { spaceDown = false; updateCursor(); } });
    window.addEventListener('blur', () => { if (spaceDown) { spaceDown = false; updateCursor(); } });
    document.addEventListener('copy', (e) => onCopy(e, false));
    document.addEventListener('cut', (e) => onCopy(e, true));
    document.addEventListener('paste', onPaste);

    // ツール欄
    toolRail.addEventListener('click', (e) => {
      const b = e.target.closest('.tool-btn');
      if (!b || !board) return;
      if (b.id === 'searchToolBtn') { openSearch(); return; }
      const t = b.dataset.tool;
      if (t === 'image') { pickImage(); return; }
      if (b.dataset.fly) {
        const open = !$(b.dataset.fly).classList.contains('is-open');
        setTool(t);
        if (open) openFlyout(b.dataset.fly); else closeFlyouts();
        return;
      }
      setTool(t);
      canvasWrap.focus({ preventScroll: true });
    });
    $('zoomInBtn').addEventListener('click', () => zoomBy(1.25));
    $('zoomOutBtn').addEventListener('click', () => zoomBy(0.8));
    $('zoomVal').addEventListener('click', setZoom100);
    $('zoomFitBtn').addEventListener('click', fitAll);

    // 上のバー
    $('newBoardBtn').addEventListener('click', openNewModal);
    $('backBtn').addEventListener('click', closeBoard);
    boardTitle.addEventListener('input', () => { if (!board) return; board.title = boardTitle.value.slice(0, 100); markDirty(); });
    boardTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); boardTitle.blur(); refocusCanvas(true); } });
    $('undoBtn').addEventListener('click', () => { flushNudge(); undo(); });
    $('redoBtn').addEventListener('click', () => { flushNudge(); redo(); });
    $('exportBtn').addEventListener('click', () => openExport());
    $('panelBtn').addEventListener('click', () => {
      if (isNarrow()) inspector.classList.toggle('is-sheet-open');
      else { prefs.inspector = !prefs.inspector; savePrefs(); }
      applyInspectorVisibility();
      renderInspector();
      requestRender();
    });
    $('helpBtn').addEventListener('click', () => openModal('helpModal'));
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !menuPanel.classList.contains('is-open');
      if (open) updateBackupAlert();
      menuPanel.classList.toggle('is-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    $('menuTextAdd').addEventListener('click', () => { closeMenu(); if (board) openTextModal('current', ''); });
    $('menuExport').addEventListener('click', () => { closeMenu(); openExport(); });
    $('menuHelp').addEventListener('click', () => { closeMenu(); openModal('helpModal'); });
    $('menuDupBoard').addEventListener('click', async () => {
      closeMenu();
      if (!board) return;
      const copy = await duplicateBoard(board.id);
      if (copy) { await closeBoard(); await openBoard(copy.id); }
    });
    $('menuExportBoard').addEventListener('click', () => { closeMenu(); exportBoardJson(); });
    $('menuDeleteBoard').addEventListener('click', () => { closeMenu(); if (board) deleteBoard(board.id); });
    $('menuExportAll').addEventListener('click', () => { closeMenu(); exportAll(); });
    $('menuImport').addEventListener('click', async () => {
      closeMenu();
      if (board) await closeBoard(); // 開いているボードを上書きしないよう、先に閉じる
      $('importFile').click();
    });
    $('menuStorage').addEventListener('click', async () => {
      closeMenu();
      if (!navigator.storage || !navigator.storage.estimate) { toast('このブラウザでは容量を確認できません', 'error'); return; }
      try {
        const est = await navigator.storage.estimate();
        const mb = (v) => (v / 1048576).toFixed(1);
        const ratio = est.quota ? est.usage / est.quota : 0;
        let imgs = 0;
        try { imgs = dbReady ? (await dbGetAll(S.images)).length : imageCache.size; } catch (err) { imgs = 0; }
        toast(`使用量 ${mb(est.usage || 0)}MB ／ 上限 ${mb(est.quota || 0)}MB（ボード${boards.length}・画像${imgs}枚）` + (ratio > 0.8 ? '\n残りが少なくなっています。エクスポートしてから画像を整理してください' : ''), ratio > 0.8 ? 'warn' : undefined);
      } catch (err) { toast('容量を確認できませんでした', 'error'); }
    });
    $('menuWheel').addEventListener('click', () => {
      prefs.wheel = prefs.wheel === 'zoom' ? 'scroll' : 'zoom';
      savePrefs();
      updateWheelNote();
      toast(prefs.wheel === 'zoom' ? 'マウスホイールで拡大・縮小するようにしました' : 'マウスホイールで画面を動かすようにしました（Ctrl+ホイールで拡大・縮小）');
    });

    // 一覧
    boardSearch.addEventListener('input', debounce(renderHome, 200));
    document.querySelectorAll('#homeView .chip[data-kind]').forEach((c) => c.addEventListener('click', () => {
      homeKind = c.dataset.kind;
      document.querySelectorAll('#homeView .chip[data-kind]').forEach((x) => x.classList.toggle('is-on', x === c));
      renderHome();
    }));
    boardSort.addEventListener('change', renderHome);

    // モーダル
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
    MODALS.forEach((id) => $(id).addEventListener('click', (e) => { if (e.target.id === id) closeModal(id); }));
    $('confirmOverlay').addEventListener('click', (e) => { if (e.target.id === 'confirmOverlay') closeConfirm(null); });
    $('newCreateBtn').addEventListener('click', runNewBoard);
    $('newTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runNewBoard(); } });
    $('textSource').addEventListener('input', () => { clearTimeout(detectTimer); detectTimer = setTimeout(updateDetect, 250); });
    document.querySelectorAll('input[name="textFormat"]').forEach((r) => r.addEventListener('change', updateDetect));
    $('textCreateBtn').addEventListener('click', runTextCreate);
    $('aiMindBtn').addEventListener('click', () => copyAiPrompt('mind'));
    $('aiFlowBtn').addEventListener('click', () => copyAiPrompt('flow'));
    $('exImageBtn').addEventListener('click', exportImage);
    $('exOutlineBtn').addEventListener('click', exportOutline);
    $('exMermaidBtn').addEventListener('click', exportMermaid);
    $('exJsonBtn').addEventListener('click', () => { closeModal('exportModal'); exportBoardJson(); });
    $('textOutCopy').addEventListener('click', () => copyText($('textOutBody').value));
    $('textOutDownload').addEventListener('click', () => downloadBlob(new Blob([$('textOutBody').value], { type: 'text/plain;charset=utf-8' }), `${textOut.name}.${textOut.ext}`));
    $('importFile').addEventListener('change', () => {
      const f = $('importFile').files && $('importFile').files[0];
      $('importFile').value = '';
      if (f) handleImportFile(f);
    });
    $('importRunBtn').addEventListener('click', runImport);
    $('imageFile').addEventListener('change', () => {
      const files = Array.from($('imageFile').files || []);
      $('imageFile').value = '';
      if (files.length && board) addImages(files, viewCenterWorld());
    });

    // 検索
    $('searchInput').addEventListener('input', debounce(runSearch, 150));
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); gotoHit(search.idx + (e.shiftKey ? -1 : 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
    });
    $('searchPrev').addEventListener('click', () => gotoHit(search.idx - 1));
    $('searchNext').addEventListener('click', () => gotoHit(search.idx + 1));
    $('searchClose').addEventListener('click', closeSearch);

    // 外側をクリックしたらメニュー・パレットを閉じる
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.menu-wrap')) closeMenu();
      if (!e.target.closest('.flyout') && !e.target.closest('.tool-btn')) closeFlyouts();
    }, true);

    // 保存のタイミング：Stage を閉じる合図（約1.5秒後に iframe が破棄される）・タブを閉じる・裏に回る
    window.addEventListener('message', (e) => {
      if (e.source === window.parent && e.data && e.data.type === 'sideops:stage-closing') flushAll();
    });
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
    window.addEventListener('beforeunload', (e) => {
      if (boardSaver.pending || editing || nudgeState) { flushNudge(); flushAll(); e.preventDefault(); e.returnValue = ''; }
    });

    // テーマ（本体から）・文字の読み込み・大きさの変化
    document.addEventListener('sideops:themechange', () => {
      refreshPalette();
      thumbCache.clear();
      buildFlyouts();
      needsLayout = true;
      if (currentView === 'editor') { requestRender(); scheduleInspector(); } else renderHome();
    });
    if (document.fonts) {
      const relayout = () => {
        widthCache.clear();
        needsLayout = true;
        thumbCache.clear();
        if (currentView === 'editor' && board) { dropRenderCache(); requestRender(); }
        else if (currentView === 'home') renderHome();
      };
      if (document.fonts.ready) document.fonts.ready.then(relayout).catch(() => {});
      if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', relayout);
    }
    if (window.ResizeObserver) new ResizeObserver(() => requestRender()).observe(canvasWrap);
    else window.addEventListener('resize', requestRender);
    if (window.matchMedia) {
      const mq = matchMedia('(max-width: 640px)');
      const onMq = () => { inspector.classList.remove('is-sheet-open'); applyInspectorVisibility(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    }
  }

  /* =====================================================================
     起動
  ===================================================================== */
  async function init() {
    refreshPalette();
    buildFlyouts();
    bindEvents();
    try {
      db = await openDb();
      dbReady = true;
      await loadAll();
    } catch (err) {
      console.error('MINDFRAME用DBの初期化に失敗しました', err);
      dbReady = false;
      boards = [];
      $('storageBanner').classList.remove('is-hidden');
    }
    if (dbReady && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    updateWheelNote();
    updateBackupAlert();
    showView('home');
    renderHome();
    if (dbReady) gcImages().catch((err) => console.error('画像の整理に失敗しました', err));
  }
  init();
})();
