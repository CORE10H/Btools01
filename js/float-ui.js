/* =====================================================================
   SIDE-OPS：画面に浮かぶ戻るボタンと時計（2026-11-05）
   スマホの画面（js/main.js の MOBILE_LAYOUT_QUERY と同じ条件）でアプリ（Stage）を開いている間だけ出す。
     ・戻るボタン：スマホの戻るボタンと同じく「いちばん上に開いているもの」を1つ閉じる
       （アプリのモーダル → アプリ（Stage）の順）。中身は js/back-nav.js の SideOpsBackNav.backOne()。
       ブラウザの「戻る」を通さないので、Androidの全画面表示が解除されない
     ・時計：時:分。アプリを開くとSIDE-OPSのヘッダー（と、全画面ではスマホ上の時刻）が隠れるため
   決まり：
     ・出す／出さないは設定モーダルの「スマホの画面」で切り替える（端末ごと。js/main.js が sideops_settings の
       main レコードの floatBack・floatClock に保存し、SideOpsFloat.setOptions で知らせる。同期しない）
     ・どちらも指（マウス）でずらして置き場所を変えられる。置き場所は端末に覚える（localStorage。
       画面の端からの割合で持つので、回転や画面の大きさが変わっても画面の外に出ない）
     ・モーダルではないので is-open は使わず、戻る操作（js/back-nav.js）の層にもしない
   歯止め：
     ・ずらし始め（8px）までは「押した」、それより動いたら「ずらした」。ずらしたあとの押下は戻るにしない
     ・続けて押しても2つ閉じない（0.45秒あける。戻るの後片付けの途中＝SideOpsBackNav.busy() の間も押さない）
     ・閉じるものがないとき（ホーム画面）は出さないので、押してSIDE-OPSから離れることはない
     ・置き場所が壊れていたら既定の場所。設定の「置き場所を元に戻す」でも戻せる
     ・既定の戻るボタンは左の端から少し離す（Androidの「端からのスワイプで戻る」と取り違えにくいように）
   詳細は docs/core/claude_メインステージ_仕様書.md「画面に浮かぶ戻るボタンと時計」
   ===================================================================== */
