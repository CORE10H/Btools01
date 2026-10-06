/* =====================================================================
   SIDE-OPS：画像の「見え方」（枠合わせ）の共通部品（2026-10-07）
   カバー画像などを決まった比率の枠（16:9・3:4・正方形など）に入れて表示するとき、
   どこをどれだけ拡大して見せるかを決めて保存し、その通りに表示する。
   PROMPTGALLERY の枠合わせ（2026-10-06）を、ほかのアプリでも使えるようにしたもの。

   保存する値（アプリのレコードに、そのまま入れる）：
     thumb = { ar, z, cx, cy }
       ar … 画像の縦横比（幅÷高さ）。表示のたびに画像の大きさを調べずに配置を計算するため
       z  … 拡大率。1 =「枠いっぱい」（枠を隙間なく埋める最小の大きさ＝以前の中央切り抜きと同じ）。
             最小は「全体を表示」（画像全体が枠に収まる。余白は背景色）、最大は Z_MAX
       cx, cy … 枠の中心に来る、画像の上の位置（0〜1）
     決めたときと違う比率の枠に出すときも、同じ値で「中心の位置」と「枠に対する拡大率」を保って出す。
   計算はすべて「枠の幅・高さ = 100」の％で行うので、枠の大きさが変わっても見え方は同じ。

   使い方：
     SideOpsFrame.applyImg(img要素, thumb, 枠の比率)   … <img>（親は position: relative; overflow: hidden）
     SideOpsFrame.bgStyle(thumb, 枠の比率)             … 背景画像用 { size, position }（thumb がなければ cover・中央）
     SideOpsFrame.edit({ src, aspect, initial, label }) … 調整の画面を開く。決定 → thumb、キャンセル → null（Promise）
     SideOpsFrame.normalize(thumb)                     … 保存されていた値を確かめる（使えない値は null）
     SideOpsFrame.measure(src)                         … 画像の縦横比を調べる（Promise。読めなければ null）
   調整の画面は .sideops-frame-overlay.is-open。apps/sideops-theme-bridge.js がモーダルとして数えるので、
   スマホの戻るボタンで閉じられる（キャンセル扱い）。Esc・背景のクリックもキャンセル。
   ===================================================================== */
