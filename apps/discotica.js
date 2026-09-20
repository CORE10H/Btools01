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
    if (artistCenterIndex >= artists.length + 1) artistCenterIndex = 0;
    buildArtistCoverflow();
  }

  function artistItemsWithAdd() {
    // 末尾に「＋アーティストを追加する」の空アイテムを常設。
    return [...artists, { empty: true, id: '__add__' }];
  }

  function buildArtistCoverflow() {
    artistListUrls.revokeAll();
    artistTrack.innerHTML = '';
    const items = artistItemsWithAdd();
    items.forEach((a, i) => {
      const el = document.createElement('div');
      el.className = 'artist-cf-item' + (a.empty ? ' empty' : '');
      if (a.empty) {
        el.textContent = '＋';
      } else {
        el.innerHTML = `<div class="artist-name-plate">${escapeHtml(a.name)}</div>`;
        if (a.coverImg) {
          el.style.backgroundImage = `linear-gradient(0deg, rgba(5,7,10,.85), rgba(5,7,10,0) 55%), url('${artistListUrls.make(a.coverImg)}')`;
        }
      }
      el.addEventListener('click', () => {
        if (i === artistCenterIndex) {
          if (a.empty) {
            openArtistModal();
          } else {
            openArtistView(a);
          }
          return;
        }
        artistCenterIndex = i;
        renderArtistCoverflow();
      });
      artistTrack.appendChild(el);
    });
    renderArtistCoverflow();
  }

  function renderArtistCoverflow() {
    const items = artistTrack.querySelectorAll('.artist-cf-item');
    const len = items.length;
    items.forEach((el, i) => {
      let offset = i - artistCenterIndex;
      const isCenter = offset === 0;
      const absOff = Math.abs(offset);
      const spacing = 130;
      const y = offset * spacing;
      const rotX = isCenter ? 0 : (offset > 0 ? 32 : -32);
      const z = isCenter ? 20 : -90 - (absOff - 1) * 30;
      const scale = isCenter ? 1 : Math.max(0.62, 0.62 - (absOff - 1) * 0.06);
      const opacity = absOff > 2 ? 0 : 1;
      el.style.transform = `translate(-50%, -50%) translateY(${y}px) translateZ(${z}px) rotateX(${rotX}deg) scale(${scale})`;
      el.style.zIndex = String(100 - absOff);
      el.style.opacity = String(opacity);
      el.classList.toggle('is-center', isCenter);
    });
  }

  artistPrevBtn.addEventListener('click', () => {
    const len = artistItemsWithAdd().length;
    artistCenterIndex = (artistCenterIndex - 1 + len) % len;
    renderArtistCoverflow();
  });
  artistNextBtn.addEventListener('click', () => {
    const len = artistItemsWithAdd().length;
    artistCenterIndex = (artistCenterIndex + 1) % len;
    renderArtistCoverflow();
  });
  document.querySelector('.artist-cf-wrap').addEventListener('wheel', (e) => {
    e.preventDefault();
    const len = artistItemsWithAdd().length;
    artistCenterIndex = (artistCenterIndex + (e.deltaY > 0 ? 1 : -1) + len) % len;
    renderArtistCoverflow();
  }, { passive: false });

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