(function () {
  'use strict';

  const POS_KEY = 'sideops_float_pos';  // localStorage：置き場所（端末ごと）。{ back: {x, y}, clock: {x, y} }（0〜1 の割合）
  const MOBILE_LAYOUT_QUERY = '(max-width: 479px), (max-height: 500px)'; // js/main.js・style.css と同じ値
  const MARGIN = 6;
  const DRAG_START_PX = 8;
  const PRESS_GUARD_MS = 450;
  const AFTER_DRAG_MS = 350;
  const DEFAULTS = { back: { x: 0.03, y: 0.62 }, clock: { x: 0.5, y: 0 } };

  const els = { back: document.getElementById('floatBackBtn'), clock: document.getElementById('floatClock') };
  const stageEl = document.getElementById('stageEl');
  if (!els.back || !els.clock || !stageEl) return;
  const mql = window.matchMedia(MOBILE_LAYOUT_QUERY);

  let opts = { back: true, clock: true };
  let pos = loadPos();
  let lastDragEnd = 0;
  let lastPress = 0;
  let tickTimer = 0;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }
  function copyDefaults() { return { back: Object.assign({}, DEFAULTS.back), clock: Object.assign({}, DEFAULTS.clock) }; }

  /* ---- 置き場所 ---- */
  function loadPos() {
    const out = copyDefaults();
    try {
      const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      ['back', 'clock'].forEach((k) => {
        const p = raw && raw[k];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[k] = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
      });
    } catch (err) { /* 壊れていたら既定の置き場所 */ }
    return out;
  }
  function savePos() { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (err) { /* 覚えられなくても動く */ } }
  // 動かせる範囲（画面の端から MARGIN の内側）
  function room(el) {
    return { w: Math.max(0, window.innerWidth - el.offsetWidth - MARGIN * 2), h: Math.max(0, window.innerHeight - el.offsetHeight - MARGIN * 2) };
  }
  function place(k) {
    const el = els[k];
    if (!el.classList.contains('is-shown')) return;
    const r = room(el);
    el.style.left = Math.round(MARGIN + pos[k].x * r.w) + 'px';
    el.style.top = Math.round(MARGIN + pos[k].y * r.h) + 'px';
  }
  function placeAll() { place('back'); place('clock'); }

  /* ---- 出す／隠す ---- */
  function update() {
    const on = mql.matches && stageEl.classList.contains('is-open');
    const showClock = on && opts.clock;
    if (showClock) tick(); else stopTick();
    ['back', 'clock'].forEach((k) => {
      const v = on && opts[k];
      const was = els[k].classList.contains('is-shown');
      els[k].classList.toggle('is-shown', v);
      if (v && !was) place(k);
    });
  }

  /* ---- 時計（分が変わる時刻に合わせて書き換える。裏に回って止まっていた分は、戻ったときに書き直す） ---- */
  function tick() {
    clearTimeout(tickTimer);
    const now = new Date();
    els.clock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    tickTimer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }
  function stopTick() { clearTimeout(tickTimer); tickTimer = 0; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && els.clock.classList.contains('is-shown')) tick();
  });

  /* ---- ずらす ---- */
  function draggable(k) {
    const el = els[k];
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sx = e.clientX, sy = e.clientY;
      const start = el.getBoundingClientRect();
      let dragging = false;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動かせる */ }
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!dragging && Math.hypot(dx, dy) < DRAG_START_PX) return;
        dragging = true;
        el.classList.add('is-dragging');
        el.style.left = Math.round(clamp(start.left + dx, MARGIN, window.innerWidth - start.width - MARGIN)) + 'px';
        el.style.top = Math.round(clamp(start.top + dy, MARGIN, window.innerHeight - start.height - MARGIN)) + 'px';
      };
      const end = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        if (!dragging) return;
        el.classList.remove('is-dragging');
        lastDragEnd = Date.now();
        const r = room(el), b = el.getBoundingClientRect();
        pos[k] = { x: r.w ? clamp((b.left - MARGIN) / r.w, 0, 1) : 0, y: r.h ? clamp((b.top - MARGIN) / r.h, 0, 1) : 0 };
        savePos();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }
  draggable('back');
  draggable('clock');

  /* ---- 戻る ---- */
  els.back.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastDragEnd < AFTER_DRAG_MS) return; // ずらした指を離しただけ
    if (now - lastPress < PRESS_GUARD_MS) return;  // 続けて押した
    const nav = window.SideOpsBackNav;
    if (nav && nav.busy()) return;                 // 前の戻るの後片付けの途中
    lastPress = now;
    if (nav && nav.backOne()) return;
    // 層を積めなかった（操作の外で開いた等）のに Stage が開いている：✕ と同じく閉じる
    if (stageEl.classList.contains('is-open')) {
      const x = document.getElementById('stageCloseBtn');
      if (x) x.click();
    }
  });

  new MutationObserver(update).observe(stageEl, { attributes: true, attributeFilter: ['class'] });
  if (mql.addEventListener) mql.addEventListener('change', update); else if (mql.addListener) mql.addListener(update);
  window.addEventListener('resize', placeAll);
  window.addEventListener('orientationchange', placeAll);

  window.SideOpsFloat = {
    // { back: true/false, clock: true/false }（書いていないものは出す）
    setOptions(o) {
      opts = { back: !(o && o.back === false), clock: !(o && o.clock === false) };
      update();
    },
    resetPositions() {
      pos = copyDefaults();
      try { localStorage.removeItem(POS_KEY); } catch (err) { /* 何もしない */ }
      placeAll();
    },
  };
  // js/main.js が設定を先に読み終えていたら、その値で始める
  if (window.SideOpsFloatOptions) window.SideOpsFloat.setOptions(window.SideOpsFloatOptions);
  update();
})();