(function () {
  'use strict';

  const Z_MAX = 4;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // 枠の比率 F（幅÷高さ）に対する、画像の比率の相対値 r = ar / F
  function zMin(ar, aspect) { const r = ar / aspect; return Math.min(r, 1 / r); }

  function layout(t, aspect) {
    const r = t.ar / aspect;
    // 枠いっぱい（z=1）のとき：画像が横に長ければ高さを合わせる、縦に長ければ幅を合わせる
    const W = (r >= 1 ? 100 * r : 100) * t.z;
    const H = (r >= 1 ? 100 : 100 / r) * t.z;
    // 枠より大きい向きは、端が枠の内側に入り込まない範囲で動かす。枠より小さい向きは真ん中に置く
    const left = W >= 100 ? clamp(50 - t.cx * W, 100 - W, 0) : (100 - W) / 2;
    const top = H >= 100 ? clamp(50 - t.cy * H, 100 - H, 0) : (100 - H) / 2;
    return { W, H, left, top };
  }

  // 拡大率を範囲内に収め、位置を「実際に見えている位置」に直す
  function settle(t, aspect) {
    const z = clamp(t.z, zMin(t.ar, aspect), Z_MAX);
    const L = layout({ ar: t.ar, z, cx: t.cx, cy: t.cy }, aspect);
    return { ar: t.ar, z, cx: (50 - L.left) / L.W, cy: (50 - L.top) / L.H };
  }

  function normalize(t) {
    if (!t || typeof t !== 'object') return null;
    const ar = Number(t.ar), z = Number(t.z), cx = Number(t.cx), cy = Number(t.cy);
    if (![ar, z, cx, cy].every(Number.isFinite) || ar < 0.01 || ar > 100 || z <= 0 || z > Z_MAX + 0.001) return null;
    return { ar, z, cx: clamp(cx, 0, 1), cy: clamp(cy, 0, 1) };
  }

  function round(t) {
    const r = (v) => Math.round(v * 10000) / 10000;
    return { ar: r(t.ar), z: r(t.z), cx: r(t.cx), cy: r(t.cy) };
  }

  function applyImg(img, thumb, aspect) {
    const t = normalize(thumb);
    if (!t || !(aspect > 0)) {
      img.classList.remove('sideops-framed');
      ['width', 'height', 'left', 'top'].forEach((k) => { img.style[k] = ''; });
      return;
    }
    const L = layout(settle(t, aspect), aspect);
    img.classList.add('sideops-framed');
    img.style.width = L.W + '%';
    img.style.height = L.H + '%';
    img.style.left = L.left + '%';
    img.style.top = L.top + '%';
  }

  // 背景画像（background-image）用。background-position の％は「枠と画像の差」に対する割合なので換算する
  function bgStyle(thumb, aspect) {
    const t = normalize(thumb);
    if (!t || !(aspect > 0)) return { size: 'cover', position: 'center' };
    const L = layout(settle(t, aspect), aspect);
    const px = Math.abs(100 - L.W) < 0.01 ? 50 : (L.left / (100 - L.W)) * 100;
    const py = Math.abs(100 - L.H) < 0.01 ? 50 : (L.top / (100 - L.H)) * 100;
    return { size: `${L.W}% ${L.H}%`, position: `${px}% ${py}%` };
  }

  function measure(src) {
    return new Promise((resolve) => {
      let url = src, owned = false;
      if (src instanceof Blob) { url = URL.createObjectURL(src); owned = true; }
      const im = new Image();
      const done = (v) => { if (owned) URL.revokeObjectURL(url); resolve(v); };
      im.onload = () => done(im.naturalWidth > 0 && im.naturalHeight > 0 ? im.naturalWidth / im.naturalHeight : null);
      im.onerror = () => done(null);
      im.src = url;
    });
  }

  /* ---------------- 調整の画面 ---------------- */
  const CSS = `
  img.sideops-framed.sideops-framed { position: absolute; max-width: none; max-height: none; object-fit: fill; }
  .sideops-frame-overlay { position: fixed; inset: 0; z-index: 2000; display: none; align-items: center; justify-content: center;
    padding: 16px; background: rgba(var(--scrim-rgb, 0, 0, 0), .7); }
  .sideops-frame-overlay.is-open { display: flex; }
  .sof-box { width: 100%; max-width: 360px; max-height: 94vh; overflow-y: auto; background: var(--panel, #0e1620);
    border: 1px solid var(--line, #1e3038); padding: 14px 16px 16px; color: var(--text, #f5f9fa); font-size: 12px; box-sizing: border-box; }
  .sof-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .sof-frame { position: relative; margin: 0 auto; overflow: hidden; background: var(--bg-alt, #070b10);
    border: 1px solid var(--line, #1e3038); touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
  .sof-frame:active { cursor: grabbing; }
  .sof-frame img { pointer-events: none; -webkit-user-drag: none; }
  .sof-zoom { display: flex; align-items: center; gap: 8px; margin: 10px auto 0; color: var(--text-faint, #5c6b73); }
  .sof-zoom input { flex: 1; min-width: 0; accent-color: var(--cyan, #00f0d0); }
  .sof-btns, .sof-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .sof-btns { justify-content: center; }
  .sof-actions { justify-content: flex-end; margin-top: 14px; }
  .sof-box button { font: inherit; font-size: 11px; padding: 6px 12px; background: transparent; cursor: pointer;
    border: 1px solid var(--line, #1e3038); color: var(--text-dim, #b8c4cc); border-radius: 0; }
  .sof-box button:hover { border-color: var(--cyan-dim, #0a4a44); color: var(--cyan, #00f0d0); }
  .sof-box button.sof-ok { border-color: var(--cyan-dim, #0a4a44); color: var(--cyan, #00f0d0); }
  .sof-hint { margin-top: 8px; font-size: 10px; color: var(--text-faint, #5c6b73); line-height: 1.6; }`;

  let styleAdded = false;
  function addStyle() {
    if (styleAdded) return;
    styleAdded = true;
    const s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  // 調整の画面の外でも framed の表示が効くように、読み込んだ時点で入れておく
  if (document.head) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle);

  let busy = null; // 開いている調整の画面（同時に2つは開かない）

  function edit(opts) {
    addStyle();
    if (busy) busy.cancel();
    const aspect = Number(opts && opts.aspect) > 0 ? Number(opts.aspect) : 1;
    const src = opts && opts.src;
    if (!src) return Promise.resolve(null);
    return new Promise((resolve) => {
      let url = src, owned = false;
      if (src instanceof Blob) { url = URL.createObjectURL(src); owned = true; }
      const ov = document.createElement('div');
      ov.className = 'sideops-frame-overlay';
      ov.innerHTML = `<div class="sof-box" role="dialog" aria-modal="true">
        <div class="sof-title"></div>
        <div class="sof-frame"><img alt="" draggable="false"></div>
        <div class="sof-zoom"><span aria-hidden="true">－</span><input type="range" step="0.01" aria-label="拡大・縮小"><span aria-hidden="true">＋</span></div>
        <div class="sof-btns"><button type="button" data-a="fit">全体を表示</button><button type="button" data-a="fill">枠いっぱい</button></div>
        <div class="sof-hint">ドラッグで位置、ピンチ・ホイール・スライダーで拡大縮小。一覧などでは、この枠の通りに表示されます。</div>
        <div class="sof-actions"><button type="button" data-a="cancel">キャンセル</button><button type="button" class="sof-ok" data-a="ok">決定</button></div>
      </div>`;
      ov.querySelector('.sof-title').textContent = (opts && opts.label) ? `見え方の調整（${opts.label}）` : '見え方の調整';
      const frame = ov.querySelector('.sof-frame');
      const img = frame.querySelector('img');
      const zoom = ov.querySelector('input[type="range"]');
      // 枠の大きさ：横長は幅いっぱい（最大320px）、縦長は高さ（最大 画面の50%）に合わせる
      const maxW = Math.min(320, window.innerWidth - 64);
      const maxH = Math.max(140, Math.min(window.innerHeight * 0.5, 420));
      let fw = maxW, fh = fw / aspect;
      if (fh > maxH) { fh = maxH; fw = fh * aspect; }
      frame.style.width = Math.round(fw) + 'px';
      frame.style.height = Math.round(fh) + 'px';

      let state = null;
      function render() {
        if (!state) return;
        const L = layout(state, aspect);
        img.classList.add('sideops-framed');
        img.style.width = L.W + '%'; img.style.height = L.H + '%';
        img.style.left = L.left + '%'; img.style.top = L.top + '%';
        zoom.value = String(state.z);
      }
      function set(next) { if (state) { state = settle(next, aspect); render(); } }

      let backLayer = null; // SIDE-OPS本体の画面で開いたときの「戻る」の層（js/back-nav.js）
      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        busy = null;
        if (backLayer && window.SideOpsBackNav) { const l = backLayer; backLayer = null; window.SideOpsBackNav.release(l); }
        window.removeEventListener('keydown', onKey, true);
        ov.classList.remove('is-open');
        ov.remove();
        if (owned) URL.revokeObjectURL(url);
        resolve(value);
      }
      function onKey(e) {
        if (e.key !== 'Escape') return;
        // アプリ側の Esc（下のモーダルを閉じる等）まで届かないように止める
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      }
      busy = { cancel: () => finish(null) };

      img.onload = () => {
        const ar = img.naturalWidth / img.naturalHeight;
        if (!(ar > 0) || !Number.isFinite(ar)) return;
        const init = normalize(opts && opts.initial);
        // 保存済みの見え方は、同じ画像（縦横比がほぼ同じ）のときだけ引き継ぐ
        const keep = init && Math.abs(init.ar - ar) / ar < 0.02;
        state = settle(keep ? { ...init, ar } : { ar, z: 1, cx: 0.5, cy: 0.5 }, aspect);
        zoom.min = String(zMin(ar, aspect));
        zoom.max = String(Z_MAX);
        render();
      };
      img.onerror = () => { ov.querySelector('.sof-hint').textContent = '画像を読み込めませんでした。'; };
      img.src = url;

      const pointers = new Map();
      let pinch = null;
      frame.addEventListener('pointerdown', (e) => {
        if (!state) return;
        e.preventDefault();
        try { frame.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動かせる */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: state.z };
        }
      });
      frame.addEventListener('pointermove', (e) => {
        const p = pointers.get(e.pointerId);
        if (!p || !state) return;
        if (pointers.size === 1) {
          const L = layout(state, aspect);
          const dx = (e.clientX - p.x) / (frame.clientWidth || 1) * 100;
          const dy = (e.clientY - p.y) / (frame.clientHeight || 1) * 100;
          set({ ...state, cx: state.cx - dx / L.W, cy: state.cy - dy / L.H });
        }
        p.x = e.clientX; p.y = e.clientY;
        if (pointers.size === 2 && pinch) {
          const [a, b] = [...pointers.values()];
          set({ ...state, z: pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) });
        }
      });
      const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
      frame.addEventListener('pointerup', end);
      frame.addEventListener('pointercancel', end);
      frame.addEventListener('lostpointercapture', end);
      frame.addEventListener('wheel', (e) => {
        if (!state) return;
        e.preventDefault();
        set({ ...state, z: state.z * Math.exp(-e.deltaY * 0.0015) });
      }, { passive: false });
      zoom.addEventListener('input', () => set({ ...state, z: Number(zoom.value) }));

      ov.addEventListener('click', (e) => {
        if (e.target === ov) { finish(null); return; } // 背景のクリック＝キャンセル
        const b = e.target.closest('button[data-a]');
        if (!b) return;
        const a = b.dataset.a;
        if (a === 'fit' && state) set({ ...state, z: zMin(state.ar, aspect), cx: 0.5, cy: 0.5 });
        else if (a === 'fill' && state) set({ ...state, z: 1, cx: 0.5, cy: 0.5 });
        else if (a === 'cancel') finish(null);
        else if (a === 'ok') finish(state ? round(state) : null);
      });
      window.addEventListener('keydown', onKey, true);
      document.body.appendChild(ov);
      ov.classList.add('is-open');
      // 本体の画面（ランチャーのカバー）では、戻るボタンで閉じられるよう自分で層を積む。
      // アプリの中（Stage）では、テーマブリッジがこの画面をモーダルとして数えるので要らない
      if (window.SideOpsBackNav) backLayer = window.SideOpsBackNav.push('frame', () => { backLayer = null; finish(null); });
    });
  }

  window.SideOpsFrame = { applyImg, bgStyle, edit, normalize, round, measure, layout: (t, a) => layout(settle(t, a), a), Z_MAX };
})();
