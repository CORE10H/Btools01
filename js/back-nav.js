/* =====================================================================
   SIDE-OPS：戻る操作で「いちばん上に開いているもの」を1つずつ閉じる（2026-10-06）
   スマホの戻るボタン／戻るジェスチャー、PCのブラウザの「戻る」（マウスの戻るボタン・Alt+←）で、
   本体のモーダル → Stageの中のアプリのモーダル → Stage の順に、開いた順の逆に閉じる。
   以前は Stage だけを閉じていた（js/main.js 内）。それを「層」の積み重ねに広げたもの。

   仕組み（枯れた定番：history.pushState + popstate）：
     ・何かを開いたとき（ユーザー操作の中）に履歴を1件積む。これを「層」と呼び、通し番号（seq）を付ける
     ・戻る操作で履歴が戻ったら（popstate）、戻った先の番号より大きい層を、上から順に閉じる
     ・✕などの画面の操作で閉じたときは、その層がいちばん上で、今の履歴の位置もその層だと
       確かめられたときだけ、自分で戻して消費する（消費しないと、次の戻る操作が空振りになる）
   歯止め：
     ・ユーザー操作なしで積んだ履歴は、Chromeの「戻るボタン乗っ取り対策」で読み飛ばされ、
       SIDE-OPSそのものから離れてしまう恐れがある。そのため、積むのはユーザー操作の中だけ
       （navigator.userActivation.isActive）。例外は、すでに自分の層の上にいるとき（読み飛ばされても
       行き先は自分の層なので、SIDE-OPSから離れない）と、呼び出し側が force を付けたとき（Stage）
     ・戻る操作を受けて積み直すことはしない（同じ理由）
     ・履歴の位置が自分の層だと確かめられないときは、履歴に触らない（取り違えて離れないように）
     ・番号には読み込みごとの目印（sid）を付け、再読み込み前の古い履歴と取り違えない
     ・閉じる処理がエラーになっても、ほかの層の処理は続ける
     ・再読み込み・ページ移動の途中（beforeunload の後）は履歴に触らない（戻すと再読み込みが打ち消される）
   使い方（js/main.js）：
     const layer = SideOpsBackNav.push(種類, 戻る操作で閉じるときの関数, { force })  … 積めなければ null
     SideOpsBackNav.release(layer または layer の配列)  … 画面の操作で閉じたとき
     SideOpsBackNav.watchOverlay(要素)  … is-open が付いたら層を積み、外れたら消費する（本体のモーダル用）
     SideOpsBackNav.backOne()  … 戻る操作が届かない場面（全画面の解除）で、戻る操作の代わりに1つ閉じる
   詳細は docs/core/claude_メインステージ_仕様書.md「戻る操作」
   ===================================================================== */
(function () {
  'use strict';

  const KEY = 'sideopsBack';
  const SELF_BACK_TIMEOUT_MS = 1000;
  const sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let seqCounter = 0;
  const live = [];        // 開いている層（下から順）。{ seq, kind, onBack }
  let selfBackUntil = 0;  // 自分で戻した結果（popstate）を待っている間（この間は新しく積まない）
  let leaving = false;    // 再読み込み・ページ移動が始まった（このあと履歴を戻すと、それを打ち消してしまう）

  // location.reload() 等の呼び出しの中で beforeunload が起きる。そのあとの片付け（モーダルが閉じたことへの
  // 反応など）で履歴を戻すと再読み込みが打ち消されるため、離れる途中は履歴に触らない。
  // 「離れますか？」の確認で取りやめた場合や、戻る・進むのキャッシュから戻った場合に備えて、少し後と pageshow で解除する
  window.addEventListener('beforeunload', () => {
    leaving = true;
    setTimeout(() => { leaving = false; }, 3000);
  });
  window.addEventListener('pageshow', () => { leaving = false; });

  function stateSeq(state) {
    const s = state && typeof state === 'object' ? state[KEY] : null;
    // 自分の層でない履歴（最初の1件・再読み込み前の履歴）は、いちばん下（0）として扱う
    if (!s || typeof s !== 'object' || s.sid !== sid || typeof s.seq !== 'number') return 0;
    return s.seq;
  }
  function hasActivation() {
    const ua = navigator.userActivation;
    return !ua || ua.isActive; // 判定できない古いブラウザでは、操作の中で呼ばれた前提で積む
  }
  function busy() { return Date.now() < selfBackUntil; }
  function top() { return live[live.length - 1] || null; }

  function push(kind, onBack, opts) {
    if (busy() || leaving) return null;
    const t = top();
    const onOwnLayer = !!(t && stateSeq(history.state) === t.seq);
    if (!(opts && opts.force) && !onOwnLayer && !hasActivation()) return null;
    const seq = ++seqCounter;
    try {
      history.pushState({ [KEY]: { sid, seq } }, '');
    } catch (err) {
      console.warn('戻る操作との連携を始められませんでした', err);
      return null;
    }
    const layer = { seq, kind, onBack };
    live.push(layer);
    return layer;
  }

  // 画面の操作で閉じた層を外す。いちばん上から続けて外れる分だけ、自分で履歴を戻して消費する。
  // 途中の層だけを外したときは履歴に触らない（その分、戻る操作が1回空振りになるだけで、取り違えは起きない）
  function release(layers) {
    const list = (Array.isArray(layers) ? layers : [layers]).filter(Boolean);
    if (!list.length) return;
    const t = top();
    const wasCurrent = !!(t && list.indexOf(t) >= 0 && stateSeq(history.state) === t.seq);
    let n = 0;
    for (let i = live.length - 1; i >= 0 && list.indexOf(live[i]) >= 0; i--) n++;
    list.forEach((l) => { const i = live.indexOf(l); if (i >= 0) live.splice(i, 1); });
    if (!wasCurrent || n === 0 || leaving) return;
    selfBackUntil = Date.now() + SELF_BACK_TIMEOUT_MS;
    history.go(-n);
  }

  function runBack(layer) {
    try { layer.onBack(); } catch (err) { console.error('戻る操作で閉じる処理に失敗しました', err); }
  }

  window.addEventListener('popstate', (ev) => {
    selfBackUntil = 0;
    const s = stateSeq(ev.state);
    // 戻った先より上の層を、上から順に閉じる（進む操作で上へ行った場合は、閉じるものがないので何もしない）
    const closing = [];
    while (live.length && top().seq > s) closing.push(live.pop());
    closing.forEach(runBack);
  });

  // 戻る操作が履歴に届かない場面（Androidの全画面表示の解除）で、戻る操作の代わりに1つ閉じる。
  // 履歴は進んでいないので、閉じた層の1件は自分で戻して消費する
  function backOne() {
    const t = top();
    if (!t) return false;
    release(t);
    runBack(t);
    return true;
  }

  // 本体のモーダル：is-open が付いたら層を積み、外れたら消費する。
  // 戻る操作では、背景のクリック（多くのモーダルは「背景をクリックで閉じる」）→ だめなら Esc で閉じる
  function closeOverlay(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (el.classList.contains('is-open')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
  }
  function watchOverlay(el) {
    if (!el) return;
    let layer = null;
    const sync = () => {
      const open = el.classList.contains('is-open');
      if (open && !layer) {
        layer = push('modal', () => { layer = null; closeOverlay(el); });
      } else if (!open && layer) {
        const l = layer;
        layer = null;
        release(l);
      }
    };
    new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  window.SideOpsBackNav = { push, release, backOne, watchOverlay, busy, depth: () => live.length };
})();
