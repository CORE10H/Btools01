(function () {
  'use strict';

  /* =====================================================================
     IndexedDB レイヤー
     artists / albums / tracks の3ストア構成。albums は artistId、
     tracks は albumId のインデックスで親子関係を絞り込み取得する
     （prompt-galleryは全件取得後にJS側でフィルタする設計だったが、
     今回は親子構造があり取得件数を抑えたいため index.getAll(key) を使う）。
     画像はBlobのまま保存（Base64化によるサイズ膨張を避けるため）。
  ===================================================================== */
  const DB_NAME = 'sideops_discotica';
  const DB_VERSION = 1;
  const STORE_ARTISTS = 'artists';
  const STORE_ALBUMS = 'albums';
  const STORE_TRACKS = 'tracks';
  let db = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const _db = ev.target.result;
        if (!_db.objectStoreNames.contains(STORE_ARTISTS)) {
          const s = _db.createObjectStore(STORE_ARTISTS, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!_db.objectStoreNames.contains(STORE_ALBUMS)) {
          const s = _db.createObjectStore(STORE_ALBUMS, { keyPath: 'id' });
          s.createIndex('artistId', 'artistId', { unique: false });
        }
        if (!_db.objectStoreNames.contains(STORE_TRACKS)) {
          const s = _db.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
          s.createIndex('albumId', 'albumId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function store(name, mode) {
    return db.transaction(name, mode).objectStore(name);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGetAll(name) {
    return reqToPromise(store(name, 'readonly').getAll());
  }
  function dbGetAllByIndex(name, indexName, key) {
    return reqToPromise(store(name, 'readonly').index(indexName).getAll(key));
  }
  function dbPut(name, obj) {
    return reqToPromise(store(name, 'readwrite').put(obj));
  }
  function dbDelete(name, id) {
    return reqToPromise(store(name, 'readwrite').delete(id));
  }

  function newId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* ===================== 画像URL管理 =====================
     Blob→ObjectURLは作成しっぱなしにするとメモリリークするため、
     再描画のたびに古いURLをrevokeしてから新しく生成する。
     画面（アーティスト一覧／Discography）ごとに独立した管理にしているのは、
     片方の再描画がもう片方の表示中URLを巻き添えでrevokeしてしまう事故を
     防ぐため（例：Discographyを開いたままアーティスト一覧が裏で再描画される等）。 */
  function createUrlPool() {
    const pool = new Set();
    return {
      make(blob) {
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        pool.add(url);
        return url;
      },
      revokeAll() {
        pool.forEach(u => URL.revokeObjectURL(u));
        pool.clear();
      },
    };
  }
  const artistListUrls = createUrlPool();   // ①トップ画面のアーティスト一覧用
  const artistBioUrls = createUrlPool();    // ②アーティスト詳細のプロフィール画像用

  /* 背景演出用URL保持（2026-09-25）：createUrlPoolは「一覧を作り直すたびに
     全部解放」という一覧向けの寿命管理だが、背景は表示され続けている画像を
     revokeAllで消してしまうと表示中の背景が消える。ここでは「直前の1枚だけ
     覚えておき、新しい画像に切り替わったタイミングで古い方だけ解放する」
     という、背景演出向けの寿命管理にする。 */
  function createSingleUrlHolder() {
    let current = null;
    return {
      make(blob) {
        const fresh = blob ? URL.createObjectURL(blob) : null;
        if (current) URL.revokeObjectURL(current);
        current = fresh;
        return fresh;
      },
    };
  }
  const artistBgUrl = createSingleUrlHolder();
  const discographyUrls = createUrlPool();  // ②Discography（アルバム一覧）用
  const modalPreviewUrls = createUrlPool(); // 登録モーダルのプレビュー画像用

  /* ===================== state ===================== */
  let artists = [];        // トップ画面用キャッシュ
  let currentArtist = null;
  let currentAlbums = [];  // 現在開いているアーティストのアルバム一覧
  let currentAlbum = null;
  let currentTracks = [];  // 現在開いているアルバムの楽曲一覧

  let artistCenterIndex = 0;

  let pendingArtistImageBlob = null;
  let pendingAlbumImageBlob = null;

  // 再生状態：どのオーディオ要素が今鳴っているか、対応する楽曲id
  const audioEl = new Audio();
  let playingTrackId = null;

  // 削除確認ダイアログの対象を汎用的に保持
  let pendingDelete = null; // { kind: 'artist'|'album'|'track', id, run: async fn }

  /* ===================== DOM refs ===================== */
  const artistTrack = document.getElementById('artistTrack');
  const artistPrevBtn = document.getElementById('artistPrevBtn');
  const artistNextBtn = document.getElementById('artistNextBtn');
  const artistBgLayerA = document.getElementById('artistBgLayerA');
  const artistBgLayerB = document.getElementById('artistBgLayerB');

  const artistViewOverlay = document.getElementById('artistViewOverlay');
  const artistViewTitle = document.getElementById('artistViewTitle');
  const artistBioCover = document.getElementById('artistBioCover');
  const artistBioInput = document.getElementById('artistBioInput');
  const artistBioSaveBtn = document.getElementById('artistBioSaveBtn');
  const artistViewCloseBtn = document.getElementById('artistViewCloseBtn');
  const artistDeleteBtn = document.getElementById('artistDeleteBtn');
  const albumTrack = document.getElementById('albumTrack');

  const albumViewOverlay = document.getElementById('albumViewOverlay');
  const albumViewEyebrow = document.getElementById('albumViewEyebrow');
  const albumViewTitle = document.getElementById('albumViewTitle');
  const albumViewCloseBtn = document.getElementById('albumViewCloseBtn');
  const albumDeleteBtn = document.getElementById('albumDeleteBtn');
  const trackTrack = document.getElementById('trackTrack');
  const miniPlayer = document.getElementById('miniPlayer');
  const mpTrackName = document.getElementById('mpTrackName');
  const mpArtistName = document.getElementById('mpArtistName');
  const mpStopBtn = document.getElementById('mpStopBtn');

  const artistModalOverlay = document.getElementById('artistModalOverlay');
  const artistImageDrop = document.getElementById('artistImageDrop');
  const artistImageDropText = document.getElementById('artistImageDropText');
  const artistImageInput = document.getElementById('artistImageInput');
  const artistNameInput = document.getElementById('artistNameInput');
  const artistBioModalInput = document.getElementById('artistBioModalInput');
  const artistModalCloseBtn = document.getElementById('artistModalCloseBtn');
  const artistModalCancelBtn = document.getElementById('artistModalCancelBtn');
  const artistModalSaveBtn = document.getElementById('artistModalSaveBtn');

  const albumModalOverlay = document.getElementById('albumModalOverlay');
  const albumModalTitle = document.getElementById('albumModalTitle');
  const albumImageDrop = document.getElementById('albumImageDrop');
  const albumImageDropText = document.getElementById('albumImageDropText');
  const albumImageInput = document.getElementById('albumImageInput');
  const albumTitleInput = document.getElementById('albumTitleInput');
  const albumModalCloseBtn = document.getElementById('albumModalCloseBtn');
  const albumModalCancelBtn = document.getElementById('albumModalCancelBtn');
  const albumModalSaveBtn = document.getElementById('albumModalSaveBtn');
  let editingAlbumId = null;

  const trackModalOverlay = document.getElementById('trackModalOverlay');
  const trackModalTitle = document.getElementById('trackModalTitle');
  const trackTitleInput = document.getElementById('trackTitleInput');
  const trackAudioUrlInput = document.getElementById('trackAudioUrlInput');
  const trackLyricsInput = document.getElementById('trackLyricsInput');
  const trackDescInput = document.getElementById('trackDescInput');
  const trackModalCloseBtn = document.getElementById('trackModalCloseBtn');
  const trackModalCancelBtn = document.getElementById('trackModalCancelBtn');
  const trackModalSaveBtn = document.getElementById('trackModalSaveBtn');

  const confirmOverlay = document.getElementById('confirmOverlay');
  const confirmMsg = document.getElementById('confirmMsg');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

  const toast = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  /* ===================== 汎用削除確認ダイアログ =====================
     フールプルーフ：削除は必ずこのダイアログを経由させ、即時実行させない。
     連鎖削除（アーティスト削除→配下アルバム・楽曲も削除）の場合は
     件数をメッセージに明記し、何が消えるか誤解のないようにする。 */
  function openConfirm(message, runFn) {
    pendingDelete = { run: runFn };
    confirmMsg.textContent = message;
    confirmOverlay.classList.add('is-open');
  }
  function closeConfirm() {
    pendingDelete = null;
    confirmOverlay.classList.remove('is-open');
  }
  confirmCancelBtn.addEventListener('click', closeConfirm);
  confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeConfirm(); });
  confirmDeleteBtn.addEventListener('click', async () => {
    if (!pendingDelete) return;
    const runFn = pendingDelete.run;
    closeConfirm();
    try {
      await runFn();
    } catch (err) {
      console.error(err);
      showToast('削除に失敗しました');
    }
  });

  /* ===================== 再生停止（共通） ===================== */
  function stopPlayback() {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    playingTrackId = null;
    miniPlayer.classList.remove('is-active');
    renderTracks();
  }
  audioEl.addEventListener('ended', () => {
    // アルバム内連続再生：終わった楽曲の次のトラックへ自動遷移。
    // 最後の曲まで再生し終えたら停止する（先頭へのループはしない）。
    const idx = currentTracks.findIndex(t => t.id === playingTrackId);
    if (idx >= 0 && idx < currentTracks.length - 1) {
      playTrack(currentTracks[idx + 1]);
    } else {
      stopPlayback();
    }
  });
  audioEl.addEventListener('error', () => {
    // 外部URLが無効／読み込み失敗した場合のフールプルーフ：
    // 再生中フラグを残したまま止まってしまうのを防ぐ。
    if (playingTrackId) {
      showToast('音源の再生に失敗しました（URLをご確認ください）');
      stopPlayback();
    }
  });
  mpStopBtn.addEventListener('click', stopPlayback);

  function playTrack(track) {
    if (!track.audioUrl) {
      showToast('この楽曲には音源が登録されていません');
      return;
    }
    playingTrackId = track.id;
    audioEl.src = track.audioUrl;
    audioEl.play().catch(() => {
      showToast('再生できませんでした（URLをご確認ください）');
      stopPlayback();
    });
    mpTrackName.textContent = track.title;
    mpArtistName.textContent = currentArtist ? currentArtist.name : '';
    miniPlayer.classList.add('is-active');
    renderTracks();
  }

  function togglePlayTrack(track) {
    if (playingTrackId === track.id) {
      stopPlayback();
    } else {
      playTrack(track);
    }
  }

  /* ===================== ① Top: アーティスト一覧（縦型カバーフロー） ===================== */
  async function loadArtists() {
    artists = await dbGetAll(STORE_ARTISTS);
    artists.sort((a, b) => a.createdAt - b.createdAt);
    // ダミー埋め込み後の実際の表示件数を基準に境界チェックする
    // （artists.length+1 のみだと、ダミーで嵩増しした分だけ判定が緩くなり、
    // 存在しないインデックスを中央に指したままになるバグを生む）
    if (artistCenterIndex >= artistItemsWithAdd().length) artistCenterIndex = 0;
    buildArtistCoverflow();
  }

  /* ===================== アーティスト一覧：横型リング（3Dカルーセル） =====================
     2026-09-24 作り直し。円筒の「外周」にカードを平らなまま貼り付け、円筒ごと
     回す方式。CSS 3D transforms の定番の作り方（枯れた手法）を使っている。
       ・各カードは rotateY(角度) で向きを振ってから translateZ(半径) で外側へ
         押し出す → カードは曲がらず、円筒の外周に接する向きで平らに貼られる
       ・回転はカードではなく親（トラック）ごと rotateY で行う
       ・トラックを rotateX で手前に傾け、斜め上から見下ろす構図にする
         （見下ろすと奥の物ほど画面の上に見える。奥のカードが手前のカードの
         上に顔を出すので、最奥のカードも見える）
     旧版（左右のカードを中央へ向けて傾ける方式）は「リングの内側」から見た
     見え方になっていたため、方式ごと置き換えた。 */

  // 円筒の面数（＝一周に並ぶ枚数）。8面＝1枚あたり45度
  const ARTIST_RING_SLOTS = 8;
  const ARTIST_RING_STEP_DEG = 360 / ARTIST_RING_SLOTS;
  // 半径の割増率。1.0でカードの角同士がぴったり接する。少し開けて1枚ずつ独立させる
  const ARTIST_RING_GAP = 1.08;
  // 見下ろす角度（度）
  const ARTIST_RING_TILT_DEG = 14;
  // トラックパッドは1回のジェスチャーでホイールイベントを大量に出すため、
  // 1コマ送った直後はしばらくホイールを無視する（リングの空回り防止）
  const ARTIST_WHEEL_COOLDOWN_MS = 220;

  /* リングの面がすべて埋まるための最低枚数＝面数（8枚）。
     実データ（＋追加カード込み）がこれに満たない場合、NOW MASTERINGの
     ダミーカードで埋める。ダミーは「＋追加する」と同じ導線（クリックで
     追加モーダルを開く）を持つ、ラベル違いの同じボタンという位置づけ。 */
  const ARTIST_MIN_RING_ITEMS = ARTIST_RING_SLOTS;

  /* 回転位置（上限なしの整数）。中央インデックス（0〜件数-1）とは別に持つ。
     末尾→先頭へ送ったときにインデックスは戻るが、リングは逆回転せず
     常に同じ向きへ1面ぶん（45度）だけ回る、という動きを作るため。 */
  let artistRingPos = 0;

  function ringMod(n, m) { return ((n % m) + m) % m; }

  // カードiが中央から何面ずれているか（最短の向き。範囲は -floor(len/2) 〜）
  function artistRingOffset(i, center, len) {
    const half = Math.floor(len / 2);
    return ringMod(i - center + half, len) - half;
  }

  function artistItemsWithAdd() {
    // 末尾に「＋アーティストを追加する」の空アイテムを常設。
    const base = [...artists, { empty: true, id: '__add__' }];
    const shortfall = ARTIST_MIN_RING_ITEMS - base.length;
    if (shortfall > 0) {
      for (let i = 0; i < shortfall; i++) {
        base.push({ dummy: true, id: `__dummy_${i}__` });
      }
    }
    return base;
  }

  function buildArtistCoverflow() {
    artistListUrls.revokeAll();
    artistTrack.innerHTML = '';
    const items = artistItemsWithAdd();
    items.forEach((a, i) => {
      const el = document.createElement('div');
      el.className = 'artist-cf-item' + (a.empty ? ' empty' : '') + (a.dummy ? ' dummy' : '');
      if (a.empty) {
        el.textContent = '＋';
      } else if (a.dummy) {
        el.innerHTML = `<div class="artist-name-plate dummy-plate">NOW MASTERING</div>`;
      } else {
        el.innerHTML = `<div class="artist-name-plate">${escapeHtml(a.name)}</div>`;
        if (a.coverImg) {
          el.style.backgroundImage = `linear-gradient(0deg, rgba(var(--bg-rgb),.85), rgba(var(--bg-rgb),0) 55%), url('${artistListUrls.make(a.coverImg)}')`;
        }
      }
      el.addEventListener('click', () => {
        if (i === artistCenterIndex) {
          // ダミーカードは「＋追加する」と同じ導線（ラベル違いの同じボタン）
          if (a.empty || a.dummy) {
            openArtistModal();
          } else {
            openArtistView(a);
          }
          return;
        }
        // 押したカードが最短の向きで手前に来るよう回す
        artistRingPos += artistRingOffset(i, artistCenterIndex, items.length);
        renderArtistCoverflow();
      });
      artistTrack.appendChild(el);
    });
    // 作り直し直後は回転位置を中央インデックスに揃え、アニメーションなしで
    // 反映する（データを読み直すたびにリングが空回りするのを防ぐ）
    artistRingPos = artistCenterIndex;
    artistTrack.classList.add('no-anim');
    renderArtistCoverflow();
    void artistTrack.offsetWidth; // ここで一度描画を確定させてから演出を戻す
    artistTrack.classList.remove('no-anim');
  }

  function renderArtistCoverflow() {
    const items = artistTrack.querySelectorAll('.artist-cf-item');
    const len = items.length;
    if (!len) return;
    artistCenterIndex = ringMod(artistRingPos, len);

    // 半径はカードの実際の幅から計算する（画面幅でカード幅が変わっても、
    // 8枚がちょうど一周に収まる半径を毎回求め直す）
    const cardW = items[0].offsetWidth || 1;
    const radius = Math.round((cardW / 2) / Math.tan(Math.PI / ARTIST_RING_SLOTS) * ARTIST_RING_GAP);
    // 傾けると手前のカードが下へ下がるので、その半分だけ全体を持ち上げて画面中央に寄せる
    const lift = Math.round(radius * Math.sin(ARTIST_RING_TILT_DEG * Math.PI / 180) * 0.5);

    artistTrack.style.transform =
      `translateY(${-lift}px) translateZ(${-radius}px) ` +
      `rotateX(${-ARTIST_RING_TILT_DEG}deg) rotateY(${-artistRingPos * ARTIST_RING_STEP_DEG}deg)`;

    items.forEach((el, i) => {
      const off = artistRingOffset(i, artistCenterIndex, len);
      // このカードが貼られる面の通し番号（回転位置と同じく上限なし）
      const k = artistRingPos + off;
      // 件数が面数より多いと、真裏付近で2枚以上が同じ面に重なる。
      // 真裏の面には左回り側（off = -面数/2）の1枚だけを残し、それより先は隠す。
      // 回したとき、真裏の面では出ていく1枚と入ってくる1枚が入れ替わりに
      // フェードするので、リングに穴が空かない
      const halfSlots = ARTIST_RING_SLOTS / 2;
      const hidden = len > ARTIST_RING_SLOTS && (off >= halfSlots || off < -halfSlots);
      // 90度より奥のカードは背中をこちらに向けている（文字が鏡文字になる）
      const facingAway = Math.abs(off) * ARTIST_RING_STEP_DEG > 90;

      // 貼る面が変わった（末尾⇔先頭の繋ぎ目をまたいだ）カードは、
      // アニメーションさせずに瞬時に移す。させるとリングを一周して飛んで見える
      const prevK = el.dataset.ringK;
      const jumped = prevK !== undefined && Number(prevK) !== k;
      if (jumped) el.style.transition = 'none';
      el.style.transform = `translate(-50%, -50%) rotateY(${k * ARTIST_RING_STEP_DEG}deg) translateZ(${radius}px)`;
      el.dataset.ringK = String(k);
      if (jumped) { void el.offsetWidth; el.style.transition = ''; }

      el.classList.toggle('is-center', off === 0);
      el.classList.toggle('is-back', facingAway && !hidden);
      el.classList.toggle('is-hidden', hidden);
    });

    scheduleArtistBgUpdate();
  }

  /* 中央カード連動の背景（2026-09-25）。
     ・回転アニメーション（.artist-cf-track の transition: .6s）が収まって
       からさらに間を置いて読み込む。センターが高速に送られている最中に
       毎回読み込むとあわただしいため
     ・連続で送られた場合は、直前の予約をキャンセルして最後の1回だけ発火する
       （最終的に中央で止まったカードの画像だけを読みに行く） */
  const ARTIST_BG_SETTLE_MS = 650; // トラックの回転(.6s)が収まってからの余裕分
  let artistBgTimer = null;
  let artistBgActiveLayer = artistBgLayerA; // 現在表に出ている側

  function scheduleArtistBgUpdate() {
    if (artistBgTimer) clearTimeout(artistBgTimer);
    artistBgTimer = setTimeout(applyArtistBgForCenter, ARTIST_BG_SETTLE_MS);
  }

  function applyArtistBgForCenter() {
    artistBgTimer = null;
    const items = artistItemsWithAdd();
    const centered = items[artistCenterIndex];
    // ＋カード／NOW MASTERINGダミー／カバー画像未設定のアーティストが
    // 中央のときは、背景なし（今の単色背景）に戻す
    const blob = (centered && !centered.empty && !centered.dummy) ? centered.coverImg : null;
    const url = artistBgUrl.make(blob || null);

    const incoming = artistBgActiveLayer === artistBgLayerA ? artistBgLayerB : artistBgLayerA;
    const outgoing = artistBgActiveLayer;

    if (!url) {
      // 背景なしに戻すときは、表に出ている方をフェードアウトさせるだけでよい
      outgoing.classList.remove('is-visible');
      artistBgActiveLayer = incoming; // 次に画像が来たときは空側から使う
      return;
    }
    incoming.style.backgroundImage = `url('${url}')`;
    // 順序が大事：先に裏側へ新しい画像をセットしてから表へ出す。
    // 同時に古い方を消すことで、2枚がクロスフェードする
    requestAnimationFrame(() => {
      incoming.classList.add('is-visible');
      outgoing.classList.remove('is-visible');
    });
    artistBgActiveLayer = incoming;
  }

  /* 1コマ送る処理の共通化。ボタン・ホイール・スワイプ・矢印キーの4系統すべてが
     ここを通る。回転位置を1つ進めるだけで、中央インデックスは描画時に求める。 */
  function stepArtistCoverflow(dir) {
    artistRingPos += dir;
    renderArtistCoverflow();
  }

  artistPrevBtn.addEventListener('click', () => stepArtistCoverflow(-1));
  artistNextBtn.addEventListener('click', () => stepArtistCoverflow(1));

  const artistCfWrapEl = document.querySelector('.artist-cf-wrap');
  let artistWheelLockUntil = 0;
  artistCfWrapEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (Date.now() < artistWheelLockUntil) return;
    // 縦ホイールと、トラックパッドの横スクロールの両方を受ける（大きい方を採用）
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (d === 0) return;
    stepArtistCoverflow(d > 0 ? 1 : -1);
    artistWheelLockUntil = Date.now() + ARTIST_WHEEL_COOLDOWN_MS;
  }, { passive: false });

  // Stageの表示範囲切替などで画面幅が変わるとカード幅も変わるため、半径を計算し直す
  window.addEventListener('resize', () => renderArtistCoverflow());

  /* 左右矢印キー（2026-09-24）：アーティスト一覧が画面に見えている間だけ
     有効にしたいが、このアプリはStage内のiframeとして常に単独表示される
     ため（他のパネルとキー入力を取り合わない）、document全体で拾ってよい。
     ただし他のモーダル（追加モーダル・詳細ビュー等）が開いている間は
     誤操作防止のため無効化する。 */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const anyOverlayOpen = document.querySelector('.view-overlay.is-open, .modal-overlay.is-open, .confirm-overlay.is-open');
    if (anyOverlayOpen) return;
    e.preventDefault();
    stepArtistCoverflow(e.key === 'ArrowRight' ? 1 : -1);
  });

  /* 縦型カバーフロー（js/main.js）と同じ、枯れた実装パターンのスワイプ対応。
     誤作動防止策も同じ考え方で踏襲：
       ・1本指のみ／2本指以上（ピンチ等）は対象外
       ・40px以上の横移動で1回だけ送る（1スワイプ＝1枚、連続送りしない）
       ・縦方向の動きの方が大きければ無視（斜めの誤操作対策）
       ・送った直後の短時間はクリックを捨て、指を離した位置のカードが
         誤ってタップ扱いされるのを防ぐ */
  const ARTIST_SWIPE_THRESHOLD_PX = 40;
  const ARTIST_SWIPE_CLICK_GUARD_MS = 400;
  let artistSwipeState = null;
  let artistSuppressClickUntil = 0;

  artistCfWrapEl.addEventListener('touchstart', (e) => {
    artistSwipeState = null;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    artistSwipeState = { x: t.clientX, y: t.clientY, fired: false };
  }, { passive: true });

  artistCfWrapEl.addEventListener('touchmove', (e) => {
    if (!artistSwipeState) return;
    if (e.touches.length !== 1) { artistSwipeState = null; return; }
    if (artistSwipeState.fired) return;
    const t = e.touches[0];
    const dx = t.clientX - artistSwipeState.x;
    const dy = t.clientY - artistSwipeState.y;
    if (Math.abs(dx) < ARTIST_SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
    // 指を左へ払う＝右にある次のカードが中央へ
    stepArtistCoverflow(dx < 0 ? 1 : -1);
    artistSwipeState.fired = true;
    artistSuppressClickUntil = Date.now() + ARTIST_SWIPE_CLICK_GUARD_MS;
  }, { passive: true });

  const clearArtistSwipe = () => { artistSwipeState = null; };
  artistCfWrapEl.addEventListener('touchend', clearArtistSwipe, { passive: true });
  artistCfWrapEl.addEventListener('touchcancel', clearArtistSwipe, { passive: true });

  // キャプチャ段階で先に拾い、各カードのclick処理に届く前に捨てる
  artistTrack.addEventListener('click', (e) => {
    if (Date.now() < artistSuppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  /* ===================== アーティスト：追加モーダル ===================== */
  function bindImageDropClick(dropEl, inputEl) {
    dropEl.addEventListener('click', () => inputEl.click());
  }
  bindImageDropClick(artistImageDrop, artistImageInput);
  bindImageDropClick(albumImageDrop, albumImageInput);

  function resetArtistModal() {
    pendingArtistImageBlob = null;
    artistNameInput.value = '';
    artistBioModalInput.value = '';
    artistImageDrop.classList.remove('has-image');
    artistImageDrop.innerHTML = '<span id="artistImageDropText">クリックして画像を選択</span><input type="file" id="artistImageInput" accept="image/*">';
    // input要素を作り直したため参照を再取得してイベントを再バインド
    const freshInput = document.getElementById('artistImageInput');
    freshInput.addEventListener('change', handleArtistImageChange);
  }
  function handleArtistImageChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('画像ファイルを選択してください');
      return;
    }
    pendingArtistImageBlob = file;
    const url = modalPreviewUrls.make(file);
    artistImageDrop.classList.add('has-image');
    artistImageDrop.innerHTML = `<img src="${url}" alt="">`;
  }
  document.getElementById('artistImageInput').addEventListener('change', handleArtistImageChange);

  function openArtistModal() {
    resetArtistModal();
    artistModalOverlay.classList.add('is-open');
  }
  function closeArtistModal() {
    artistModalOverlay.classList.remove('is-open');
  }
  artistModalCloseBtn.addEventListener('click', closeArtistModal);
  artistModalCancelBtn.addEventListener('click', closeArtistModal);
  artistModalOverlay.addEventListener('click', (e) => { if (e.target === artistModalOverlay) closeArtistModal(); });

  artistModalSaveBtn.addEventListener('click', async () => {
    const name = artistNameInput.value.trim();
    if (!name) {
      showToast('アーティスト名を入力してください');
      return;
    }
    const artist = {
      id: newId('ar'),
      name,
      bio: artistBioModalInput.value.trim(),
      coverImg: pendingArtistImageBlob || null,
      createdAt: Date.now(),
    };
    try {
      await dbPut(STORE_ARTISTS, artist);
      showToast('アーティストを追加しました');
      closeArtistModal();
      modalPreviewUrls.revokeAll();
      await loadArtists();
    } catch (err) {
      console.error(err);
      showToast('保存に失敗しました');
    }
  });

  /* ===================== ② アーティスト詳細モーダル ===================== */
  async function openArtistView(artist) {
    currentArtist = artist;
    artistViewTitle.textContent = artist.name;
    artistBioInput.value = artist.bio || '';
    artistBioCover.style.backgroundImage = artist.coverImg
      ? `url('${artistBioUrls.make(artist.coverImg)}')` : 'none';
    await loadAlbumsForArtist(artist.id);
    artistViewOverlay.classList.add('is-open');
  }
  function closeArtistView() {
    artistViewOverlay.classList.remove('is-open');
    artistBioUrls.revokeAll();
    discographyUrls.revokeAll();
    currentArtist = null;
    currentAlbums = [];
  }
  artistViewCloseBtn.addEventListener('click', closeArtistView);

  artistBioSaveBtn.addEventListener('click', async () => {
    if (!currentArtist) return;
    currentArtist.bio = artistBioInput.value.trim();
    try {
      await dbPut(STORE_ARTISTS, currentArtist);
      showToast('概要を保存しました');
      await loadArtists(); // トップ画面のキャッシュも同期
    } catch (err) {
      console.error(err);
      showToast('保存に失敗しました');
    }
  });

  artistDeleteBtn.addEventListener('click', () => {
    if (!currentArtist) return;
    const artist = currentArtist;
    // 連鎖削除の対象件数を事前に数えてメッセージに明記する（誤操作防止）。
    (async () => {
      const albums = await dbGetAllByIndex(STORE_ALBUMS, 'artistId', artist.id);
      let trackCount = 0;
      for (const al of albums) {
        const trs = await dbGetAllByIndex(STORE_TRACKS, 'albumId', al.id);
        trackCount += trs.length;
      }
      const msg = albums.length > 0
        ? `アーティスト「${artist.name}」を削除します。紐づくアルバム${albums.length}件・楽曲${trackCount}曲もすべて削除され、復元できません。よろしいですか？`
        : `アーティスト「${artist.name}」を削除します。復元できません。よろしいですか？`;
      openConfirm(msg, async () => {
        for (const al of albums) {
          const trs = await dbGetAllByIndex(STORE_TRACKS, 'albumId', al.id);
          for (const tr of trs) await dbDelete(STORE_TRACKS, tr.id);
          await dbDelete(STORE_ALBUMS, al.id);
        }
        await dbDelete(STORE_ARTISTS, artist.id);
        showToast('アーティストを削除しました');
        closeArtistView();
        await loadArtists();
      });
    })();
  });

  /* ===================== Discography（アルバムのカバーフロー） ===================== */
  async function loadAlbumsForArtist(artistId) {
    currentAlbums = await dbGetAllByIndex(STORE_ALBUMS, 'artistId', artistId);
    currentAlbums.sort((a, b) => a.createdAt - b.createdAt);
    await renderAlbums();
  }

  async function renderAlbums() {
    // prompt-galleryの設計を踏襲：再描画のたびに古いObjectURLをrevokeしてから
    // 作り直す（作りっぱなしにするとメモリリークするため）。Discography専用の
    // プールにしているので、同時に開いているアーティストのプロフィール画像
    // （artistBioUrls）は巻き添えで消えない。
    discographyUrls.revokeAll();
    albumTrack.innerHTML = '';
    for (const al of currentAlbums) {
      const el = document.createElement('div');
      el.className = 'album-card';
      if (al.coverImg) {
        el.style.backgroundImage = `url('${discographyUrls.make(al.coverImg)}')`;
      }
      const tracks = await dbGetAllByIndex(STORE_TRACKS, 'albumId', al.id);
      tracks.sort((a, b) => a.order - b.order);
      const popTracksHtml = tracks.length
        ? tracks.map(t => `<div class="ap-track">♪ ${escapeHtml(t.title)}</div>`).join('')
        : '<div class="ap-empty">収録曲はまだありません</div>';
      el.innerHTML = `
        <button class="card-del-btn" data-album-id="${al.id}" title="削除">🗑</button>
        <div class="album-pop">
          <div class="ap-label">TRACKLIST</div>
          ${popTracksHtml}
        </div>
        <div class="album-title-plate">${escapeHtml(al.title)}</div>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.card-del-btn')) return;
        openAlbumView(al);
      });
      el.querySelector('.card-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDeleteAlbum(al);
      });
      albumTrack.appendChild(el);
    }
    // 末尾：＋アルバムを追加する
    const addEl = document.createElement('div');
    addEl.className = 'album-card add-card';
    addEl.innerHTML = `<div class="plus-icon">＋</div><div>アルバムを追加する</div>`;
    addEl.addEventListener('click', () => openAlbumModal());
    albumTrack.appendChild(addEl);
  }

  function confirmDeleteAlbum(album) {
    (async () => {
      const trs = await dbGetAllByIndex(STORE_TRACKS, 'albumId', album.id);
      const msg = trs.length > 0
        ? `アルバム「${album.title}」を削除します。収録曲${trs.length}曲もすべて削除され、復元できません。よろしいですか？`
        : `アルバム「${album.title}」を削除します。復元できません。よろしいですか？`;
      openConfirm(msg, async () => {
        for (const tr of trs) await dbDelete(STORE_TRACKS, tr.id);
        await dbDelete(STORE_ALBUMS, album.id);
        showToast('アルバムを削除しました');
        await loadAlbumsForArtist(currentArtist.id);
      });
    })();
  }

  /* ===================== アルバム：追加モーダル ===================== */
  function resetAlbumModal() {
    editingAlbumId = null;
    pendingAlbumImageBlob = null;
    albumModalTitle.textContent = 'アルバムを追加';
    albumTitleInput.value = '';
    albumImageDrop.classList.remove('has-image');
    albumImageDrop.innerHTML = '<span id="albumImageDropText">クリックして画像を選択</span><input type="file" id="albumImageInput" accept="image/*">';
    const freshInput = document.getElementById('albumImageInput');
    freshInput.addEventListener('change', handleAlbumImageChange);
  }
  function handleAlbumImageChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('画像ファイルを選択してください');
      return;
    }
    pendingAlbumImageBlob = file;
    const url = modalPreviewUrls.make(file);
    albumImageDrop.classList.add('has-image');
    albumImageDrop.innerHTML = `<img src="${url}" alt="">`;
  }
  document.getElementById('albumImageInput').addEventListener('change', handleAlbumImageChange);

  function openAlbumModal() {
    resetAlbumModal();
    albumModalOverlay.classList.add('is-open');
  }
  function closeAlbumModal() {
    albumModalOverlay.classList.remove('is-open');
  }
  albumModalCloseBtn.addEventListener('click', closeAlbumModal);
  albumModalCancelBtn.addEventListener('click', closeAlbumModal);
  albumModalOverlay.addEventListener('click', (e) => { if (e.target === albumModalOverlay) closeAlbumModal(); });

  albumModalSaveBtn.addEventListener('click', async () => {
    const title = albumTitleInput.value.trim();
    if (!title) {
      showToast('アルバムタイトルを入力してください');
      return;
    }
    if (!currentArtist) {
      showToast('アーティストが選択されていません');
      return;
    }
    const album = {
      id: editingAlbumId || newId('al'),
      artistId: currentArtist.id,
      title,
      coverImg: pendingAlbumImageBlob || (editingAlbumId ? currentAlbums.find(a => a.id === editingAlbumId)?.coverImg : null) || null,
      createdAt: editingAlbumId ? (currentAlbums.find(a => a.id === editingAlbumId)?.createdAt || Date.now()) : Date.now(),
    };
    try {
      await dbPut(STORE_ALBUMS, album);
      showToast(editingAlbumId ? '更新しました' : 'アルバムを追加しました');
      closeAlbumModal();
      modalPreviewUrls.revokeAll();
      await loadAlbumsForArtist(currentArtist.id);
    } catch (err) {
      console.error(err);
      showToast('保存に失敗しました');
    }
  });

  /* ===================== ③ アルバム詳細モーダル（楽曲カバーフロー） ===================== */
  async function openAlbumView(album) {
    currentAlbum = album;
    albumViewEyebrow.textContent = currentArtist ? currentArtist.name.toUpperCase() : 'ALBUM';
    albumViewTitle.textContent = album.title;
    await loadTracksForAlbum(album.id);
    albumViewOverlay.classList.add('is-open');
  }
  function closeAlbumView() {
    // フールプルーフ：アルバム詳細画面を閉じたら必ず再生を止める（仕様通り）。
    stopPlayback();
    albumViewOverlay.classList.remove('is-open');
    currentAlbum = null;
    currentTracks = [];
  }
  albumViewCloseBtn.addEventListener('click', closeAlbumView);

  albumDeleteBtn.addEventListener('click', () => {
    if (!currentAlbum) return;
    const album = currentAlbum;
    (async () => {
      const trs = await dbGetAllByIndex(STORE_TRACKS, 'albumId', album.id);
      const msg = trs.length > 0
        ? `アルバム「${album.title}」を削除します。収録曲${trs.length}曲もすべて削除され、復元できません。よろしいですか？`
        : `アルバム「${album.title}」を削除します。復元できません。よろしいですか？`;
      openConfirm(msg, async () => {
        for (const tr of trs) await dbDelete(STORE_TRACKS, tr.id);
        await dbDelete(STORE_ALBUMS, album.id);
        showToast('アルバムを削除しました');
        closeAlbumView();
        if (currentArtist) await loadAlbumsForArtist(currentArtist.id);
      });
    })();
  });

  async function loadTracksForAlbum(albumId) {
    currentTracks = await dbGetAllByIndex(STORE_TRACKS, 'albumId', albumId);
    currentTracks.sort((a, b) => a.order - b.order);
    renderTracks();
  }

  function renderTracks() {
    trackTrack.innerHTML = '';
    currentTracks.forEach((tr, i) => {
      const el = document.createElement('div');
      el.className = 'track-card' + (playingTrackId === tr.id ? ' is-playing' : '');
      const lyricsHtml = tr.lyrics
        ? `<div class="tp-block"><div class="tp-label">歌詞</div><div class="tp-text">${escapeHtml(tr.lyrics)}</div></div>` : '';
      const descHtml = tr.description
        ? `<div class="tp-block"><div class="tp-label">説明</div><div class="tp-text">${escapeHtml(tr.description)}</div></div>` : '';
      const popHtml = (lyricsHtml || descHtml)
        ? (lyricsHtml + descHtml)
        : '<div class="tp-empty">歌詞・説明の登録はありません</div>';
      el.innerHTML = `
        <button class="card-del-btn" title="削除">🗑</button>
        <div class="track-play-badge">${playingTrackId === tr.id ? '■' : '▶'}</div>
        <div class="track-pop">${popHtml}</div>
        <div class="track-title-plate">${i + 1}. ${escapeHtml(tr.title)}</div>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.card-del-btn')) return;
        togglePlayTrack(tr);
      });
      el.querySelector('.card-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openConfirm(`楽曲「${tr.title}」を削除します。復元できません。よろしいですか？`, async () => {
          if (playingTrackId === tr.id) stopPlayback();
          await dbDelete(STORE_TRACKS, tr.id);
          showToast('楽曲を削除しました');
          await loadTracksForAlbum(currentAlbum.id);
          if (currentArtist) await renderAlbums(); // Discography側のホバー収録曲リストにも反映
        });
      });
      trackTrack.appendChild(el);
    });
    // 末尾：＋楽曲を追加する
    const addEl = document.createElement('div');
    addEl.className = 'track-card add-card';
    addEl.innerHTML = `<div class="plus-icon">＋</div><div>楽曲を追加する</div>`;
    addEl.addEventListener('click', () => openTrackModal());
    trackTrack.appendChild(addEl);
  }

  /* ===================== 楽曲：追加モーダル ===================== */
  function resetTrackModal() {
    trackTitleInput.value = '';
    trackAudioUrlInput.value = '';
    trackLyricsInput.value = '';
    trackDescInput.value = '';
  }
  function openTrackModal() {
    resetTrackModal();
    trackModalOverlay.classList.add('is-open');
  }
  function closeTrackModal() {
    trackModalOverlay.classList.remove('is-open');
  }
  trackModalCloseBtn.addEventListener('click', closeTrackModal);
  trackModalCancelBtn.addEventListener('click', closeTrackModal);
  trackModalOverlay.addEventListener('click', (e) => { if (e.target === trackModalOverlay) closeTrackModal(); });

  trackModalSaveBtn.addEventListener('click', async () => {
    const title = trackTitleInput.value.trim();
    if (!title) {
      showToast('楽曲タイトルを入力してください');
      return;
    }
    const audioUrl = trackAudioUrlInput.value.trim();
    // フールプルーフ：明らかにURLでない入力（空白のみ・http(s)で始まらない等）を弾く。
    // 音源未登録（空欄）は許可し、後から編集で追加できる想定。
    if (audioUrl && !/^https?:\/\//i.test(audioUrl)) {
      showToast('音源URLは http:// または https:// から始めてください');
      return;
    }
    if (!currentAlbum) {
      showToast('アルバムが選択されていません');
      return;
    }
    const track = {
      id: newId('tr'),
      albumId: currentAlbum.id,
      title,
      audioType: 'url',
      audioUrl: audioUrl || null,
      lyrics: trackLyricsInput.value.trim(),
      description: trackDescInput.value.trim(),
      order: currentTracks.length,
      createdAt: Date.now(),
    };
    try {
      await dbPut(STORE_TRACKS, track);
      showToast('楽曲を追加しました');
      closeTrackModal();
      await loadTracksForAlbum(currentAlbum.id);
      if (currentArtist) await renderAlbums(); // Discography側のホバー収録曲リストにも反映
    } catch (err) {
      console.error(err);
      showToast('保存に失敗しました');
    }
  });

  /* ===================== ESC キーでの一括クローズ（フールプルーフ：閉じ忘れ防止） ===================== */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirmOverlay.classList.contains('is-open')) { closeConfirm(); return; }
    if (trackModalOverlay.classList.contains('is-open')) { closeTrackModal(); return; }
    if (albumModalOverlay.classList.contains('is-open')) { closeAlbumModal(); return; }
    if (artistModalOverlay.classList.contains('is-open')) { closeArtistModal(); return; }
    if (albumViewOverlay.classList.contains('is-open')) { closeAlbumView(); return; }
    if (artistViewOverlay.classList.contains('is-open')) { closeArtistView(); return; }
  });

  /* ===================== 初期化 ===================== */
  openDb().then(async (_db) => {
    db = _db;
    await loadArtists();
  }).catch((err) => {
    console.error('IndexedDBの初期化に失敗しました', err);
    artistTrack.innerHTML = '';
    document.querySelector('.app-body').innerHTML = `<div class="empty-state">
      保存機能を利用できません。<br>このブラウザ／モードではIndexedDBが利用できないため、登録内容は保存されません。<br>
      プライベートブラウジングモードなどをご確認ください。<br>
      （file://の直接オープンではなく、http://経由でお試しください）
    </div>`;
  });

  window.__discoticaInternal = {
    openDb, dbGetAll, dbGetAllByIndex, dbPut, dbDelete, newId,
    showToast, escapeHtml,
    loadArtists, playTrack, togglePlayTrack, stopPlayback, openConfirm,
  };
})();
