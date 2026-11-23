/* =====================================================================
   SIDE-OPS：一時メモ（2026-10-10。「ノートへ」は 2026-11-24）
   ヘッダーの ✎（Stageを開いているときは Stage の ✎）で出し入れする、画面に浮かぶ小さなメモ。
   メモアプリとは別物で、Stageには開かない。書き留めておくだけの「その場のメモ」。

   決まり：
     ・中身はDB（IndexedDB）に保存せず、同期もしない。sessionStorage に置くので、
       再読み込みや、Androidのブラウザが裏でタブを読み込み直したときは残り、
       このタブ（ホーム画面のアプリなら、そのアプリ）を閉じたら消える
     ・隠しても（－・✎）中身は残る。消すのは「消す」を2回押したときと、閉じたときだけ
     ・位置と大きさだけは端末に覚える（localStorage。中身は入れない）
     ・モーダルではないので is-open は使わず、戻る操作（js/back-nav.js）の対象にしない
   歯止め：
     ・動かしても大きさを変えても、画面の外に出ないように収める。画面の大きさが変わったとき
       （回転・ウィンドウの大きさ・スマホのキーボード）も、見えている範囲に収め直す。
       覚えている位置は動かした結果だけで、収め直しでは書き換えない（キーボードを閉じたら元の位置へ）
     ・「消す」は2回押し（1回目で「もう一度で消す」に変わり、3秒で元に戻る）
     ・保存できない環境（sessionStorage が使えない）では、そう知らせる（再読み込みで消える）
   詳細は docs/core/claude_一時メモ_仕様書.md
   ===================================================================== */
