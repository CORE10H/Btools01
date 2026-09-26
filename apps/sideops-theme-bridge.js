/* =====================================================================
   SIDE-OPS テーマブリッジ（アプリ側・受信専用） v2
   ---------------------------------------------------------------------
   使い方：各アプリの <head> 内、<style> の直後に1行追加するだけ。
     <script src="sideops-theme-bridge.js"></script>

   仕組み：
   - SIDE-OPS本体（親ウィンドウ）から postMessage で届くテーマ色（基本色＋派生色）を、
     このアプリの :root のCSS変数に上書きする。
   - 本体の「STAGE用」の色（--stage-bg 等）は、アプリ内では下地の色（--bg 等）として
     読み替える。これにより、アプリ側のCSSは --bg を使ったまま、STAGE背景の設定に従う。
   - アプリ単体で直接開いた場合（親がいない）は何もしない＝各アプリ既定の色のまま。
   - 受け取るのは「許可リストにある変数名」かつ「色として妥当な値」だけ
     （想定外の文字列でCSSを壊されない／注入されないためのフールプルーフ）。
   - 直近に受け取った色を sessionStorage に控え、次にアプリを開いた瞬間に
     先回りで適用する（毎回ダーク→選択テーマへ一瞬チラつくのを防ぐ）。
   - 反映後に document へ 'sideops:themechange' イベントを発火する。
     canvas描画など、CSS変数だけでは追従できない処理はこれを拾って再描画できる。
===================================================================== */
(function () {
  'use strict';

  if (window.parent === window) return; // 単体表示では何もしない

  var MSG_THEME = 'sideops:theme';
  var MSG_REQUEST = 'sideops:theme-request';
  var CACHE_KEY = 'sideops_theme_bridge_cache_v2';

  // 色コード（#xxxxxx / rgb() / rgba()）を受け取る変数
  var COLOR_TOKENS = [
    '--bg', '--bg-alt', '--panel', '--panel-hi', '--panel-line',
    '--line', '--line-soft',
    '--cyan', '--cyan-dim', '--magenta', '--magenta-dim', '--amber', '--amber-dim',
    '--text', '--text-dim', '--text-faint', '--label-color', '--on-accent',
    '--stage-bg', '--stage-bg-alt'
  ];
  // 「R, G, B」形式の変数は名前が "-rgb" で終わるもの（値は数値3つのみ許可）
  var RE_RGB_NAME = /^--[a-z][a-z-]{0,40}-rgb$/;

  // 本体のSTAGE用の色 → アプリ内での読み替え先
  var STAGE_REMAP = {
    '--stage-bg': '--bg',
    '--stage-bg-rgb': '--bg-rgb',
    '--stage-bg-alt': '--bg-alt',
    '--stage-bg-alt-rgb': '--bg-alt-rgb',
    '--stage-scrim-rgb': '--scrim-rgb',
    '--stage-shadow-rgb': '--shadow-rgb'
  };

  var RE_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  var RE_RGB_FUNC = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;
  var RE_RGB_TRIPLET = /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/;

  function isAllowed(name) {
    return COLOR_TOKENS.indexOf(name) !== -1 || RE_RGB_NAME.test(name);
  }
  function isValidValue(name, value) {
    if (typeof value !== 'string') return false;
    var v = value.trim();
    if (v.length === 0 || v.length > 40) return false;
    if (RE_RGB_NAME.test(name)) return RE_RGB_TRIPLET.test(v);
    return RE_HEX.test(v) || RE_RGB_FUNC.test(v);
  }

  // 背景の明るさでライト/ダークを判定し、color-scheme を合わせる
  // （date入力・select・チェックボックス・スクロールバー等、ブラウザ標準部品の配色を追従させる）
  function isLightColor(hex) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return false;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
  }

  function applyTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return false;
    var root = document.documentElement;
    var applied = {};
    var count = 0;

    Object.keys(tokens).forEach(function (name) {
      if (!isAllowed(name)) return;
      var value = tokens[name];
      if (!isValidValue(name, value)) return;
      applied[name] = value.trim();
      count++;
    });
    if (count === 0) return false;

    // 旧形式（--panel を送ってこない本体）への互換
    if (!applied['--panel'] && applied['--panel-rgb']) {
      applied['--panel'] = 'rgb(' + applied['--panel-rgb'] + ')';
    }
    // STAGE用の色を、アプリ内の下地の色として読み替える（後から上書き）
    Object.keys(STAGE_REMAP).forEach(function (from) {
      if (applied[from]) applied[STAGE_REMAP[from]] = applied[from];
    });

    Object.keys(applied).forEach(function (name) {
      root.style.setProperty(name, applied[name]);
    });
    if (applied['--bg']) {
      root.style.colorScheme = isLightColor(applied['--bg']) ? 'light' : 'dark';
    }

    try {
      document.dispatchEvent(new CustomEvent('sideops:themechange', { detail: { tokens: applied } }));
    } catch (e) { /* 古い環境では無視 */ }
    return true;
  }

  function saveCache(tokens) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(tokens)); } catch (e) { /* 利用不可環境は無視 */ }
  }
  function loadCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ① 先回り適用（チラつき防止）
  applyTokens(loadCache());

  // ② 本体からのテーマ受信
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return; // 親ウィンドウ以外からは受け取らない
    var data = e.data;
    if (!data || data.type !== MSG_THEME || !data.tokens) return;
    if (applyTokens(data.tokens)) saveCache(data.tokens);
  });

  // ③ 起動時に本体へ現在のテーマを要求（送受信のタイミングずれ対策）
  try {
    window.parent.postMessage({ type: MSG_REQUEST }, '*');
  } catch (e) { /* 親へ送れない環境では無視 */ }
})();
