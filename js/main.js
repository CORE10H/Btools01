  function updateClock() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    const d = String(now.getDate()).padStart(2,'0');
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const ss = String(now.getSeconds()).padStart(2,'0');
    const weekdays = ['日','月','火','水','木','金','土'];
    const wd = weekdays[now.getDay()];
    document.getElementById('clockText').textContent = `${hh}:${mm}:${ss}`;
    const dateSubEl = document.getElementById('dateSub');
    if (dateSubEl) dateSubEl.textContent = `${y}年${m}月${d}日（${wd}）`;
  }
  updateClock();
  setInterval(updateClock, 1000);

  /* =====================================================================
     スマホ版レイアウト判定（2026-09-24 再構築）
     CSS側の @media (max-width: 479px) と「完全に同じ条件」を matchMedia で
     判定する。window.innerWidth での自前比較はスクロールバー幅等で
     CSSとズレる瞬間があり得るため使わない（CSSとJSの判定不一致防止）。
     値を変える場合は style.css 末尾のスマホ版ブロックも必ず同時に変えること。
     ===================================================================== */
  const MOBILE_LAYOUT_QUERY = '(max-width: 479px)';
  const mobileLayoutMql = window.matchMedia(MOBILE_LAYOUT_QUERY);
  function isMobileLayout() { return mobileLayoutMql.matches; }

  /* =====================================================================
     設定の永続化（sideops_settings）

     壁紙・透過率・選択中のテーマ・カスタムテーマの色・スポイトテーマの
     色をまとめてIndexedDBに保存し、リロード後も復元する（シーバさん
     指示：「設定メニュー内のものは全部まとめて『設定』としてひとまとめに
     永続化」。2026-09-22新設）。

     同じストア内を2レコードに分けて保持する（key: 'main' / key:
     'wallpaperUploads'）。壁紙アップロード画像（最大3枚×5MBのデータURL）
     は透過率等とまとめて1レコードにすると、透過率を1回変えるだけでも
     無関係な十数MBの画像データを毎回読み書きすることになってしまうため、
     軽量データと重いデータを分離した（シーバさん指摘により当初の
     1レコード案から変更）。既存のlauncher/log DBと同じ
     open→transaction のパターンに準拠。

     key: 'main'（軽量データ）に保存する項目：
       - panelAlpha: 透過率（数値）
       - wallpaperValue: 現在の壁紙のCSS値（'none' または url("...")）
       - themeKey: 選択中のテーマキー（'dark'/'light'/'vivid'/
         'contrast'/'custom'/'eyedropper'）
       - customThemeTokens: カスタムテーマの15色（保存済みならthemes.custom
         として復元）
       - eyedropperThemeTokens: スポイトで生成された15色（保存済みなら
         themes.eyedropperとして復元。壁紙が変わっても自動再生成は
         しない仕様＝保存時点の色をそのまま保持）

     key: 'wallpaperUploads'（重いデータ、専用レコード）：
       - uploads: アップロード壁紙の配列（最大3件、古い順に自動削除。
         1件5MBまで。他のインポート機能と同じ基準）
         [{ id, name, dataUrl, addedAt }]

     フールプルーフ：
       - 読み込み失敗時は例外を投げず、全項目デフォルト値のまま起動を
         続行する（設定復元の失敗でアプリ全体が止まらないように）
       - アップロード壁紙の件数・サイズ上限はここで一元管理する
     ===================================================================== */
  const SETTINGS_DB_NAME = 'sideops_settings';
  const SETTINGS_DB_VERSION = 1;
  const SETTINGS_STORE = 'settings';
  const SETTINGS_RECORD_KEY = 'main';               // 軽量データ（透過率・壁紙の選択値・テーマ・色）
  const SETTINGS_WALLPAPER_UPLOADS_KEY = 'wallpaperUploads'; // 壁紙アップロード画像（重い）専用の別レコード
  const WALLPAPER_UPLOAD_MAX_COUNT = 3;
  const WALLPAPER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5MB。他のインポート機能と同じ基準

  let settingsDb = null;

  function openSettingsDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(SETTINGS_DB_NAME, SETTINGS_DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const _db = ev.target.result;
        if (!_db.objectStoreNames.contains(SETTINGS_STORE)) {
          _db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function loadSettingsRecordByKey(key) {
    return new Promise((resolve, reject) => {
      const tx = settingsDb.transaction(SETTINGS_STORE, 'readonly');
      const req = tx.objectStore(SETTINGS_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  function loadSettingsRecord() {
    return loadSettingsRecordByKey(SETTINGS_RECORD_KEY);
  }

  // 部分更新：既存レコードにpatchの内容だけマージして保存する
  // （呼び出し側は変更したい項目だけ渡せばよく、他項目を誤って
  // 消してしまうリスクを避ける）。
  //
  // 【設計メモ・2026-09-22】壁紙アップロード画像（最大3枚×5MBの
  // データURL）は、この軽量レコード（key: 'main'）とは別レコード
  // （key: SETTINGS_WALLPAPER_UPLOADS_KEY）に分離して保存する。
  // IndexedDBのputはレコード単位の丸ごと上書きであり、1レコードに
  // まとめると透過率のような小さな値を1つ変えるだけでも毎回、
  // 無関係な十数MBの画像データを読み込んで書き戻すことになって
  // しまうため（シーバさん指摘により発覚・分離）。
  async function saveSettingsPatch(patch) {
    if (!settingsDb) return; // DB初期化前の呼び出しは無視（安全側）
    try {
      const current = (await loadSettingsRecord()) || { key: SETTINGS_RECORD_KEY };
      const merged = Object.assign({}, current, patch, { key: SETTINGS_RECORD_KEY });
      await new Promise((resolve, reject) => {
        const tx = settingsDb.transaction(SETTINGS_STORE, 'readwrite');
        const req = tx.objectStore(SETTINGS_STORE).put(merged);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.error('設定の保存に失敗しました', err);
    }
  }

  // 壁紙アップロード一覧だけを専用レコードとして丸ごと保存する
  // （呼び出し側は配列全体を渡す。件数が最大3件までに絞られているため
  // 全体保存でも実用上問題ない）。
  async function saveWallpaperUploads(uploads) {
    if (!settingsDb) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = settingsDb.transaction(SETTINGS_STORE, 'readwrite');
        const req = tx.objectStore(SETTINGS_STORE).put({ key: SETTINGS_WALLPAPER_UPLOADS_KEY, uploads });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.error('壁紙アップロードの保存に失敗しました', err);
    }
  }

  /* ===================== HEADER ICONS: FULLSCREEN / CLOUD (stub) / SETTINGS ===================== */
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  function updateFullscreenBtnState() {
    const isFs = !!document.fullscreenElement;
    fullscreenBtn.classList.toggle('is-active', isFs);
    fullscreenBtn.title = isFs
      ? '全画面表示を解除（このボタン、またはEscキー）'
      : '全画面表示（このボタン推奨。F11で入った場合、解除はEscキーのみ対応）';
  }
  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', updateFullscreenBtnState);
  updateFullscreenBtnState();

  // Cloud sync: not implemented yet — the button is present as a
  // placeholder for the eventual feature and stays disabled.

  const settingsOverlay = document.getElementById('settingsOverlay');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  function openSettings() { settingsOverlay.classList.add('is-open'); }
  function closeSettings() { settingsOverlay.classList.remove('is-open'); }
  settingsBtn.addEventListener('click', openSettings);
  settingsCloseBtn.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOverlay.classList.contains('is-open')) closeSettings();
  });

  /* ===================== PANEL TRANSPARENCY CONTROL ===================== */
  // Applies to panel backgrounds only (現況 / タスク / 通知 / ガント).
  // Cover flow banners and the main Stage are intentionally excluded.
  let panelAlpha = 100;
  const alphaValueEl = document.getElementById('alphaValue');

  function applyAlpha() {
    document.documentElement.style.setProperty('--panel-alpha', (panelAlpha / 100).toFixed(2));
    alphaValueEl.textContent = `${panelAlpha}%`;
  }

  document.getElementById('alphaUp').addEventListener('click', () => {
    panelAlpha = Math.min(100, panelAlpha + 10);
    applyAlpha();
    saveSettingsPatch({ panelAlpha });
  });
  document.getElementById('alphaDown').addEventListener('click', () => {
    panelAlpha = Math.max(0, panelAlpha - 10);
    applyAlpha();
    saveSettingsPatch({ panelAlpha });
  });

  /* ===================== WALLPAPER SYSTEM (presets + custom upload) ===================== */
  // Sets --wallpaper (a background-image value) on :root. 'none' means no
  // image at all — just the existing grid-line pattern. Presets are
  // self-contained inline SVG gradients so nothing external needs to load.
  function svgWallpaper(svgBody) {
    return `url("data:image/svg+xml,${encodeURIComponent(svgBody)}")`;
  }

  const wallpaperPresets = [
    { id: 'none', label: 'なし', swatchClass: 'wp-none', value: 'none' },
    {
      id: 'nebula',
      label: 'ネビュラ',
      swatchStyle: 'background:radial-gradient(circle at 30% 30%, #1a3a4a, #05070a 70%)',
      value: svgWallpaper(`<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><defs><radialGradient id='g' cx='30%' cy='30%' r='70%'><stop offset='0%' stop-color='#123a44'/><stop offset='45%' stop-color='#0a1a24'/><stop offset='100%' stop-color='#05070a'/></radialGradient></defs><rect width='800' height='600' fill='url(#g)'/></svg>`)
    },
    {
      id: 'aurora',
      label: 'オーロラ',
      swatchStyle: 'background:linear-gradient(160deg, #0a2a2a, #0a0a2a 60%, #05070a)',
      value: svgWallpaper(`<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#0d3a3a'/><stop offset='55%' stop-color='#0a0a2e'/><stop offset='100%' stop-color='#05070a'/></linearGradient></defs><rect width='800' height='600' fill='url(#g)'/></svg>`)
    },
    {
      id: 'magenta-haze',
      label: 'マゼンタ靄',
      swatchStyle: 'background:radial-gradient(circle at 70% 70%, #3a0f24, #05070a 70%)',
      value: svgWallpaper(`<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><defs><radialGradient id='g' cx='70%' cy='70%' r='75%'><stop offset='0%' stop-color='#3a1030'/><stop offset='50%' stop-color='#160a1a'/><stop offset='100%' stop-color='#05070a'/></radialGradient></defs><rect width='800' height='600' fill='url(#g)'/></svg>`)
    },
  ];

  const wallpaperSwatchesEl = document.getElementById('wallpaperSwatches');

  let currentWallpaperUrl = null; // the actual image URL behind --wallpaper, or null for 'none'
  const eyedropperBtn = document.getElementById('eyedropperBtn');

  // アップロード壁紙のメモリ上キャッシュ（DBの内容をそのまま反映）。
  // [{ id, name, dataUrl, addedAt }]。追加順（古い→新しい）で保持し、
  // WALLPAPER_UPLOAD_MAX_COUNT を超えたら先頭（最古）から削除する。
  let wallpaperUploads = [];

  function extractImageUrl(cssValue) {
    // cssValue is either 'none' or url("...")
    const m = /^url\("(.+)"\)$/.exec(cssValue);
    return m ? m[1] : null;
  }

  function applyWallpaper(value) {
    document.documentElement.style.setProperty('--wallpaper', value);
    currentWallpaperUrl = extractImageUrl(value);
    if (eyedropperBtn) eyedropperBtn.disabled = !currentWallpaperUrl;
  }

  function setActiveWallpaperSwatch(activeEl) {
    wallpaperSwatchesEl.querySelectorAll('.wallpaper-swatch').forEach(el => el.classList.remove('active'));
    if (activeEl) activeEl.classList.add('active');
  }

  function makeUploadWallpaperBtn(upload) {
    // uploadは { id, name, dataUrl, addedAt }。クリック時の値をこの
    // オブジェクト自身から読むクロージャにしておくことで、後から
    // 配列の並びが変わっても個々のボタンの動作は独立して壊れない。
    const thisWallpaperValue = `url("${upload.dataUrl}")`;
    const btn = document.createElement('button');
    btn.className = 'wallpaper-swatch';
    btn.title = upload.name;
    btn.style.backgroundImage = `url("${upload.dataUrl}")`;
    btn.addEventListener('click', () => {
      applyWallpaper(thisWallpaperValue);
      setActiveWallpaperSwatch(btn);
      saveSettingsPatch({ wallpaperValue: thisWallpaperValue });
    });
    return btn;
  }

  function buildWallpaperSwatches() {
    wallpaperSwatchesEl.innerHTML = '';
    wallpaperPresets.forEach(preset => {
      const btn = document.createElement('button');
      btn.className = 'wallpaper-swatch' + (preset.swatchClass ? ' ' + preset.swatchClass : '');
      btn.title = preset.label;
      if (preset.swatchStyle) btn.style.cssText = preset.swatchStyle;
      if (preset.id === 'none') btn.classList.add('active');
      btn.addEventListener('click', () => {
        applyWallpaper(preset.value);
        setActiveWallpaperSwatch(btn);
        saveSettingsPatch({ wallpaperValue: preset.value });
      });
      wallpaperSwatchesEl.appendChild(btn);
    });
    // 保存済みのアップロード壁紙があれば、プリセットの後ろに追加表示する
    wallpaperUploads.forEach(upload => {
      wallpaperSwatchesEl.appendChild(makeUploadWallpaperBtn(upload));
    });
  }
  buildWallpaperSwatches();

  // Custom upload: read the file as a data URL and add it as one more
  // selectable swatch (using the image itself as its thumbnail), so the
  // user can switch back to it later without re-uploading.
  const wallpaperFileInput = document.getElementById('wallpaperFileInput');
  document.getElementById('wallpaperUploadBtn').addEventListener('click', () => {
    wallpaperFileInput.click();
  });
  wallpaperFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // フールプルーフ：1枚あたりのサイズ上限（他のインポート機能と同じ基準）
    if (file.size > WALLPAPER_UPLOAD_MAX_BYTES) {
      showLauncherToast(`画像サイズが大きすぎます（上限${WALLPAPER_UPLOAD_MAX_BYTES / 1024 / 1024}MB）`);
      wallpaperFileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const upload = {
        id: 'wp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name: file.name,
        dataUrl: String(ev.target.result),
        addedAt: Date.now(),
      };
      wallpaperUploads.push(upload);
      // フールプルーフ：永続化する枚数の上限（3枚）。超えたら古いものから
      // 削除する（アップロード自体を拒否せず、操作を止めない方針）。
      while (wallpaperUploads.length > WALLPAPER_UPLOAD_MAX_COUNT) {
        wallpaperUploads.shift();
      }
      buildWallpaperSwatches();
      const thisWallpaperValue = `url("${upload.dataUrl}")`;
      applyWallpaper(thisWallpaperValue);
      // 追加したボタンは再構築後のDOMから探し直す（buildWallpaperSwatches
      // が毎回作り直すため、先に作った参照はもう使えない）
      const btns = wallpaperSwatchesEl.querySelectorAll('.wallpaper-swatch');
      setActiveWallpaperSwatch(btns[btns.length - 1]);
      saveWallpaperUploads(wallpaperUploads);      // 重いデータは専用レコードへ
      saveSettingsPatch({ wallpaperValue: thisWallpaperValue }); // 軽い方はmainレコードへ
    };
    reader.readAsDataURL(file);
    wallpaperFileInput.value = '';
  });

  /* ===================== THEME PRESET SYSTEM ===================== */
  // Each theme is a full set of design tokens. Swapping themes rewrites
  // these CSS custom properties on :root in one pass. This structure is
  // meant to make future user-defined/custom themes straightforward:
  // a user-authored theme is just another entry in this same shape.
  const themes = {
    dark: {
      label: 'ダーク（既定）',
      swatchBg: '#05070a', swatchAccent: '#00f0d0',
      tokens: {
        '--bg': '#05070a', '--bg-alt': '#070b10',
        '--panel-rgb': '14, 22, 32', '--panel-hi': '#121d29',
        '--line': '#1e3038', '--line-soft': '#14212a',
        '--cyan': '#00f0d0', '--cyan-dim': '#0a4a44',
        '--magenta': '#ff2f6e', '--magenta-dim': '#4a0f24',
        '--amber': '#ffb020',
        '--text': '#f5f9fa', '--text-dim': '#b8c4cc', '--text-faint': '#5c6b73',
        '--label-color': '#b8c4cc',
      }
    },
    light: {
      label: 'ライト',
      swatchBg: '#eef1f4', swatchAccent: '#0091a8',
      tokens: {
        '--bg': '#eef1f4', '--bg-alt': '#e2e7eb',
        '--panel-rgb': '255, 255, 255', '--panel-hi': '#ffffff',
        '--line': '#c7d0d6', '--line-soft': '#dbe2e7',
        '--cyan': '#0091a8', '--cyan-dim': '#bfe8ee',
        '--magenta': '#d81b60', '--magenta-dim': '#f6d0de',
        '--amber': '#b3720a',
        '--text': '#1a2226', '--text-dim': '#4a5a63', '--text-faint': '#8a99a1',
        '--label-color': '#4a5a63',
      }
    },
    vivid: {
      label: 'ビビッド',
      swatchBg: '#12071f', swatchAccent: '#ff3ec8',
      tokens: {
        '--bg': '#12071f', '--bg-alt': '#1a0a2b',
        '--panel-rgb': '30, 14, 46', '--panel-hi': '#26123a',
        '--line': '#4a2670', '--line-soft': '#301a4a',
        '--cyan': '#00e5ff', '--cyan-dim': '#0a5566',
        '--magenta': '#ff3ec8', '--magenta-dim': '#5c1046',
        '--amber': '#ffd400',
        '--text': '#fdf6ff', '--text-dim': '#d8c2ea', '--text-faint': '#8f6fae',
        '--label-color': '#d8c2ea',
      }
    },
    contrast: {
      label: '高コントラスト',
      swatchBg: '#000000', swatchAccent: '#ffff00',
      tokens: {
        '--bg': '#000000', '--bg-alt': '#0a0a0a',
        '--panel-rgb': '10, 10, 10', '--panel-hi': '#161616',
        '--line': '#444444', '--line-soft': '#2a2a2a',
        '--cyan': '#ffff00', '--cyan-dim': '#4a4a00',
        '--magenta': '#ff0040', '--magenta-dim': '#4a0018',
        '--amber': '#ff8800',
        '--text': '#ffffff', '--text-dim': '#e0e0e0', '--text-faint': '#a0a0a0',
        '--label-color': '#e0e0e0',
      }
    },
  };

  let currentTheme = 'dark';
  const root = document.documentElement;

  function applyTheme(key) {
    const theme = themes[key];
    if (!theme) return;
    Object.entries(theme.tokens).forEach(([prop, val]) => root.style.setProperty(prop, val));
    currentTheme = key;
    document.querySelectorAll('.theme-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.theme === key);
    });
    if (eyedropperBtn) eyedropperBtn.classList.toggle('active', key === 'eyedropper');
  }

  function buildThemeSwatches() {
    const wrap = document.getElementById('themeSwatches');
    wrap.innerHTML = ''; // 2回目以降の呼び出し（設定復元でeyedropper/customが
                          // 追加された後の再構築）でボタンが重複しないように
    Object.entries(themes).forEach(([key, theme]) => {
      // eyedropperは専用の入口ボタン（💧アイコン、theme-eyedropper-btn）
      // を別に持っているため、通常のスウォッチ一覧には並べない。
      // ここで除外しないと「スポイト」という名のスウォッチが一覧に
      // 紛れ込んで重複表示になる（シーバさん指摘・2026-09-22修正）。
      if (key === 'eyedropper') return;
      const btn = document.createElement('button');
      btn.className = 'theme-swatch' + (key === currentTheme ? ' active' : '');
      btn.dataset.theme = key;
      btn.title = theme.label;
      btn.style.setProperty('--_sw-bg', theme.swatchBg);
      btn.style.setProperty('--_sw-accent', theme.swatchAccent);
      btn.innerHTML = '<span class="ts-bg"></span><span class="ts-accent"></span>';
      btn.addEventListener('click', () => {
        applyTheme(key);
        saveSettingsPatch({ themeKey: key });
      });
      wrap.appendChild(btn);
    });
  }
  buildThemeSwatches();

  /* =====================================================================
     カスタムテーマ編集モーダル（15色それぞれを個別調整）

     シーバさん指示：
       - プリセット4種とスポイトの間に入口アイコンを新設
       - モーダルを開いた時の初期値は「現在選ばれているテーマの15色」
         （前回保存したカスタム値があればそれを優先）
       - 調整中はリアルタイムに画面全体へ反映
       - 保存すると、このアイコン＝themes.customとして以後再現できる
       - 保存以外の閉じ方（✕・Esc・背景クリック）はキャンセル扱いで、
         元々選ばれていたテーマの色に戻す
     ===================================================================== */
  const CUSTOM_THEME_TOKEN_LABELS = [
    ['--bg', '背景（基本）'],
    ['--bg-alt', '背景（サブ）'],
    ['--panel-rgb', 'パネル背景'],
    ['--panel-hi', 'パネル（明るめ）'],
    ['--line', '枠線'],
    ['--line-soft', '枠線（薄め）'],
    ['--cyan', 'アクセント1（シアン系）'],
    ['--cyan-dim', 'アクセント1（暗め）'],
    ['--magenta', 'アクセント2（マゼンタ系）'],
    ['--magenta-dim', 'アクセント2（暗め）'],
    ['--amber', 'アンバー'],
    ['--text', '文字（基本）'],
    ['--text-dim', '文字（やや薄め）'],
    ['--text-faint', '文字（薄め）'],
    ['--label-color', 'ラベル文字'],
  ];

  // --panel-rgb だけは他の14トークンと違い "R, G, B"（カンマ区切り数値）
  // 形式で、<input type="color"> が扱えるHEX形式ではない。この2関数で
  // 相互変換する（他14トークンは元々HEXなのでそのまま素通しでよい）。
  function rgbStringToHex(rgbStr) {
    const parts = String(rgbStr).split(',').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return '#000000';
    return '#' + parts.map(n => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0')).join('');
  }
  function hexToRgbString(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return '0, 0, 0';
    return [1, 2, 3].map(i => parseInt(m[i], 16)).join(', ');
  }
  function tokenToInputHex(tokenName, value) {
    return tokenName === '--panel-rgb' ? rgbStringToHex(value) : value;
  }
  function inputHexToTokenValue(tokenName, hex) {
    return tokenName === '--panel-rgb' ? hexToRgbString(hex) : hex;
  }

  const customThemeOverlay = document.getElementById('customThemeOverlay');
  const customThemeBtn = document.getElementById('customThemeBtn');
  const customThemeCloseBtn = document.getElementById('customThemeCloseBtn');
  const customThemeGrid = document.getElementById('customThemeGrid');
  const customThemeResetBtn = document.getElementById('customThemeResetBtn');
  const customThemeSaveBtn = document.getElementById('customThemeSaveBtn');

  let customThemeDraft = null;    // 編集中の15色（{ '--bg': '#...', ... }）
  let customThemeBaseline = null; // モーダルを開いた時点の値（「現在のテーマの色に戻す」用）
  let themeBeforeCustomEdit = null; // モーダルを開く直前に選ばれていたテーマキー（キャンセル時に戻す用）

  // 編集用バッファの色を画面へ即座に反映する。プリセットのactive表示は
  // 崩さない（applyThemeを使うとcurrentThemeが'custom'扱いになり、
  // まだ保存していないのにプリセット側のactive表示が消えてしまうため、
  // ここではCSS変数の直接書き換えのみ行う）。
  function applyCustomThemeDraftLive() {
    Object.entries(customThemeDraft).forEach(([prop, val]) => root.style.setProperty(prop, val));
  }

  function buildCustomThemeGrid() {
    customThemeGrid.innerHTML = '';
    CUSTOM_THEME_TOKEN_LABELS.forEach(([tokenName, label]) => {
      const row = document.createElement('div');
      row.className = 'custom-theme-row';

      const labelEl = document.createElement('label');
      labelEl.textContent = label;
      labelEl.title = tokenName;

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = tokenToInputHex(tokenName, customThemeDraft[tokenName]);

      const hexInput = document.createElement('input');
      hexInput.type = 'text';
      hexInput.className = 'cts-hex';
      hexInput.maxLength = 7;
      hexInput.value = tokenToInputHex(tokenName, customThemeDraft[tokenName]);

      function commit(hex) {
        customThemeDraft[tokenName] = inputHexToTokenValue(tokenName, hex);
        applyCustomThemeDraftLive();
      }

      colorInput.addEventListener('input', () => {
        hexInput.value = colorInput.value;
        commit(colorInput.value);
      });
      hexInput.addEventListener('input', () => {
        const v = hexInput.value.trim();
        // 不正な途中入力（"#f"など）ではまだ反映しない。有効なHEXに
        // なった時だけ確定させる（フールプルーフ：壊れた色をCSSに
        // 渡さない）。
        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
          colorInput.value = v;
          commit(v);
        }
      });

      row.appendChild(labelEl);
      row.appendChild(colorInput);
      row.appendChild(hexInput);
      customThemeGrid.appendChild(row);
    });
  }

  function openCustomThemeModal() {
    // カスタムテーマ編集モーダルは設定モーダルの中のボタンから開くため、
    // 両方が同時に重なって表示されないよう、設定モーダル側は閉じる。
    closeSettings();
    // 初期値：前回保存済みのカスタムテーマがあればそれ、なければ
    // 現在選ばれているテーマの15色をコピー（シーバさん合意済み仕様）。
    const source = themes.custom ? themes.custom.tokens : themes[currentTheme].tokens;
    customThemeDraft = Object.assign({}, source);
    customThemeBaseline = Object.assign({}, source);
    themeBeforeCustomEdit = currentTheme;
    buildCustomThemeGrid();
    customThemeOverlay.classList.add('is-open');
  }

  function closeCustomThemeModalCancelled() {
    // 保存以外の閉じ方は全てキャンセル扱い：元々選ばれていたテーマの
    // 色に戻す（シーバさん合意済み仕様）。
    customThemeOverlay.classList.remove('is-open');
    if (themeBeforeCustomEdit) applyTheme(themeBeforeCustomEdit);
    customThemeDraft = null;
    customThemeBaseline = null;
    themeBeforeCustomEdit = null;
  }

  customThemeBtn.addEventListener('click', openCustomThemeModal);
  customThemeCloseBtn.addEventListener('click', closeCustomThemeModalCancelled);
  customThemeOverlay.addEventListener('click', (e) => {
    if (e.target === customThemeOverlay) closeCustomThemeModalCancelled();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && customThemeOverlay.classList.contains('is-open')) {
      closeCustomThemeModalCancelled();
    }
  });

  customThemeResetBtn.addEventListener('click', () => {
    // 「現在のテーマの色に戻す」：保存はせず、モーダルを開いた時点の
    // 値（baseline）に編集用バッファを戻すだけ。
    customThemeDraft = Object.assign({}, customThemeBaseline);
    buildCustomThemeGrid();
    applyCustomThemeDraftLive();
  });

  customThemeSaveBtn.addEventListener('click', () => {
    const tokens = Object.assign({}, customThemeDraft);
    themes.custom = {
      label: 'カスタム',
      swatchBg: tokens['--bg'] || '#05070a',
      swatchAccent: tokens['--cyan'] || '#00f0d0',
      tokens,
    };
    buildThemeSwatches(); // themes.customをプリセット一覧にも反映
    applyTheme('custom');
    saveSettingsPatch({ themeKey: 'custom', customThemeTokens: tokens });
    customThemeOverlay.classList.remove('is-open');
    customThemeDraft = null;
    customThemeBaseline = null;
    themeBeforeCustomEdit = null;
  });


  /* ===================== EYEDROPPER THEME (generated from wallpaper) ===================== */
  // Samples the current wallpaper image on a hidden canvas, picks a dark
  // dominant color for backgrounds and a couple of vivid colors for
  // accents, then nudges everything for readable contrast before writing
  // it into `themes.eyedropper` and applying it like any other theme.

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return [h * 360, s * 100, l * 100];
  }

  function hslToHex(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function rgbToHex(r, g, b) {
    const toHex = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function buildEyedropperTheme(imageUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const size = 64; // downsample — we only need a color summary, not detail
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;

          let rSum = 0, gSum = 0, bSum = 0, count = 0;
          let bestVivid = null, bestVividScore = -1;
          let bestVivid2 = null, bestVivid2Score = -1;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            rSum += r; gSum += g; bSum += b; count++;
            const [h, s, l] = rgbToHsl(r, g, b);
            // score = how useful this pixel is as an accent: saturated, not too dark/bright
            const score = s * (1 - Math.abs(l - 55) / 55);
            if (score > bestVividScore) {
              bestVivid2Score = bestVividScore; bestVivid2 = bestVivid;
              bestVividScore = score; bestVivid = { r, g, b, h, s, l };
            } else if (score > bestVivid2Score && (!bestVivid || Math.abs(h - bestVivid.h) > 40)) {
              bestVivid2Score = score; bestVivid2 = { r, g, b, h, s, l };
            }
          }

          const avgR = rSum / count, avgG = gSum / count, avgB = bSum / count;
          const [, , avgL] = rgbToHsl(avgR, avgG, avgB);

          // Background: dominant hue, forced dark for readability regardless
          // of how bright the source image is.
          const [bgH, bgS] = rgbToHsl(avgR, avgG, avgB);
          const bg = hslToHex(bgH, Math.min(bgS, 35), 5);
          const bgAlt = hslToHex(bgH, Math.min(bgS, 35), 7);
          const panelHi = hslToHex(bgH, Math.min(bgS, 30), 11);
          const line = hslToHex(bgH, Math.min(bgS, 25), 20);
          const lineSoft = hslToHex(bgH, Math.min(bgS, 25), 13);

          // Accents: the two most vivid, distinct hues found, pulled to a
          // consistent brightness/saturation so they stay legible.
          const accent1 = bestVivid ? hslToHex(bestVivid.h, Math.max(bestVivid.s, 60), 55) : '#00f0d0';
          const accent2 = bestVivid2 ? hslToHex(bestVivid2.h, Math.max(bestVivid2.s, 60), 55) : '#ff2f6e';
          const accent1Dim = bestVivid ? hslToHex(bestVivid.h, Math.max(bestVivid.s, 50), 18) : '#0a4a44';
          const accent2Dim = bestVivid2 ? hslToHex(bestVivid2.h, Math.max(bestVivid2.s, 50), 18) : '#4a0f24';
          const amber = hslToHex((bestVivid ? bestVivid.h : 40) + 25, 70, 55);

          const panelRgbMatch = /^#(\w\w)(\w\w)(\w\w)$/.exec(bg);
          const panelRgb = panelRgbMatch
            ? `${parseInt(panelRgbMatch[1],16)}, ${parseInt(panelRgbMatch[2],16)}, ${parseInt(panelRgbMatch[3],16)}`
            : '14, 22, 32';

          themes.eyedropper = {
            label: 'スポイト（壁紙から生成）',
            swatchBg: bg, swatchAccent: accent1,
            tokens: {
              '--bg': bg, '--bg-alt': bgAlt,
              '--panel-rgb': panelRgb, '--panel-hi': panelHi,
              '--line': line, '--line-soft': lineSoft,
              '--cyan': accent1, '--cyan-dim': accent1Dim,
              '--magenta': accent2, '--magenta-dim': accent2Dim,
              '--amber': amber,
              '--text': '#f5f9fa', '--text-dim': '#c4ccd1', '--text-faint': '#7c8890',
              '--label-color': '#c4ccd1',
            }
          };
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = reject;
      img.src = imageUrl;
    });
  }

  if (eyedropperBtn) {
    eyedropperBtn.addEventListener('click', async () => {
      if (!currentWallpaperUrl || eyedropperBtn.disabled) return;
      eyedropperBtn.disabled = true;
      try {
        await buildEyedropperTheme(currentWallpaperUrl);
        applyTheme('eyedropper');
        // シーバさん指示：スポイトで生成した色も保存し、リロード後も
        // 自動再適用する（壁紙が変わっても自動再生成はせず、保存時点の
        // 色をそのまま保持する仕様）。
        saveSettingsPatch({
          themeKey: 'eyedropper',
          eyedropperThemeTokens: themes.eyedropper.tokens,
        });
      } catch (err) {
        console.error('スポイトテーマの生成に失敗しました', err);
      } finally {
        eyedropperBtn.disabled = !currentWallpaperUrl;
      }
    });
  }

  document.querySelectorAll('.task .check').forEach(chk => {
    chk.addEventListener('click', () => chk.closest('.task').classList.toggle('done'));
  });
  document.querySelectorAll('.task-filter button').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  /* ===================== VERTICAL COVER FLOW LOGIC =====================
     旧方式（固定配列のハードコード）はここに保険として残す。
     新方式が安定稼働したら、この丸ごとのコメントブロックごと削除してよい。

  const projects = [
    { cat: 'ツール', name: '画像生成プロンプト見本', src: 'apps/prompt-gallery.html', img: 'apps/img/prompt-gallery.jpg' },
    { cat: 'ツール ・ 統合予定', name: 'manuscript', src: 'apps/manuscript.html', img: 'apps/img/manuscript.jpg' },
    { cat: 'ツール ・ 統合予定', name: 'scaffold', src: 'apps/scaffold.html' },
    { cat: 'ツール', name: 'メモ', src: 'apps/memo.html', img: 'apps/img/memo.jpg' },
    { cat: '(仮) 音楽', name: 'Discotica', src: 'apps/discotica.html', img: 'apps/img/discotica.jpg' },
    { cat: '(仮)', name: '未定', src: 'apps/blank.html' },
    { cat: '', name: '＋ 追加', empty: true },
  ];

  const track = document.getElementById('cfTrack');
  let centerIndex = 0;

  function buildCoverflow() {
    track.innerHTML = '';
    projects.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'cf-item' + (p.empty ? ' empty' : '');
      el.dataset.index = i;
      if (p.empty) {
        el.textContent = '＋';
      } else {
        el.innerHTML = `<div class="p-cat">${p.cat}</div><div class="p-name">${p.name}</div>`;
        if (p.img) {
          el.style.backgroundImage = `linear-gradient(180deg, rgba(5,7,10,0) 40%, rgba(5,7,10,.9) 100%), url('${p.img}')`;
          el.style.backgroundSize = 'cover';
          el.style.backgroundPosition = 'center';
        }
      }
      el.addEventListener('click', (ev) => {
        if (i === centerIndex) {
          openStage(ev, projects[i]);
          return;
        }
        centerIndex = i;
        render();
      });
      track.appendChild(el);
    });
    render();
  }
  ===================== 旧方式ここまで ===================== */

  /* =====================================================================
     カバーフロー・ランチャー（新方式）

     3つの独立レイヤーでデータを持つ（詳細は制作資料 参照）：
       ① cards ストア … カバーフローの表示（カテゴリ・アプリの名称・
          カバー画像・並び順・どのapp（appId）を開くか）
       ② apps  ストア … アプリ本体の実体（type: 'builtin' は既存のapps/
          配下htmlへのパス参照。type: 'imported' は将来対応、本文＝文字列で保持）
       ③ 各アプリ専用のIndexedDB（sideops_memo等）… 今回は無関係・無改修

     誤作動防止の要：カード削除は①のみを消す。②（アプリ本体）や③（アプリの
     データ）は絶対に連動して消さない。②の削除は将来の「アプリ管理」画面
     （今回のスコープ外）でのみ行う設計とする。

     初期状態：マイグレーションは行わない（ユーザーの希望により、既存の
     6アプリも含めすべて「＋新規作成」から手動で登録し直す運用）。
  ===================================================================== */
  const LAUNCHER_DB_NAME = 'sideops_launcher';
  const LAUNCHER_DB_VERSION = 1;
  const CARDS_STORE = 'cards';
  const APPS_STORE = 'apps';
  let launcherDb = null;

  function openLauncherDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LAUNCHER_DB_NAME, LAUNCHER_DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const _db = ev.target.result;
        if (!_db.objectStoreNames.contains(CARDS_STORE)) {
          const store = _db.createObjectStore(CARDS_STORE, { keyPath: 'id' });
          store.createIndex('order', 'order', { unique: false });
        }
        if (!_db.objectStoreNames.contains(APPS_STORE)) {
          _db.createObjectStore(APPS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function launcherStore(name, mode) {
    const tx = launcherDb.transaction(name, mode);
    return tx.objectStore(name);
  }
  function launcherGetAll(name) {
    return new Promise((resolve, reject) => {
      const req = launcherStore(name, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function launcherGet(name, id) {
    return new Promise((resolve, reject) => {
      const req = launcherStore(name, 'readonly').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  function launcherPut(name, value) {
    return new Promise((resolve, reject) => {
      const req = launcherStore(name, 'readwrite').put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function launcherDelete(name, id) {
    return new Promise((resolve, reject) => {
      const req = launcherStore(name, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // builtin（apps/配下に元から存在する、先天的なhtml）の選択肢一覧。
  // 「＋新規作成」モーダルの種類選択プルダウンに、このリストがそのまま表示される。
  // coverImg：選択時にカバー画像欄へ自動読み込みするデフォルト画像のパス
  // （未設定の場合は自動読み込みされず、従来通りユーザーが任意で選択する）。
  const BUILTIN_APP_CHOICES = [
    { name: 'PROMPTGALLERY', src: 'apps/prompt-gallery.html', coverImg: 'apps/img/prompt-gallery.jpg' },
    { name: 'manuscript', src: 'apps/manuscript.html', coverImg: 'apps/img/manuscript.jpg' },
    { name: 'scaffold', src: 'apps/scaffold.html' },
    { name: 'メモ', src: 'apps/memo.html', coverImg: 'apps/img/memo.jpg' },
    { name: 'Discotica', src: 'apps/discotica.html', coverImg: 'apps/img/discotica.jpg' },
    { name: '未定（blank）', src: 'apps/blank.html' },
  ];

  // インポート（後天的アプリ）関連の定数
  const IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5MB。フールプルーフ：巨大htmlの誤選択による動作重量化を防止
  const IMPORT_ALLOWED_EXT = /\.(html|htm)$/i;
  // プルダウンの特別値。builtinのインデックス（0,1,2...）と衝突しない専用文字列にしてある
  const IMPORT_OPTION_VALUE = '__import__';

  let cards = [];   // メモリ上キャッシュ（cardsストアの内容）
  let apps = [];    // メモリ上キャッシュ（appsストアの内容）
  let cardImageUrls = new Map(); // cardId -> ObjectURL（描画のたびに作り直す）

  function revokeCardImageUrls() {
    cardImageUrls.forEach(u => URL.revokeObjectURL(u));
    cardImageUrls.clear();
  }

  function findAppForCard(card) {
    return apps.find(a => a.id === card.appId) || null;
  }

  const track = document.getElementById('cfTrack');
  let centerIndex = 0;

  async function loadLauncherData() {
    cards = await launcherGetAll(CARDS_STORE);
    cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    apps = await launcherGetAll(APPS_STORE);
  }

  function buildCoverflow() {
    revokeCardImageUrls();
    track.innerHTML = '';

    // 表示上のアイテム = 実カード群 ＋ 末尾の「＋新規作成」固定カード
    const displayItems = cards.map(c => ({ kind: 'card', card: c }));
    displayItems.push({ kind: 'add' });

    displayItems.forEach((item, i) => {
      const el = document.createElement('div');
      el.dataset.index = i;

      if (item.kind === 'add') {
        el.className = 'cf-item empty';
        el.textContent = '＋';
        el.addEventListener('click', (ev) => {
          if (i === centerIndex) {
            openLauncherAddModal();
            return;
          }
          centerIndex = i;
          render();
        });
      } else {
        const card = item.card;
        const app = findAppForCard(card);
        const displayName = card.overlayText && card.overlayText.trim()
          ? card.overlayText.trim()
          : (app ? app.name : '（本体未設定）');

        el.className = 'cf-item';
        el.innerHTML = `
          <div class="p-cat">${escapeHtmlLauncher(card.cat || '')}</div>
          <div class="p-name">${escapeHtmlLauncher(displayName)}</div>
          <button class="cf-item-delete-btn" type="button" title="カバーフローから削除">🗑</button>
        `;

        if (card.coverImage instanceof Blob) {
          const url = URL.createObjectURL(card.coverImage);
          cardImageUrls.set(card.id, url);
          el.style.backgroundImage = `linear-gradient(180deg, rgba(5,7,10,0) 40%, rgba(5,7,10,.9) 100%), url('${url}')`;
          el.style.backgroundSize = 'cover';
          el.style.backgroundPosition = 'center';
        }

        el.querySelector('.cf-item-delete-btn').addEventListener('click', (ev) => {
          ev.stopPropagation();
          openLauncherDeleteConfirm(card.id);
        });

        el.addEventListener('click', (ev) => {
          if (ev.target.closest('.cf-item-delete-btn')) return;
          if (i === centerIndex) {
            if (!app) {
              showLauncherToast('このカードに紐づくアプリ本体が見つかりません');
              return;
            }
            openStage(ev, { name: displayName, src: app.src, htmlContent: app.htmlContent, type: app.type, empty: false }, card.id);
            return;
          }
          centerIndex = i;
          render();
        });
      }

      track.appendChild(el);
    });

    if (centerIndex > displayItems.length - 1) centerIndex = displayItems.length - 1;
    render();
  }

  function escapeHtmlLauncher(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function showLauncherToast(msg) {
    const el = document.getElementById('launcherToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showLauncherToast._t);
    showLauncherToast._t = setTimeout(() => el.classList.remove('show'), 2000);
  }

  /* ---- ＋新規作成モーダル ---- */
  const launcherAddOverlay = document.getElementById('launcherAddOverlay');
  const launcherAppPicker = document.getElementById('launcherAppPicker');
  const launcherImportZone = document.getElementById('launcherImportZone');
  const launcherImportDrop = document.getElementById('launcherImportDrop');
  const launcherImportDropText = document.getElementById('launcherImportDropText');
  const launcherImportInput = document.getElementById('launcherImportInput');
  const launcherImportNameInput = document.getElementById('launcherImportNameInput');
  const launcherCatInput = document.getElementById('launcherCatInput');
  const launcherCoverDrop = document.getElementById('launcherCoverDrop');
  const launcherCoverInput = document.getElementById('launcherCoverInput');
  const launcherOverlayInput = document.getElementById('launcherOverlayInput');
  const launcherAddCloseBtn = document.getElementById('launcherAddCloseBtn');
  const launcherAddCancelBtn = document.getElementById('launcherAddCancelBtn');
  const launcherAddSaveBtn = document.getElementById('launcherAddSaveBtn');

  let selectedBuiltinIndex = null;   // プルダウンでbuiltinを選んだ場合のインデックス
  let isImportMode = false;          // プルダウンで「インポート」を選んだかどうか
  let pendingCoverFile = null;
  let coverIsUserSelected = false;   // ユーザーが手動でカバー画像を選択したか
                                      // （true の間は、builtin選び直しによる自動画像で上書きしない）
  let overlayIsUserEdited = false;   // ユーザーが「アプリの名称」欄を手動編集したか
                                      // （true の間は、builtin選び直しによる自動入力で上書きしない。
                                      //   coverIsUserSelectedと同じ考え方。2026-09-22追加）
  let pendingImportFile = null;      // 選択されたhtmlファイル（File）
  let pendingImportContent = null;   // 読み込み済みのhtml文字列

  // ・種類プルダウン（先天的アプリ一覧＋末尾に「ローカルhtmlをインポート」）を生成
  function renderAppPicker() {
    launcherAppPicker.innerHTML = '<option value="" disabled>選択してください</option>';
    BUILTIN_APP_CHOICES.forEach((choice, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = choice.name;
      launcherAppPicker.appendChild(opt);
    });
    const importOpt = document.createElement('option');
    importOpt.value = IMPORT_OPTION_VALUE;
    importOpt.textContent = 'ローカルhtmlをインポート（後天的アプリ）';
    launcherAppPicker.appendChild(importOpt);
    launcherAppPicker.value = '';
  }

  launcherAppPicker.addEventListener('change', () => {
    const v = launcherAppPicker.value;
    if (v === IMPORT_OPTION_VALUE) {
      selectedBuiltinIndex = null;
      isImportMode = true;
      launcherImportZone.classList.add('is-visible');
      launcherImportNameInput.style.display = '';
    } else {
      selectedBuiltinIndex = Number(v);
      isImportMode = false;
      launcherImportZone.classList.remove('is-visible');
      launcherImportNameInput.style.display = 'none';
      // 先天的アプリを選んだ際、デフォルトのカバー画像があれば自動読み込みする。
      // ただしユーザーが既に手動で画像を選択済みの場合は上書きしない
      // （手動選択を優先。ユーザー合意済み仕様）。
      if (!coverIsUserSelected) {
        loadBuiltinCoverImage(BUILTIN_APP_CHOICES[selectedBuiltinIndex]);
      }
      // 「アプリの名称」欄も同様に、未入力（またはユーザーが未編集）の
      // 場合のみ先天的アプリの名前で自動的に埋める。カテゴリ表示は
      // 対応する初期値がBUILTIN_APP_CHOICESに存在しないため対象外
      // （シーバさん指示・2026-09-22）。
      if (!overlayIsUserEdited) {
        launcherOverlayInput.value = BUILTIN_APP_CHOICES[selectedBuiltinIndex].name;
      }
    }
  });

  // 「アプリの名称」欄にユーザー自身が何か入力したら、以降はbuiltin
  // 選び直しによる自動入力で上書きしない（coverIsUserSelectedと同じ
  // 考え方。JSによる自動代入はinputイベントを発火させないため、
  // ここでの検知は「ユーザーが実際にキーボード等で触れた場合」のみに
  // 正しく限定される）。
  launcherOverlayInput.addEventListener('input', () => {
    overlayIsUserEdited = true;
  });

  // builtinのデフォルトカバー画像（apps/img/配下）をfetchしてBlob化し、
  // 通常の「手動アップロードされた画像」と同じ扱いでプレビュー表示する。
  // coverImg未設定のbuiltin（scaffold・blank）では何もしない（画像欄は空のまま）。
  async function loadBuiltinCoverImage(choice) {
    if (!choice || !choice.coverImg) return;
    try {
      const res = await fetch(choice.coverImg);
      if (!res.ok) throw new Error('fetch failed: ' + res.status);
      const blob = await res.blob();
      pendingCoverFile = blob;
      const url = URL.createObjectURL(blob);
      launcherCoverDrop.classList.add('has-image');
      launcherCoverDrop.innerHTML = `<img src="${url}" alt="preview">`;
      bindCoverDropClick();
    } catch (err) {
      // 自動読み込みに失敗しても致命的ではない（ユーザーが手動で選べば良いため）、
      // トーストは出さず静かに諦める
      console.error('デフォルトカバー画像の読み込みに失敗しました', err);
    }
  }

  function bindImportDropClick() {
    launcherImportDrop.onclick = () => launcherImportInput.click();
  }
  launcherImportInput.addEventListener('change', handleImportFileSelect);

  function handleImportFileSelect(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    // フールプルーフ①：拡張子チェック（.html / .htm のみ許可）
    if (!IMPORT_ALLOWED_EXT.test(file.name)) {
      showLauncherToast('.html または .htm ファイルを選択してください');
      launcherImportInput.value = '';
      return;
    }
    // フールプルーフ②：サイズ上限（5MB）。巨大ファイルの誤選択による動作重量化を防止
    if (file.size > IMPORT_MAX_BYTES) {
      showLauncherToast('ファイルサイズが大きすぎます（上限5MB）');
      launcherImportInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      pendingImportFile = file;
      pendingImportContent = String(reader.result || '');
      launcherImportDrop.classList.add('has-file');
      launcherImportDropText.textContent = `選択中：${file.name}（${(file.size / 1024).toFixed(1)}KB）`;
      if (!launcherImportNameInput.value.trim()) {
        // 未入力の場合のみファイル名から自動補完（拡張子は除く）
        launcherImportNameInput.value = file.name.replace(IMPORT_ALLOWED_EXT, '');
      }
    };
    reader.onerror = () => {
      showLauncherToast('ファイルの読み込みに失敗しました');
      pendingImportFile = null;
      pendingImportContent = null;
    };
    reader.readAsText(file);
  }

  function bindCoverDropClick() {
    launcherCoverDrop.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
      inp.addEventListener('change', handleCoverSelect);
      document.body.appendChild(inp);
      inp.click();
      inp.addEventListener('change', () => setTimeout(() => inp.remove(), 0), { once: true });
    };
  }

  function handleCoverSelect(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // フールプルーフ：画像ファイル以外は受け付けない
    if (!file.type.startsWith('image/')) {
      showLauncherToast('画像ファイルを選択してください');
      return;
    }
    pendingCoverFile = file;
    coverIsUserSelected = true; // 以降、builtin選び直しによる自動上書きを止める
    const url = URL.createObjectURL(file);
    launcherCoverDrop.classList.add('has-image');
    launcherCoverDrop.innerHTML = `<img src="${url}" alt="preview">`;
    bindCoverDropClick();
  }

  function resetLauncherAddModal() {
    selectedBuiltinIndex = null;
    isImportMode = false;
    pendingCoverFile = null;
    coverIsUserSelected = false;
    overlayIsUserEdited = false;
    pendingImportFile = null;
    pendingImportContent = null;
    launcherCatInput.value = '';
    launcherOverlayInput.value = '';
    launcherImportNameInput.value = '';
    launcherImportNameInput.style.display = 'none';
    launcherImportZone.classList.remove('is-visible');
    launcherImportDrop.classList.remove('has-file');
    launcherImportDropText.textContent = 'クリックしてhtmlファイルを選択（.html / .htm、5MBまで）';
    launcherImportInput.value = '';
    launcherCoverDrop.classList.remove('has-image');
    launcherCoverDrop.innerHTML = '<span>クリックして画像を選択</span>';
    bindCoverDropClick();
    bindImportDropClick();
    renderAppPicker();
  }

  function openLauncherAddModal() {
    resetLauncherAddModal();
    launcherAddOverlay.classList.add('is-open');
  }
  function closeLauncherAddModal() {
    launcherAddOverlay.classList.remove('is-open');
  }
  launcherAddCloseBtn.addEventListener('click', closeLauncherAddModal);
  launcherAddCancelBtn.addEventListener('click', closeLauncherAddModal);
  launcherAddOverlay.addEventListener('click', (e) => { if (e.target === launcherAddOverlay) closeLauncherAddModal(); });

  launcherAddSaveBtn.addEventListener('click', async () => {
    // フールプルーフ：種類未選択のまま保存させない
    if (!isImportMode && selectedBuiltinIndex === null) {
      showLauncherToast('種類を選択してください');
      return;
    }
    // フールプルーフ：インポートモードでファイル未選択のまま保存させない
    if (isImportMode && !pendingImportContent) {
      showLauncherToast('インポートするhtmlファイルを選択してください');
      return;
    }

    const now = Date.now();

    try {
      // ② アプリ本体（apps ストア＝地図・目次の1件）を新規登録
      const appId = 'a_' + now + '_' + Math.random().toString(36).slice(2, 8);
      let appEntry;
      if (isImportMode) {
        const importedName = launcherImportNameInput.value.trim() || pendingImportFile.name.replace(IMPORT_ALLOWED_EXT, '');
        appEntry = {
          id: appId,
          name: importedName,
          type: 'imported',
          htmlContent: pendingImportContent,
          createdAt: now,
          updatedAt: now,
        };
      } else {
        const choice = BUILTIN_APP_CHOICES[selectedBuiltinIndex];
        appEntry = {
          id: appId,
          name: choice.name,
          type: 'builtin',
          src: choice.src,
          createdAt: now,
          updatedAt: now,
        };
      }
      await launcherPut(APPS_STORE, appEntry);

      // ① カードを新規登録
      const cardId = 'c_' + now + '_' + Math.random().toString(36).slice(2, 8);
      const maxOrder = cards.reduce((max, c) => Math.max(max, c.order ?? 0), -1);
      const cardEntry = {
        id: cardId,
        appId: appId,
        cat: launcherCatInput.value.trim(),
        overlayText: launcherOverlayInput.value.trim(),
        coverImage: pendingCoverFile || null,
        order: maxOrder + 1,
        createdAt: now,
        updatedAt: now,
      };
      await launcherPut(CARDS_STORE, cardEntry);

      await loadLauncherData();
      closeLauncherAddModal();
      showLauncherToast('カードを作成しました');
      buildCoverflow();
    } catch (err) {
      console.error('カード作成に失敗しました', err);
      showLauncherToast('作成に失敗しました');
    }
  });

  /* ---- カード削除確認（①のみ削除。②アプリ本体・③データは残す） ---- */
  const launcherDeleteOverlay = document.getElementById('launcherDeleteOverlay');
  const launcherDeleteCancelBtn = document.getElementById('launcherDeleteCancelBtn');
  const launcherDeleteConfirmBtn = document.getElementById('launcherDeleteConfirmBtn');
  let pendingDeleteCardId = null;

  function openLauncherDeleteConfirm(cardId) {
    pendingDeleteCardId = cardId;
    launcherDeleteOverlay.classList.add('is-open');
  }
  function closeLauncherDeleteConfirm() {
    pendingDeleteCardId = null;
    launcherDeleteOverlay.classList.remove('is-open');
  }
  launcherDeleteCancelBtn.addEventListener('click', closeLauncherDeleteConfirm);
  launcherDeleteOverlay.addEventListener('click', (e) => { if (e.target === launcherDeleteOverlay) closeLauncherDeleteConfirm(); });

  launcherDeleteConfirmBtn.addEventListener('click', async () => {
    if (!pendingDeleteCardId) return;
    try {
      // 誤作動防止：ここで削除するのは cards ストアのレコードのみ。
      // apps ストア（アプリ本体）・各アプリ専用DB（データ）には一切触れない。
      await launcherDelete(CARDS_STORE, pendingDeleteCardId);
      await loadLauncherData();
      showLauncherToast('カードを削除しました');
      closeLauncherDeleteConfirm();
      buildCoverflow();
    } catch (err) {
      console.error('カード削除に失敗しました', err);
      showLauncherToast('削除に失敗しました');
      closeLauncherDeleteConfirm();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (launcherDeleteOverlay.classList.contains('is-open')) closeLauncherDeleteConfirm();
    else if (launcherAddOverlay.classList.contains('is-open')) closeLauncherAddModal();
  });

  /* =====================================================================
     アプリ管理（段階③）：インポートした後天的アプリ（type: 'imported'）の
     本体削除機能。先天的アプリ（builtin）は一覧に出さず、削除もできない
     （builtinは apps/ 配下の実ファイル参照であり、SIDE-OPS本体機能として
     常に必要なため）。

     誤作動防止の要：
     ・削除対象は imported のみに限定（一覧生成時に type === 'imported' で
       フィルタ。誤ってbuiltinを削除できないようそもそもUIに出さない）
     ・アプリ本体を削除すると、紐づく cards レコードも連鎖削除される
       （ユーザー合意済みの仕様。旧来の「カード削除は①のみ」とは逆方向の
       操作であるため、削除確認ダイアログで参照カード件数と挙動を必ず明示）
     ・各アプリ専用のIndexedDB（sideops_memo等）は一切削除しない（データは
       温存。入口を失うだけで、同じhtmlを再インポートすれば理論上は再アクセス
       できるが、importedアプリは実体（htmlContent）そのものを保持しているため
       再インポートは実質「同じ内容の別アプリを作る」ことになる点に注意）
  ===================================================================== */
  const appManageOverlay = document.getElementById('appManageOverlay');
  const appManageList = document.getElementById('appManageList');
  const openAppManageBtn = document.getElementById('openAppManageBtn');
  const appManageCloseBtn = document.getElementById('appManageCloseBtn');
  const appManageCloseBtn2 = document.getElementById('appManageCloseBtn2');
  const appDeleteConfirmOverlay = document.getElementById('appDeleteConfirmOverlay');
  const appDeleteConfirmMsg = document.getElementById('appDeleteConfirmMsg');
  const appDeleteCancelBtn = document.getElementById('appDeleteCancelBtn');
  const appDeleteConfirmBtn = document.getElementById('appDeleteConfirmBtn');
  let pendingDeleteAppId = null;

  function countCardsForApp(appId) {
    return cards.filter(c => c.appId === appId).length;
  }

  function renderAppManageList() {
    const importedApps = apps.filter(a => a.type === 'imported');
    if (importedApps.length === 0) {
      appManageList.innerHTML = '<div class="app-manage-empty">インポートしたアプリはまだありません。</div>';
      return;
    }
    appManageList.innerHTML = '';
    importedApps.forEach(app => {
      const refCount = countCardsForApp(app.id);
      const row = document.createElement('div');
      row.className = 'app-manage-row';
      const dateStr = app.createdAt ? new Date(app.createdAt).toLocaleDateString('ja-JP') : '--';
      row.innerHTML = `
        <div class="app-manage-info">
          <div class="app-manage-name">${escapeHtmlLauncher(app.name)}</div>
          <div class="app-manage-meta${refCount > 0 ? ' has-refs' : ''}">
            登録日: ${dateStr}　参照カード: ${refCount}件${refCount > 0 ? '（削除するとカードも消えます）' : ''}
          </div>
        </div>
        <button class="app-manage-delete-btn" type="button" data-app-id="${app.id}">削除</button>
      `;
      row.querySelector('.app-manage-delete-btn').addEventListener('click', () => {
        openAppDeleteConfirm(app.id);
      });
      appManageList.appendChild(row);
    });
  }

  function openAppManage() {
    renderAppManageList();
    appManageOverlay.classList.add('is-open');
  }
  function closeAppManage() {
    appManageOverlay.classList.remove('is-open');
  }
  openAppManageBtn.addEventListener('click', () => {
    closeSettings();
    openAppManage();
  });
  appManageCloseBtn.addEventListener('click', closeAppManage);
  appManageCloseBtn2.addEventListener('click', closeAppManage);
  appManageOverlay.addEventListener('click', (e) => { if (e.target === appManageOverlay) closeAppManage(); });

  function openAppDeleteConfirm(appId) {
    const app = apps.find(a => a.id === appId);
    if (!app) return;
    pendingDeleteAppId = appId;
    const refCount = countCardsForApp(appId);
    if (refCount > 0) {
      // フールプルーフ：参照カードがある場合は、連鎖削除の影響を明示した強い警告文にする
      appDeleteConfirmMsg.innerHTML =
        `「${escapeHtmlLauncher(app.name)}」を削除します。<br><br>` +
        `<strong style="color:var(--magenta);">このアプリはカバーフローに${refCount}件のカードとして登録されています。` +
        `アプリ本体を削除すると、それらのカードも同時に削除されます。</strong><br><br>` +
        `※アプリが保存していたデータ自体（メモの内容など）は削除されません。この操作は取り消せません。よろしいですか？`;
    } else {
      appDeleteConfirmMsg.innerHTML =
        `「${escapeHtmlLauncher(app.name)}」を削除します。<br><br>` +
        `このアプリを参照しているカードはありません。この操作は取り消せません。よろしいですか？`;
    }
    appDeleteConfirmOverlay.classList.add('is-open');
  }
  function closeAppDeleteConfirm() {
    pendingDeleteAppId = null;
    appDeleteConfirmOverlay.classList.remove('is-open');
  }
  appDeleteCancelBtn.addEventListener('click', closeAppDeleteConfirm);
  appDeleteConfirmOverlay.addEventListener('click', (e) => { if (e.target === appDeleteConfirmOverlay) closeAppDeleteConfirm(); });

  appDeleteConfirmBtn.addEventListener('click', async () => {
    if (!pendingDeleteAppId) return;
    const appId = pendingDeleteAppId;
    try {
      // 連鎖削除：このappIdを参照している cards レコードを全て先に削除
      const affectedCards = cards.filter(c => c.appId === appId);
      for (const c of affectedCards) {
        await launcherDelete(CARDS_STORE, c.id);
      }
      // ② アプリ本体を削除（③各アプリ専用DBのデータには一切触れない）
      await launcherDelete(APPS_STORE, appId);

      await loadLauncherData();
      closeAppDeleteConfirm();
      showLauncherToast(affectedCards.length > 0
        ? `アプリと紐づくカード${affectedCards.length}件を削除しました`
        : 'アプリを削除しました');
      renderAppManageList();
      buildCoverflow();
    } catch (err) {
      console.error('アプリ本体の削除に失敗しました', err);
      showLauncherToast('削除に失敗しました');
      closeAppDeleteConfirm();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (appDeleteConfirmOverlay.classList.contains('is-open')) closeAppDeleteConfirm();
    else if (appManageOverlay.classList.contains('is-open')) closeAppManage();
  });

  function shortestOffset(i, center, len) {
    let raw = i - center;
    if (raw > len / 2) raw -= len;
    if (raw < -len / 2) raw += len;
    return raw;
  }

  /* ===================== STAGE EXPAND/COLLAPSE ===================== */
  // The stage is a reserved black surface, empty by default. Clicking the
  // already-centered cover flow banner expands its content into the stage,
  // scaling in from the banner's actual click position (ev.clientX/Y are
  // real pointer coordinates and remain correct even though the banner
  // itself sits inside a 3D-tilted, rotated container).
  const stageEl = document.getElementById('stageEl');
  const stageContent = document.getElementById('stageContent');
  const stageBody = document.getElementById('stageBody');
  const stagePlaceholder = document.getElementById('stagePlaceholder');
  const stageSizeVerticalBtn = document.getElementById('stageSizeVerticalBtn');
  const stageSizeFullBtn = document.getElementById('stageSizeFullBtn');
  let stageFrame = null; // 現在表示中のiframe（開いていなければnull）
  let currentStageCardId = null; // 開いているStageがどのカードのものか（サイズモード保存用）

  // 表示モードは3状態のうちどれか1つ（ラジオボタン的な排他選択）：
  //   'normal'   … 元のGrid枠と同じ左右位置・上下位置
  //   'vertical' … 上端〜下端いっぱい。左右幅は通常時のStage枠のまま
  //                （カバーフロー・右カラムは隠さない）。left/widthは
  //                ウィンドウサイズで変わるためJSで動的計算する
  //                （6.3節の教訓：固定ピクセル値を使わない）
  //   'full'     … 四方いっぱい（完全フルスクリーン）
  function computeNormalStageRect() {
    // 通常時のStage位置を、実在する隣接パネル（header / .left-col / .right-col /
    // .timeline-panel）の getBoundingClientRect() から動的に算出する。CSS側でその
    // 値を直接再現するのが難しいため（rotateYが掛かった祖先を挟むレイアウトの
    // ため）、JS側で隣接パネルの実際の画面上の端を基準点として使う
    // （6.3節の教訓：固定ピクセル値を使わず、実測のrectを基準にする）。
    const header = document.querySelector('header.top');
    const leftCol = document.querySelector('.left-col');
    const rightCol = document.querySelector('.right-col');
    const timelineEl = document.querySelector('.timeline-panel');
    const headerRect = header.getBoundingClientRect();
    const leftRect = leftCol.getBoundingClientRect();
    const rightRect = rightCol.getBoundingClientRect();
    const timelineRect = timelineEl.getBoundingClientRect();
    return {
      left: leftRect.right + 14, // .shell の gap 分
      right: window.innerWidth - rightRect.left + 14,
      top: headerRect.bottom + 14,
      bottom: window.innerHeight - timelineRect.top + 14,
    };
  }

  function applyStageSizeMode(mode) {
    // スマホ幅では、カードに保存された表示モードに関わらず常に四方いっぱい。
    // ただし保存値（sizeMode）とボタンの選択状態は元のまま残すので、
    // PC幅に戻った瞬間に本来のモードへ自然に復帰する。
    // （隠れた4パネルの位置から通常/縦モードの座標を計算させないための歯止め）
    const effectiveMode = isMobileLayout() ? 'full' : mode;
    stageEl.classList.remove('stage-mode-full');
    if (effectiveMode === 'full') {
      stageEl.classList.add('stage-mode-full');
      stageEl.style.top = '';
      stageEl.style.bottom = '';
      stageEl.style.left = '';
      stageEl.style.right = '';
      stageEl.style.width = '';
    } else if (effectiveMode === 'vertical') {
      const normalRect = computeNormalStageRect();
      stageEl.style.top = '0px';
      stageEl.style.bottom = '0px';
      stageEl.style.left = normalRect.left + 'px';
      stageEl.style.right = normalRect.right + 'px';
      stageEl.style.width = '';
    } else {
      // normal
      const normalRect = computeNormalStageRect();
      stageEl.style.top = normalRect.top + 'px';
      stageEl.style.bottom = normalRect.bottom + 'px';
      stageEl.style.left = normalRect.left + 'px';
      stageEl.style.right = normalRect.right + 'px';
      stageEl.style.width = '';
    }
    stageSizeVerticalBtn.classList.toggle('is-active', mode === 'vertical');
    stageSizeFullBtn.classList.toggle('is-active', mode === 'full');
  }

  async function setStageSizeMode(mode) {
    applyStageSizeMode(mode);
    // カードごとに永続化。「＋新規作成」等、カードに紐づかないStage表示は対象外
    if (!currentStageCardId) return;
    const card = cards.find(c => c.id === currentStageCardId);
    if (!card) return;
    card.sizeMode = mode;
    try {
      await launcherPut(CARDS_STORE, card);
    } catch (err) {
      console.error('表示モードの保存に失敗しました', err);
    }
  }

  stageSizeVerticalBtn.addEventListener('click', () => {
    const next = stageSizeVerticalBtn.classList.contains('is-active') ? 'normal' : 'vertical';
    setStageSizeMode(next);
  });
  stageSizeFullBtn.addEventListener('click', () => {
    const next = stageSizeFullBtn.classList.contains('is-active') ? 'normal' : 'full';
    setStageSizeMode(next);
  });
  // ウィンドウサイズが変わっても vertical/normal モードの左右位置が追従するように
  window.addEventListener('resize', () => {
    if (!stageEl.classList.contains('is-open')) return;
    const activeMode = stageSizeFullBtn.classList.contains('is-active') ? 'full'
      : (stageSizeVerticalBtn.classList.contains('is-active') ? 'vertical' : 'normal');
    applyStageSizeMode(activeMode);
  });

  function openStage(ev, project, cardId) {
    currentStageCardId = cardId || null;
    const card = cardId ? cards.find(c => c.id === cardId) : null;
    const mode = (card && card.sizeMode) || 'normal';
    applyStageSizeMode(mode);

    const stageRect = stageEl.getBoundingClientRect();
    const originX = ((ev.clientX - stageRect.left) / stageRect.width) * 100 + '%';
    const originY = ((ev.clientY - stageRect.top) / stageRect.height) * 100 + '%';
    stageContent.style.setProperty('--origin-x', originX);
    stageContent.style.setProperty('--origin-y', originY);

    if (project && !project.empty && (project.src || project.htmlContent)) {
      document.getElementById('stageTag').textContent = project.name;
      // 「＋追加」以外のアプリカードは、Stage内にiframeでダミー/実アプリを読み込む。
      // 既存のiframeがあれば一旦除去してから作り直す（同じアプリの再クリックも含め、
      // 毎回リロードして状態をリセットする挙動にしている）。
      if (stageFrame) stageFrame.remove();
      stagePlaceholder.style.display = 'none';
      stageFrame = document.createElement('iframe');
      stageFrame.className = 'stage-frame';
      if (project.type === 'imported') {
        // インポートされたhtmlは実ファイルパスを持たないため、srcdocで直接描画する
        stageFrame.srcdoc = project.htmlContent;
      } else {
        stageFrame.src = project.src;
      }
      stageFrame.title = project.name;
      stageBody.appendChild(stageFrame);
    } else {
      // 「＋追加」カード：現状はまだアプリ枠の追加UI未実装のため、プレースホルダー表示のまま。
      document.getElementById('stageTag').textContent = '--';
      if (stageFrame) { stageFrame.remove(); stageFrame = null; }
      stagePlaceholder.style.display = '';
    }
    stageEl.classList.add('is-open');
  }

  function closeStage() {
    stageEl.classList.remove('is-open');
    // iframeは閉じたタイミングで完全に破棄する（バックグラウンドで動かし続けない）。
    if (stageFrame) { stageFrame.remove(); stageFrame = null; }
    stagePlaceholder.style.display = '';
    currentStageCardId = null;
    document.getElementById('stageTag').textContent = '--'; // Stageが閉じている間は「何も開かれていない」表示に戻す
  }

  document.getElementById('stageCloseBtn').addEventListener('click', closeStage);

  function render() {
    const items = track.querySelectorAll('.cf-item');
    const mobile = isMobileLayout();
    // カード幅＝トラック幅（.cf-item は width:100%）。16:9 で高さを出す。
    // clientWidth は transform の影響を受けないレイアウト上の幅
    const cardH = track.clientWidth * 9 / 16;
    const len = cards.length + 1; // ＋新規作成カードの1件を含めた総数
    items.forEach((el, i) => {
      const offset = shortestOffset(i, centerIndex, len);
      const isCenter = offset === 0;
      const absOff = Math.abs(offset);
      // スマホ幅：奥行き(translateZ)・傾き(rotateX)だけ0にし、縮小率・不透明度・
      // アニメーションはPC版と同じ計算のまま（「カバーフローらしさ」は残す）。
      // 間隔はカード高さに比例させる。PC版の固定60pxのままだと、画面幅いっぱいに
      // 拡大されたカードでは前後の候補が中央カードの裏にほぼ隠れてしまうため。
      // 0.62倍 ＝ 60%縮小の隣カードが、中央カードの外に約7割はみ出して見える値
      const ySpacing = mobile ? Math.round(cardH * 0.62) : 60;
      const y = offset * ySpacing;
      const rotX = mobile || offset === 0 ? 0 : (offset > 0 ? 38 : -38);
      const z = mobile ? 0 : (isCenter ? 30 : -110 - (absOff - 1) * 30);
      // side banners scaled to 60% of center size
      const scale = isCenter ? 1 : Math.max(0.6, 0.6 - (absOff - 1) * 0.05);
      const opacity = absOff > 2 ? 0 : 1;

      el.style.transform = `translate(-50%, -50%) translateY(${y}px) translateZ(${z}px) rotateX(${rotX}deg) scale(${scale})`;
      el.style.zIndex = 100 - absOff;
      el.style.opacity = opacity;
      el.classList.toggle('is-center', isCenter);
    });

    // Stageタグの表示は「今Stageに実際に開かれているもの」にのみ紐づく
    // （openStage/closeStageが更新する）。以前はここでランチャー中央の
    // カード名に毎回上書きしていたが、ランチャーを回すだけでStageの表示
    // タイトルが変わってしまい、フォントの高さの違いでヘッダーがガタつく
    // 副作用もあった（シーバさん指摘・2026-09-22修正）。ランチャーは
    // あくまでプレビューであり、Stageの表示内容を決めるのはStageを
    // 開いた瞬間（openStage）だけであるべき。
  }

  document.getElementById('cfPrev').addEventListener('click', () => {
    const len = cards.length + 1;
    centerIndex = (centerIndex - 1 + len) % len;
    render();
  });
  document.getElementById('cfNext').addEventListener('click', () => {
    const len = cards.length + 1;
    centerIndex = (centerIndex + 1) % len;
    render();
  });

  // wheel listener bound to the outer (non-3D) .left-col wrapper, since the
  // tilted descendant's own bounding box doesn't line up with its visual
  // position for pointer/wheel targeting. We only react when the pointer is
  // over the cover flow area itself (not the task list below it).
  function handleCoverflowWheel(e) {
    e.preventDefault();
    const len = cards.length + 1;
    if (e.deltaY > 0) {
      centerIndex = (centerIndex + 1) % len;
    } else {
      centerIndex = (centerIndex - 1 + len) % len;
    }
    render();
  }

  document.querySelector('.left-col').addEventListener('wheel', (e) => {
    if (!e.target.closest('.cf-wrap')) return;
    handleCoverflowWheel(e);
  }, { passive: false });

  // Reliable open trigger: a fixed, non-tilted hit-target overlaying the
  // centered banner's on-screen position. It also forwards wheel events to
  // the same cover-flow scroll handler, since it sits outside .left-col and
  // would otherwise swallow wheel input over the banner.
  const openHitEl = document.getElementById('cfOpenHit');
  openHitEl.addEventListener('click', (ev) => {
    // 誤作動防止：中央カードのゴミ箱ボタンの実際の画面上の矩形と
    // クリック座標が重なっている場合は、削除ボタン側の処理に譲る
    // （cfOpenHitは中央カード全体を覆う設計のため、素通りさせないと
    //  ゴミ箱ボタンが物理的にクリックできなくなる）。
    const centerEl = track.querySelector('.cf-item.is-center .cf-item-delete-btn');
    if (centerEl) {
      const r = centerEl.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        centerEl.click();
        return;
      }
    }

    const centerCard = cards[centerIndex];
    if (!centerCard) {
      // ＋新規作成カードが中央にある状態
      openLauncherAddModal();
      return;
    }
    const app = findAppForCard(centerCard);
    if (!app) {
      showLauncherToast('このカードに紐づくアプリ本体が見つかりません');
      return;
    }
    const displayName = centerCard.overlayText && centerCard.overlayText.trim()
      ? centerCard.overlayText.trim()
      : app.name;
    openStage(ev, { name: displayName, src: app.src, htmlContent: app.htmlContent, type: app.type, empty: false }, centerCard.id);
  });
  openHitEl.addEventListener('wheel', handleCoverflowWheel, { passive: false });

  // 【重要】削除ボタンの :hover は実際には発火しない（6.5節と同根の問題）。
  // #cfOpenHit（position: fixed、独立したスタッキングコンテキスト）が
  // 座標上は常に手前にあるため、ブラウザはマウスが実際に乗っているのは
  // #cfOpenHit側だと判定し、.cf-item-delete-btn の :hover は発火しない。
  // そのため、クリック時の座標判定（上のclickハンドラ）と同じロジックを
  // mousemove でも行い、JS側で強制的に .is-hover-forced クラスを
  // 付け外しすることでホバー時の見た目を再現する。
  let lastHoveredDeleteBtn = null;
  openHitEl.addEventListener('mousemove', (ev) => {
    const centerEl = track.querySelector('.cf-item.is-center .cf-item-delete-btn');
    let hovering = null;
    if (centerEl) {
      const r = centerEl.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        hovering = centerEl;
      }
    }
    if (hovering !== lastHoveredDeleteBtn) {
      if (lastHoveredDeleteBtn) lastHoveredDeleteBtn.classList.remove('is-hover-forced');
      if (hovering) hovering.classList.add('is-hover-forced');
      openHitEl.style.cursor = hovering ? 'pointer' : '';
      lastHoveredDeleteBtn = hovering;
    }
  });
  openHitEl.addEventListener('mouseleave', () => {
    if (lastHoveredDeleteBtn) {
      lastHoveredDeleteBtn.classList.remove('is-hover-forced');
      lastHoveredDeleteBtn = null;
      openHitEl.style.cursor = '';
    }
  });

  // Position the hit-target dynamically from the NON-tilted .coverflow-v
  // ancestor's on-screen center — this point stays aligned with the
  // centered banner's visual position at any window size, because the
  // rotateY tilt's transform-origin sits at that same center. Measured
  // against pixel-level screenshots, this tracks the banner correctly
  // where a hardcoded pixel offset does not (it breaks on window resize).
  const coverflowVEl = document.querySelector('.coverflow-v');
  function positionOpenHit() {
    const r = coverflowVEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const w = r.width;
    const h = w * 9 / 16; // matches the banner's aspect-ratio: 16/9
    openHitEl.style.left = (cx - w / 2) + 'px';
    openHitEl.style.top = (cy - h / 2) + 'px';
    openHitEl.style.width = w + 'px';
    openHitEl.style.height = h + 'px';
  }
  positionOpenHit();
  window.addEventListener('resize', positionOpenHit);

  /* ---------------------------------------------------------------------
     スマホ：カバーフローの縦スワイプ（2026-09-24 再構築）
     前回の失敗（透明な当たり判定の層 #cfOpenHit にタッチを付けたが、実際に
     見えているカードとは別レイヤーだったため反応しなかった）を踏まえ、
     document 全体で受けて「指が最初に触れた要素がカバーフロー内か」
     （e.target.closest('.cf-wrap')）だけで判定する。どの層に付けるかに
     左右されない。
     誤作動防止：
       ・スマホ幅のときだけ有効（PCはホイール・▲▼で操作）
       ・Stageやモーダルが上に重なっていれば、触れた要素がそちらになるので
         自動的に対象外になる
       ・40px以上動いたら1回だけ送る（1スワイプ＝1枚。連続送りしない）
       ・横方向の動きの方が大きければ無視（斜めの誤操作対策）
       ・2本指以上（ピンチ等）は対象外
       ・スワイプ直後に指を離した位置のカードが「タップ」扱いされて
         アプリが開いてしまうのを防ぐため、送った直後の短時間はクリックを捨てる
     --------------------------------------------------------------------- */
  const SWIPE_THRESHOLD_PX = 40;
  const SWIPE_CLICK_GUARD_MS = 400;
  let swipeState = null;
  let suppressCardClickUntil = 0;

  function stepCoverflow(dir) {
    const len = cards.length + 1;
    centerIndex = (centerIndex + dir + len) % len;
    render();
  }

  document.addEventListener('touchstart', (e) => {
    swipeState = null;
    if (!isMobileLayout()) return;
    if (e.touches.length !== 1) return;
    if (!e.target.closest || !e.target.closest('.cf-wrap')) return;
    const t = e.touches[0];
    swipeState = { x: t.clientX, y: t.clientY, fired: false };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!swipeState) return;
    if (e.touches.length !== 1) { swipeState = null; return; }
    if (swipeState.fired) return;
    const t = e.touches[0];
    const dx = t.clientX - swipeState.x;
    const dy = t.clientY - swipeState.y;
    if (Math.abs(dy) < SWIPE_THRESHOLD_PX || Math.abs(dy) <= Math.abs(dx)) return;
    // 指を上へ払う＝下にある次のカードが中央へ（リストを押し上げる感覚）
    stepCoverflow(dy < 0 ? 1 : -1);
    swipeState.fired = true;
    suppressCardClickUntil = Date.now() + SWIPE_CLICK_GUARD_MS;
  }, { passive: true });

  const clearSwipe = () => { swipeState = null; };
  document.addEventListener('touchend', clearSwipe, { passive: true });
  document.addEventListener('touchcancel', clearSwipe, { passive: true });

  // キャプチャ段階で先に拾い、各カードのclick処理（アプリを開く）に届く前に捨てる
  track.addEventListener('click', (e) => {
    if (Date.now() < suppressCardClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // PC⇔スマホの境界をまたいだとき（画面回転・ウィンドウ幅変更）に描画し直す。
  // Stageが開いていれば、resize側の既存処理が applyStageSizeMode を呼び直し、
  // その中で isMobileLayout() を見て正しいモードに切り替わる。
  const onMobileLayoutChange = () => {
    render();
    positionOpenHit();
  };
  if (mobileLayoutMql.addEventListener) {
    mobileLayoutMql.addEventListener('change', onMobileLayoutChange);
  } else if (mobileLayoutMql.addListener) {
    mobileLayoutMql.addListener(onMobileLayoutChange); // 古いSafari向け
  }
  // スマホ幅のままトラック幅が変わった場合も、カード高さ連動の間隔を追従させる
  window.addEventListener('resize', () => { if (isMobileLayout()) render(); });

  // カバーフロー・ランチャーDBの初期化 → データ読み込み → 初回描画。
  // 失敗時（プライベートブラウジング等でIndexedDB不可）は、空のカバーフロー
  // （＋新規作成カードのみ）を表示し、ダッシュボード全体は落とさない。
  openLauncherDb().then(async (_db) => {
    launcherDb = _db;
    await loadLauncherData();
    buildCoverflow();
  }).catch((err) => {
    console.error('カバーフロー用DBの初期化に失敗しました', err);
    cards = [];
    apps = [];
    buildCoverflow();
    showLauncherToast('保存機能を利用できません（IndexedDB利用不可）');
  });

  /* ===================== AMBIENT RANDOM FX ===================== */
  // Occasional, non-looping accents: a border light-sweep on a random
  // panel, and a brief glitch flicker on a random INTEL donut ring. Both
  // fire at random intervals rather than on a fixed cycle, and are
  // skipped entirely under prefers-reduced-motion.
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function schedulePanelBeam() {
    setTimeout(() => {
      const panels = document.querySelectorAll('.panel');
      if (panels.length) {
        const panel = panels[Math.floor(Math.random() * panels.length)];
        panel.classList.add('beam-active');
        panel.addEventListener('animationend', () => panel.classList.remove('beam-active'), { once: true });
      }
      schedulePanelBeam();
    }, randomBetween(4000, 9000));
  }

  function scheduleIntelGlitch() {
    setTimeout(() => {
      const rings = document.querySelectorAll('.intel-ring');
      if (rings.length) {
        const ring = rings[Math.floor(Math.random() * rings.length)];
        ring.classList.add('glitch-active');
        ring.querySelector('svg').addEventListener('animationend', () => ring.classList.remove('glitch-active'), { once: true });
      }
      scheduleIntelGlitch();
    }, randomBetween(4000, 10000));
  }

  if (!prefersReducedMotion) {
    schedulePanelBeam();
    scheduleIntelGlitch();
  }

  /* =====================================================================
     LOGパネル：外部メール連携（ポーリングのみ、プッシュ通知ではない）

     設計方針（配布前提のため、特定サービスに依存しない）：
       - SIDE-OPS本体は「ユーザーが設定した公開URLを定期fetchしてJSONを
         表示するだけ」の汎用ポーリング機構に徹する。
       - どのサービス（IFTTT・Zapier・GAS等）でJSONを用意するかはユーザー
         側の自由。本体コードは一切のサービス固有ロジックを持たない。
       - タブを開いている間しか動かない（file://やタブが閉じている間は
         当然ポーリングされない）。リアルタイムのOS通知ではない。

     期待するJSON形式：
       { "logs": [
           { "id": "一意なID", "title": "件名等", "body": "本文抜粋(任意)",
             "timestamp": "ISO8601等", "url": "関連リンク(任意)" }, ... ] }

     将来の拡張について（今回の対応範囲）：
       - logデータに source フィールド（今回は 'external' 固定）を持たせて
         いる。将来「アプリ内部イベント（売上◯◯突破 等）」を通知として
         出したくなった場合は、①検知ロジック側で source:'internal' 等を
         付けたオブジェクトを組み立てて logItems に push → logPut で
         保存 → renderLogPanel() を呼ぶだけで、今回の仕組みにそのまま
         乗る。表示上の色分け等が必要になったら .log-source-internal 等
         のCSSクラスを追加するだけでよい（renderLogPanel は既に
         source値からクラス名を自動生成している）。
       - 内部イベントの検知ロジック自体（INTELのしきい値監視等）は
         今回のスコープ外で、まだ実装していない。

     フールプルーフ（誤作動防止策）一覧：
       1) URL未設定時はポーリング自体を起動しない（早期return）
       2) fetch失敗・タイムアウト時は前回表示を維持し、パネルを壊さない
       3) レスポンスのJSON形式・各エントリのバリデーションを行い、
          不正なエントリは1件ずつスキップ（全体を巻き込んで落とさない）
       4) 取得間隔は下限1分・上限30分にクランプ（相手サービスへの過負荷防止）
       5) id をキーに重複排除。id が無い/空文字のエントリは受け付けない
       6) 保持件数の上限（50件）を超えたら古いものから自動削除
       7) タブが非表示（他タブ・最小化）の間はポーリングを停止し、
          復帰時に即時1回だけ確認する
       8) 通知本文の表示は textContent 経由のみ（innerHTML不使用）。
          外部由来のデータをそのままHTMLとして解釈させずXSSを防止する
       9) 「URL未設定」と「新着なし」でパネルの空表示文言を出し分ける
  ===================================================================== */
  const LOG_DB_NAME = 'sideops_log';
  const LOG_DB_VERSION = 1;
  const LOG_STORE = 'items';
  const LOG_SETTINGS_STORE = 'settings';
  const LOG_MAX_ITEMS = 50;
  const LOG_MIN_INTERVAL_MIN = 1;
  const LOG_MAX_INTERVAL_MIN = 30;
  const LOG_DEFAULT_INTERVAL_MIN = 5;
  const LOG_FETCH_TIMEOUT_MS = 10000;

  let logDb = null;
  let logItems = [];      // { id, title, body, timestamp, url, isUnread }
  let logSourceUrl = '';
  let logIntervalMin = LOG_DEFAULT_INTERVAL_MIN;
  let logTimerId = null;
  let logIsFetching = false; // 多重fetch防止

  function openLogDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LOG_DB_NAME, LOG_DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const _db = ev.target.result;
        if (!_db.objectStoreNames.contains(LOG_STORE)) {
          _db.createObjectStore(LOG_STORE, { keyPath: 'id' });
        }
        if (!_db.objectStoreNames.contains(LOG_SETTINGS_STORE)) {
          _db.createObjectStore(LOG_SETTINGS_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function logStore(name, mode) {
    const tx = logDb.transaction(name, mode);
    return tx.objectStore(name);
  }
  function logGetAll(name) {
    return new Promise((resolve, reject) => {
      const req = logStore(name, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function logPut(name, value) {
    return new Promise((resolve, reject) => {
      const req = logStore(name, 'readwrite').put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function logDelete(name, id) {
    return new Promise((resolve, reject) => {
      const req = logStore(name, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function logClearAll(name) {
    return new Promise((resolve, reject) => {
      const req = logStore(name, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function clampInterval(min) {
    const n = Number(min);
    if (!Number.isFinite(n)) return LOG_DEFAULT_INTERVAL_MIN;
    return Math.min(LOG_MAX_INTERVAL_MIN, Math.max(LOG_MIN_INTERVAL_MIN, Math.round(n)));
  }

  // 個々のエントリを検証。不正なものはnullを返す（呼び出し側でスキップ）。
  // source は通知の発生元を示す識別子（例: 'external' = 外部メール連携,
  // 将来的に 'internal' = アプリ内部イベント等を追加予定）。
  // 呼び出し側が明示的に渡す値をそのまま使い、ここでは検証・保持のみ行う。
  function validateLogEntry(raw, source) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : (typeof raw.id === 'number' ? String(raw.id) : '');
    if (!id) return null;
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '(無題の通知)';
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    let timestamp = raw.timestamp;
    let timeMs = Date.parse(timestamp);
    if (!Number.isFinite(timeMs)) timeMs = Date.now();
    const url = typeof raw.url === 'string' && /^https?:\/\//.test(raw.url.trim()) ? raw.url.trim() : '';
    const safeSource = typeof source === 'string' && source ? source : 'unknown';
    return { id, title, body, timeMs, url, source: safeSource };
  }

  function formatRelativeTime(timeMs) {
    const diffSec = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
    if (diffSec < 60) return 'たった今';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}分前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}時間前`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay === 1) return '昨日';
    if (diffDay < 7) return `${diffDay}日前`;
    const d = new Date(timeMs);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function renderLogPanel() {
    const listEl = document.getElementById('logList');
    if (!listEl) return;
    listEl.textContent = '';

    if (!logSourceUrl) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '設定から取得元を登録してください';
      listEl.appendChild(empty);
      return;
    }
    if (logItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '新着はありません';
      listEl.appendChild(empty);
      return;
    }

    const sorted = logItems.slice().sort((a, b) => b.timeMs - a.timeMs);
    for (const item of sorted) {
      const row = document.createElement('div');
      const sourceClass = item.source ? ` log-source-${item.source}` : '';
      row.className = 'log-item' + (item.isUnread ? ' is-unread' : '') + sourceClass;
      const dot = document.createElement('div');
      dot.className = 'log-dot';
      const body = document.createElement('div');
      const textEl = document.createElement('div');
      textEl.className = 'log-text';
      textEl.textContent = item.title; // textContentのみ使用（XSS対策）
      const timeEl = document.createElement('div');
      timeEl.className = 'log-time';
      timeEl.textContent = formatRelativeTime(item.timeMs);
      body.appendChild(textEl);
      body.appendChild(timeEl);
      row.appendChild(dot);
      row.appendChild(body);
      row.addEventListener('click', () => {
        markLogRead(item.id);
        if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
      });
      listEl.appendChild(row);
    }
  }

  async function markLogRead(id) {
    const item = logItems.find((n) => n.id === id);
    if (!item || !item.isUnread) return;
    item.isUnread = false;
    try {
      await logPut(LOG_STORE, item);
    } catch (err) {
      console.error('通知の既読状態の保存に失敗しました', err);
    }
    renderLogPanel();
  }

  // 保持件数の上限を超えた古い通知をDB・メモリ双方から間引く。
  async function trimLogItems() {
    if (logItems.length <= LOG_MAX_ITEMS) return;
    const sorted = logItems.slice().sort((a, b) => b.timeMs - a.timeMs);
    const toRemove = sorted.slice(LOG_MAX_ITEMS);
    for (const item of toRemove) {
      try { await logDelete(LOG_STORE, item.id); } catch (err) { /* 個別失敗は無視して継続 */ }
    }
    const keepIds = new Set(sorted.slice(0, LOG_MAX_ITEMS).map((n) => n.id));
    logItems = logItems.filter((n) => keepIds.has(n.id));
  }

  function setLogStatus(msg, kind) {
    const el = document.getElementById('logSrcStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('is-error', 'is-ok');
    if (kind) el.classList.add(kind);
  }

  async function fetchLogSource(isManual) {
    if (!logSourceUrl) return;               // 1) URL未設定なら何もしない
    if (logIsFetching) return;                // 多重fetch防止
    logIsFetching = true;
    if (isManual) setLogStatus('確認中…');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LOG_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(logSourceUrl, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rawList = Array.isArray(data) ? data : Array.isArray(data && data.logs) ? data.logs : null;
      if (!rawList) throw new Error('形式が不正です（logs配列が見つかりません）');

      const existingIds = new Set(logItems.map((n) => n.id));
      let addedCount = 0;
      for (const raw of rawList) {
        const parsed = validateLogEntry(raw, 'external');       // 3) 不正エントリはスキップ
        if (!parsed) continue;
        if (existingIds.has(parsed.id)) continue;      // 5) 重複排除
        const newItem = { ...parsed, isUnread: true };
        logItems.push(newItem);
        existingIds.add(parsed.id);
        addedCount++;
        try { await logPut(LOG_STORE, newItem); } catch (err) { /* 個別失敗は無視して継続 */ }
      }

      await trimLogItems();                          // 6) 上限超過分を間引く
      renderLogPanel();

      if (isManual) {
        setLogStatus(addedCount > 0 ? `新着 ${addedCount} 件を取得しました` : '新着はありませんでした', 'is-ok');
      }
    } catch (err) {
      console.error('通知の取得に失敗しました', err);   // 2) 失敗時も既存表示は維持
      if (isManual) {
        const reason = err && err.name === 'AbortError' ? 'タイムアウトしました' : '取得に失敗しました（URLや形式を確認してください）';
        setLogStatus(reason, 'is-error');
      }
    } finally {
      clearTimeout(timeoutId);
      logIsFetching = false;
    }
  }

  function stopLogPolling() {
    if (logTimerId) {
      clearInterval(logTimerId);
      logTimerId = null;
    }
  }

  function startLogPolling() {
    stopLogPolling();
    if (!logSourceUrl) return;                       // 1) URL未設定なら起動しない
    if (document.visibilityState === 'hidden') return;  // 7) 非表示タブでは起動しない
    logTimerId = setInterval(() => fetchLogSource(false), logIntervalMin * 60 * 1000);
  }

  // 7) タブの表示状態に応じてポーリングを制御。非表示→表示に戻った瞬間に
  //    1回だけ即時確認し、以降は通常間隔のタイマーへ戻す。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopLogPolling();
    } else {
      fetchLogSource(false);
      startLogPolling();
    }
  });

  async function saveLogSettings(url, intervalMin) {
    const trimmedUrl = (url || '').trim();
    if (trimmedUrl && !/^https?:\/\//.test(trimmedUrl)) {
      setLogStatus('http(s):// で始まるURLを入力してください', 'is-error');
      return false;
    }
    logSourceUrl = trimmedUrl;
    logIntervalMin = clampInterval(intervalMin);      // 4) 下限・上限にクランプ
    try {
      await logPut(LOG_SETTINGS_STORE, { key: 'sourceUrl', value: logSourceUrl });
      await logPut(LOG_SETTINGS_STORE, { key: 'intervalMin', value: logIntervalMin });
    } catch (err) {
      console.error('通知設定の保存に失敗しました', err);
      setLogStatus('設定の保存に失敗しました', 'is-error');
      return false;
    }
    renderLogPanel();
    startLogPolling();
    return true;
  }

  async function loadLogData() {
    try {
      logItems = (await logGetAll(LOG_STORE)) || [];
    } catch (err) {
      console.error('通知データの読み込みに失敗しました', err);
      logItems = [];
    }
    try {
      const settings = await logGetAll(LOG_SETTINGS_STORE);
      const urlRow = settings.find((s) => s.key === 'sourceUrl');
      const intervalRow = settings.find((s) => s.key === 'intervalMin');
      logSourceUrl = urlRow && typeof urlRow.value === 'string' ? urlRow.value : '';
      logIntervalMin = intervalRow ? clampInterval(intervalRow.value) : LOG_DEFAULT_INTERVAL_MIN;
    } catch (err) {
      console.error('通知設定の読み込みに失敗しました', err);
      logSourceUrl = '';
      logIntervalMin = LOG_DEFAULT_INTERVAL_MIN;
    }
  }

  function initLogSettingsUi() {
    const urlInput = document.getElementById('logSrcUrlInput');
    const intervalSelect = document.getElementById('logSrcIntervalSelect');
    const saveBtn = document.getElementById('logSrcSaveBtn');
    const checkNowBtn = document.getElementById('logSrcCheckNowBtn');
    if (!urlInput || !intervalSelect || !saveBtn || !checkNowBtn) return;

    urlInput.value = logSourceUrl;
    intervalSelect.value = String(logIntervalMin);

    saveBtn.addEventListener('click', async () => {
      const ok = await saveLogSettings(urlInput.value, intervalSelect.value);
      if (ok) {
        setLogStatus(logSourceUrl ? '保存しました' : '取得元をクリアしました', 'is-ok');
        if (logSourceUrl) fetchLogSource(true);
      }
    });
    checkNowBtn.addEventListener('click', () => {
      if (!logSourceUrl) {
        setLogStatus('先に取得元URLを保存してください', 'is-error');
        return;
      }
      fetchLogSource(true);
    });
  }

  // 通知DBの初期化 → 設定・データ読み込み → 初回描画 → ポーリング開始。
  // 失敗時（IndexedDB不可等）は空の通知パネル（「設定から〜」表示）に
  // フォールバックし、ダッシュボード全体は落とさない。
  openLogDb().then(async (_db) => {
    logDb = _db;
    await loadLogData();
    renderLogPanel();
    initLogSettingsUi();
    startLogPolling();
  }).catch((err) => {
    console.error('通知用DBの初期化に失敗しました', err);
    logItems = [];
    logSourceUrl = '';
    renderLogPanel();
    initLogSettingsUi();
  });

  // 設定DBの初期化 → 保存済み設定の復元。
  // 失敗時（IndexedDB不可、レコード破損等）は例外を投げず、既存の
  // デフォルト値（透過率100%・壁紙なし・darkテーマ）のまま起動を
  // 続行する（フールプルーフ：設定復元の失敗でアプリ全体を止めない）。
  openSettingsDb().then(async (_db) => {
    settingsDb = _db;
    let record = null;
    let uploadsRecord = null;
    try {
      record = await loadSettingsRecord();
    } catch (err) {
      console.error('設定の読み込みに失敗しました', err);
    }
    try {
      uploadsRecord = await loadSettingsRecordByKey(SETTINGS_WALLPAPER_UPLOADS_KEY);
    } catch (err) {
      console.error('壁紙アップロードの読み込みに失敗しました', err);
    }

    // 壁紙アップロード一覧（プリセットの後ろに追加表示するため、
    // スウォッチ再構築より前に復元しておく）。record（軽量データ）とは
    // 別レコードなので、record自体が無くても（新規保存前）復元できる。
    if (uploadsRecord && Array.isArray(uploadsRecord.uploads)) {
      wallpaperUploads = uploadsRecord.uploads;
      buildWallpaperSwatches();
    }

    if (!record) return; // 軽量レコードが無い（初回起動等）→残りはデフォルトのまま

    // 透過率
    if (typeof record.panelAlpha === 'number' && Number.isFinite(record.panelAlpha)) {
      panelAlpha = Math.min(100, Math.max(0, record.panelAlpha));
      applyAlpha();
    }

    // 壁紙の選択状態
    if (typeof record.wallpaperValue === 'string') {
      applyWallpaper(record.wallpaperValue);
      // 対応するスウォッチボタンをactive表示にする（プリセット／
      // アップロードどちらでも、値が一致するボタンを探して反映）
      const btns = wallpaperSwatchesEl.querySelectorAll('.wallpaper-swatch');
      const presetIdx = wallpaperPresets.findIndex(p => p.value === record.wallpaperValue);
      if (presetIdx >= 0) {
        setActiveWallpaperSwatch(btns[presetIdx]);
      } else {
        const uploadIdx = wallpaperUploads.findIndex(u => `url("${u.dataUrl}")` === record.wallpaperValue);
        if (uploadIdx >= 0) setActiveWallpaperSwatch(btns[wallpaperPresets.length + uploadIdx]);
      }
    }

    // スポイトテーマの色（保存されていればthemes.eyedropperとして復元。
    // 壁紙から自動再生成はせず、保存時点の色をそのまま使う）
    if (record.eyedropperThemeTokens) {
      themes.eyedropper = {
        label: 'スポイト（壁紙から生成）',
        swatchBg: record.eyedropperThemeTokens['--bg'] || '#05070a',
        swatchAccent: record.eyedropperThemeTokens['--cyan'] || '#00f0d0',
        tokens: record.eyedropperThemeTokens,
      };
    }

    // カスタムテーマの色（保存されていればthemes.customとして復元。
    // カスタムテーマ編集モーダル自体は次のステップで実装）
    if (record.customThemeTokens) {
      themes.custom = {
        label: 'カスタム',
        swatchBg: record.customThemeTokens['--bg'] || '#05070a',
        swatchAccent: record.customThemeTokens['--cyan'] || '#00f0d0',
        tokens: record.customThemeTokens,
      };
    }

    // 選択中のテーマ（eyedropper/customは対応する保存済みトークンが
    // 実際に存在する場合のみ復元する。データが欠けたまま適用すると
    // 空のthemes.eyedropper等でエラーになるため）
    if (typeof record.themeKey === 'string' && themes[record.themeKey]) {
      buildThemeSwatches(); // eyedropper/customがthemesに追加された後で作り直す
      applyTheme(record.themeKey);
    }
  }).catch((err) => {
    console.error('設定DBの初期化に失敗しました', err);
  });
