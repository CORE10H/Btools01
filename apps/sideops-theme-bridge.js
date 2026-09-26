/* =====================================================================
   SIDE-OPS テーマブリッジ（アプリ側・受信専用）
   ---------------------------------------------------------------------
   使い方：各アプリの <head> 内、<style> の直後に1行追加するだけ。
     <script src="sideops-theme-bridge.js"></script>

   仕組み：
   - SIDE-OPS本体（親ウィンドウ）から postMessage で届くテーマ色（15色）を、
     このアプリの :root のCSS変数に上書きする。
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

  // 親がいない（単体表示）なら何もしない
  if (window.parent === window) return;

  var MSG_THEME = 'sideops:theme';
  var MSG_REQUEST = 'sideops:theme-request';
  var CACHE_KEY = 'sideops_theme_bridge_cache_v1';

  // 本体側のテーマトークン（15色）と同じ名前だけを許可する
  var ALLOWED_TOKENS = [
    '--bg', '--bg-alt', '--panel-rgb', '--panel-hi',
    '--line', '--line-soft',
    '--cyan', '--cyan-dim', '--magenta', '--magenta-dim', '--amber',
    '--text', '--text-dim', '--text-faint', '--label-color'
  ];

  var RE_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  var RE_RGB_FUNC = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;
  var RE_RGB_TRIPLET = /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/;

  function isValidValue(name, value) {
    if (typeof value !== 'string') return false;
    var v = value.trim();
    if (v.length === 0 || v.length > 40) return false;
    if (name === '--panel-rgb') return RE_RGB_TRIPLET.test(v);
    return RE_HEX.test(v) || RE_RGB_FUNC.test(v);
  }

  // 背景色の明るさからライト/ダークを判定し、color-scheme を合わせる
  // （date入力・select・スクロールバー等、ブラウザ標準部品の配色を追従させるため）
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

    ALLOWED_TOKENS.forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) return;
      var value = tokens[name];
      if (!isValidValue(name, value)) return;
      value = value.trim();
      root.style.setProperty(name, value);
      applied[name] = value;
      count++;
    });

    // 本体は --panel を "R, G, B" 形式の --panel-rgb で持っているため、
    // アプリ側が使う --panel（通常の色）へ変換して渡す
    if (applied['--panel-rgb']) {
      root.style.setProperty('--panel', 'rgb(' + applied['--panel-rgb'] + ')');
    }

    if (count === 0) return false;

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
    // 親ウィンドウ（SIDE-OPS本体）以外からのメッセージは無視
    if (e.source !== window.parent) return;
    var data = e.data;
    if (!data || data.type !== MSG_THEME || !data.tokens) return;
    if (applyTokens(data.tokens)) saveCache(data.tokens);
  });

  // ③ 起動時に本体へ現在のテーマを要求（本体の送信とアプリの準備完了の
  //    タイミングがずれても、確実に1回は受け取れるようにするための保険）
  try {
    window.parent.postMessage({ type: MSG_REQUEST }, '*');
  } catch (e) { /* 親へ送れない環境では無視 */ }
})();