(function () {
  'use strict';

  const TEXT_KEY = 'sideops_tempmemo_text';   // sessionStorage：中身
  const SHOWN_KEY = 'sideops_tempmemo_shown'; // sessionStorage：出しているか
  const RECT_KEY = 'sideops_tempmemo_rect';   // localStorage：位置と大きさ（端末ごと）
  const MARGIN = 8;
  const MIN_W = 180;
  const MIN_H = 120;
  const SAVE_DELAY_MS = 300;
  const ARM_MS = 3000;
  const HINT = '保存しません（閉じると消えます）';

  const panel = document.getElementById('tempMemo');
  if (!panel) return;
  const bar = document.getElementById('tempMemoBar');
  const text = document.getElementById('tempMemoText');
  const grip = document.getElementById('tempMemoGrip');
  const hint = document.getElementById('tempMemoHint');
  const copyBtn = document.getElementById('tempMemoCopyBtn');
  const saveBtn = document.getElementById('tempMemoSaveBtn');
  const clearBtn = document.getElementById('tempMemoClearBtn');
  const hideBtn = document.getElementById('tempMemoHideBtn');
  const toggles = [document.getElementById('tempMemoBtn'), document.getElementById('stageTempMemoBtn')].filter(Boolean);

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (err) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); return true; } catch (err) { return false; } }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

  /* ---- 位置と大きさ ---- */
  // 見えている範囲。スマホでキーボードが出ているときは、その上の部分（visualViewport）
  function viewport() {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) return { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height };
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  }
  function defaultRect() {
    const v = viewport();
    const small = v.w < 480;
    const w = small ? Math.min(300, v.w - MARGIN * 2) : 320;
    const h = small ? 200 : 240;
    const gap = small ? MARGIN : 24;
    return { x: v.x + v.w - w - gap, y: v.y + v.h - h - gap, w, h };
  }
  function loadRect() {
    try {
      const r = JSON.parse(localStorage.getItem(RECT_KEY) || 'null');
      if (r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && isFinite(n))) return r;
    } catch (err) { /* 読めなければ既定の位置 */ }
    return null;
  }
  function saveRect() {
    try { localStorage.setItem(RECT_KEY, JSON.stringify(rect)); } catch (err) { /* 覚えられなくても動く */ }
  }
  let rect = loadRect();

  // 覚えている位置（rect）を、今の画面の中に収めて置く。置いた結果を返す（rect は書き換えない）
  function place() {
    if (!rect) rect = defaultRect();
    const v = viewport();
    const maxW = Math.max(60, v.w - MARGIN * 2);
    const maxH = Math.max(60, v.h - MARGIN * 2);
    const w = Math.min(Math.max(rect.w, MIN_W), maxW);
    const h = Math.min(Math.max(rect.h, MIN_H), maxH);
    const x = clamp(rect.x, v.x + MARGIN, v.x + v.w - w - MARGIN);
    const y = clamp(rect.y, v.y + MARGIN, v.y + v.h - h - MARGIN);
    panel.style.left = Math.round(x) + 'px';
    panel.style.top = Math.round(y) + 'px';
    panel.style.width = Math.round(w) + 'px';
    panel.style.height = Math.round(h) + 'px';
    return { x, y, w, h };
  }
  function isShown() { return panel.classList.contains('is-shown'); }
  let placeTimer = null;
  function replaceSoon() {
    if (!isShown()) return;
    cancelAnimationFrame(placeTimer);
    placeTimer = requestAnimationFrame(place);
  }
  window.addEventListener('resize', replaceSoon);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', replaceSoon);
    window.visualViewport.addEventListener('scroll', replaceSoon);
  }

  // 動かす（つまみ）・大きさを変える（右下の角）。マウスも指も Pointer Events で同じに扱う
  function startDrag(e, mode) {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    const start = place();
    const sx = e.clientX;
    const sy = e.clientY;
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動かせる */ }
    document.body.classList.add('temp-memo-dragging');
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      rect = mode === 'move'
        ? { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h }
        : { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy };
      rect = place(); // 画面の外に出た分は収めた位置を覚える
    };
    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      target.removeEventListener('lostpointercapture', end);
      document.body.classList.remove('temp-memo-dragging');
      saveRect();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
  }
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // ボタンは押せるように
    startDrag(e, 'move');
  });
  grip.addEventListener('pointerdown', (e) => startDrag(e, 'size'));

  /* ---- 出し入れ ---- */
  function setShown(on, opts) {
    panel.classList.toggle('is-shown', on);
    toggles.forEach((b) => {
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    ssSet(SHOWN_KEY, on ? '1' : '0');
    if (on) {
      place();
      // マウスで使う端末だけ、すぐ書けるようにする（スマホでは勝手にキーボードを出さない）
      if (opts && opts.focus && window.matchMedia('(pointer: fine)').matches) text.focus();
    } else if (panel.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }
  toggles.forEach((b) => b.addEventListener('click', () => setShown(!isShown(), { focus: true })));
  hideBtn.addEventListener('click', () => setShown(false));

  /* ---- 中身 ---- */
  let hintTimer = null;
  function flash(msg) {
    hint.textContent = msg;
    hint.classList.add('is-flash');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.textContent = HINT; hint.classList.remove('is-flash'); }, 1800);
  }
  hint.textContent = HINT;

  let saveTimer = null;
  let storageOk = true;
  function saveText() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const ok = ssSet(TEXT_KEY, text.value);
    if (!ok && storageOk) flash('この端末では、再読み込みでも消えます');
    storageOk = ok;
  }
  text.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveText, SAVE_DELAY_MS);
  });
  // 離れる・隠れるときは待たずに残す（再読み込み・ブラウザが裏でタブを閉じる前に）
  window.addEventListener('pagehide', () => { if (saveTimer) saveText(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) saveText(); });

  copyBtn.addEventListener('click', async () => {
    if (!text.value) { flash('中身がありません'); return; }
    try {
      await navigator.clipboard.writeText(text.value);
      flash('コピーしました');
    } catch (err) {
      // 古い方法でも試す（クリップボードの許可がない環境など）
      text.focus();
      text.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err2) { ok = false; }
      flash(ok ? 'コピーしました' : 'コピーできませんでした');
    }
  });

  /* ---- FIELDNOTES（メモアプリ）に保存（2026-11-24） ----
     ユーザーの希望：「メモアプリに保存」ボタン。保存したら一時メモは空にする（ユーザーの選択）。
     ・書き込み先はメモアプリと同じ DB（sideops_memo の entries）。レコードの形もメモアプリと同じ
       { id: 'm_…', title: '', body, tags: [], createdAt, updatedAt }（タイトルは空＝一覧では本文の1行目が出る。フォルダは未分類）
     ・同期の「変えたよ」の印は、本体ページの書き込みにも js/sync.js が付ける（IDBObjectStore.put を包んでいる）
     ・DB がまだ無い端末（メモアプリを一度も開いていない）では、メモアプリと同じ形（版1・同じストアと索引）で作る
     ・Stage でメモアプリを開いていれば、増えたことを知らせる（アプリは足りないメモだけを読み足す）
     歯止め：
     ・空なら保存しない／保存中はボタンを押せない（二重に保存しない）
     ・保存できたと確かめてから空にする。失敗したら中身は残す */
  const MEMO_DB = 'sideops_memo';
  const MEMO_STORE = 'entries';
  function openMemoDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(MEMO_DB); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        // まだ無い：メモアプリ（apps/memo.html の openDb）と同じ形で作る
        const d = req.result;
        if (!d.objectStoreNames.contains(MEMO_STORE)) {
          const os = d.createObjectStore(MEMO_STORE, { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => d.close();
        if (!d.objectStoreNames.contains(MEMO_STORE)) { d.close(); reject(new Error('no store')); return; }
        resolve(d);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
  }
  async function saveToNotes(body) {
    const d = await openMemoDb();
    try {
      const now = Date.now();
      const entry = { id: 'm_' + now + '_' + Math.random().toString(36).slice(2, 8), title: '', body, tags: [], createdAt: now, updatedAt: now };
      await new Promise((resolve, reject) => {
        const tx = d.transaction(MEMO_STORE, 'readwrite');
        tx.objectStore(MEMO_STORE).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('abort'));
      });
      return entry;
    } finally {
      d.close();
    }
  }
  function tellNotesApp(id) {
    document.querySelectorAll('iframe').forEach((f) => {
      try { f.contentWindow.postMessage({ type: 'sideops:memo-added', id }, location.origin); } catch (err) { /* 送れなければ、アプリを開き直したときに出る */ }
    });
  }
  const PLACEHOLDER = text.getAttribute('placeholder') || '';
  let placeholderTimer = null;
  let saving = false;
  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    const body = text.value;
    if (!body.trim()) { flash('中身がありません'); return; }
    saving = true;
    saveBtn.disabled = true;
    try {
      const entry = await saveToNotes(body);
      // 保存のあいだに書き足していたら、その分は消さない（保存した中身と同じときだけ空にする）
      if (text.value === body) {
        text.value = '';
        saveText();
      }
      disarm();
      tellNotesApp(entry.id);
      flash('FIELDNOTES に保存しました');
      // 帯が狭いと知らせが見えないので、空になった欄にも出す
      text.setAttribute('placeholder', 'FIELDNOTES に保存しました（未分類）');
      clearTimeout(placeholderTimer);
      placeholderTimer = setTimeout(() => text.setAttribute('placeholder', PLACEHOLDER), 3000);
    } catch (err) {
      console.warn('一時メモを FIELDNOTES に保存できませんでした', err);
      flash('保存できませんでした（中身は残しています）');
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  });

  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer);
    armTimer = null;
    clearBtn.classList.remove('is-armed');
    clearBtn.textContent = '消す';
  }
  clearBtn.addEventListener('click', () => {
    if (!text.value) { disarm(); return; }
    if (!clearBtn.classList.contains('is-armed')) {
      clearBtn.classList.add('is-armed');
      clearBtn.textContent = 'もう一度で消す';
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, ARM_MS);
      return;
    }
    disarm();
    text.value = '';
    saveText();
    flash('消しました');
  });

  /* ---- 始め：再読み込みの前の状態に戻す ---- */
  text.value = ssGet(TEXT_KEY) || '';
  if (ssGet(SHOWN_KEY) === '1') setShown(true);
})();
