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

  /* ===================== HEADER ICONS: FULLSCREEN / CLOUD (stub) / SETTINGS ===================== */
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  function updateFullscreenBtnState() {
    const isFs = !!document.fullscreenElement;
    fullscreenBtn.classList.toggle('is-active', isFs);
    fullscreenBtn.title = isFs ? '全画面表示を解除（F11）' : '全画面表示（F11）';
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
  });
  document.getElementById('alphaDown').addEventListener('click', () => {
    panelAlpha = Math.max(0, panelAlpha - 10);
    applyAlpha();
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
      });
      wallpaperSwatchesEl.appendChild(btn);
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
    const reader = new FileReader();
    reader.onload = (ev) => {
      // Each uploaded image gets its own independent value baked into its
      // own button's click handler, so earlier uploads keep working after
      // later ones are added (no shared/overwritten variable).
      const thisWallpaperValue = `url("${ev.target.result}")`;
      const btn = document.createElement('button');
      btn.className = 'wallpaper-swatch';
      btn.title = file.name;
      btn.style.backgroundImage = `url("${ev.target.result}")`;
      btn.addEventListener('click', () => {
        applyWallpaper(thisWallpaperValue);
        setActiveWallpaperSwatch(btn);
      });
      wallpaperSwatchesEl.appendChild(btn);
      applyWallpaper(thisWallpaperValue);
      setActiveWallpaperSwatch(btn);
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
    Object.entries(themes).forEach(([key, theme]) => {
      const btn = document.createElement('button');
      btn.className = 'theme-swatch' + (key === currentTheme ? ' active' : '');
      btn.dataset.theme = key;
      btn.title = theme.label;
      btn.style.setProperty('--_sw-bg', theme.swatchBg);
      btn.style.setProperty('--_sw-accent', theme.swatchAccent);
      btn.innerHTML = '<span class="ts-bg"></span><span class="ts-accent"></span>';
      btn.addEventListener('click', () => applyTheme(key));
      wrap.appendChild(btn);
    });
  }
  buildThemeSwatches();

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

  /* ===================== VERTICAL COVER FLOW LOGIC ===================== */
  // カバーフローの役割：プロジェクト一覧 → アプリランチャー。
  // 各カードは中央クリックでStageにiframe（src）を読み込んで開く。
  // src は現状すべてダミーページ（apps/配下）。実アプリが用意でき次第、
  // このsrcを実ファイルのパスに差し替えるだけで統合できる。
  const projects = [
    { cat: 'ツール', name: '画像生成プロンプト見本', src: 'apps/prompt-gallery.html' },
    { cat: 'ツール ・ 統合予定', name: 'manuscript', src: 'apps/manuscript.html' },
    { cat: 'ツール ・ 統合予定', name: 'scaffold', src: 'apps/scaffold.html' },
    { cat: 'ツール', name: 'メモ', src: 'apps/memo.html' },
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
  let stageFrame = null; // 現在表示中のiframe（開いていなければnull）

  function openStage(ev, project) {
    const stageRect = stageEl.getBoundingClientRect();
    const originX = ((ev.clientX - stageRect.left) / stageRect.width) * 100 + '%';
    const originY = ((ev.clientY - stageRect.top) / stageRect.height) * 100 + '%';
    stageContent.style.setProperty('--origin-x', originX);
    stageContent.style.setProperty('--origin-y', originY);

    if (project && !project.empty && project.src) {
      document.getElementById('stageTag').textContent = project.name;
      // 「＋追加」以外のアプリカードは、Stage内にiframeでダミー/実アプリを読み込む。
      // 既存のiframeがあれば一旦除去してから作り直す（同じアプリの再クリックも含め、
      // 毎回リロードして状態をリセットする挙動にしている）。
      if (stageFrame) stageFrame.remove();
      stagePlaceholder.style.display = 'none';
      stageFrame = document.createElement('iframe');
      stageFrame.className = 'stage-frame';
      stageFrame.src = project.src;
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
  }

  document.getElementById('stageCloseBtn').addEventListener('click', closeStage);

  function render() {
    const items = track.querySelectorAll('.cf-item');
    const len = projects.length;
    items.forEach((el, i) => {
      const offset = shortestOffset(i, centerIndex, len);
      const isCenter = offset === 0;
      const absOff = Math.abs(offset);
      const ySpacing = 60;
      const y = offset * ySpacing;
      const rotX = offset === 0 ? 0 : (offset > 0 ? 38 : -38);
      const z = isCenter ? 30 : -110 - (absOff - 1) * 30;
      // side banners scaled to 60% of center size
      const scale = isCenter ? 1 : Math.max(0.6, 0.6 - (absOff - 1) * 0.05);
      const opacity = absOff > 2 ? 0 : 1;

      el.style.transform = `translate(-50%, -50%) translateY(${y}px) translateZ(${z}px) rotateX(${rotX}deg) scale(${scale})`;
      el.style.zIndex = 100 - absOff;
      el.style.opacity = opacity;
      el.classList.toggle('is-center', isCenter);
    });

    const centerProject = projects[centerIndex];
    if (centerProject && !centerProject.empty) {
      document.getElementById('stageTag').textContent = centerProject.name;
    }
  }

  document.getElementById('cfPrev').addEventListener('click', () => {
    centerIndex = (centerIndex - 1 + projects.length) % projects.length;
    render();
  });
  document.getElementById('cfNext').addEventListener('click', () => {
    centerIndex = (centerIndex + 1) % projects.length;
    render();
  });

  // wheel listener bound to the outer (non-3D) .left-col wrapper, since the
  // tilted descendant's own bounding box doesn't line up with its visual
  // position for pointer/wheel targeting. We only react when the pointer is
  // over the cover flow area itself (not the task list below it).
  function handleCoverflowWheel(e) {
    e.preventDefault();
    if (e.deltaY > 0) {
      centerIndex = (centerIndex + 1) % projects.length;
    } else {
      centerIndex = (centerIndex - 1 + projects.length) % projects.length;
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
    openStage(ev, projects[centerIndex]);
  });
  openHitEl.addEventListener('wheel', handleCoverflowWheel, { passive: false });

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

  buildCoverflow();

  /* ===================== AMBIENT RANDOM FX ===================== */
  // Occasional, non-looping accents: a border light-sweep on a random
  // panel, and a brief glitch flicker on a random KPI donut ring. Both
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

  function scheduleKpiGlitch() {
    setTimeout(() => {
      const rings = document.querySelectorAll('.kpi-ring');
      if (rings.length) {
        const ring = rings[Math.floor(Math.random() * rings.length)];
        ring.classList.add('glitch-active');
        ring.querySelector('svg').addEventListener('animationend', () => ring.classList.remove('glitch-active'), { once: true });
      }
      scheduleKpiGlitch();
    }, randomBetween(4000, 10000));
  }

  if (!prefersReducedMotion) {
    schedulePanelBeam();
    scheduleKpiGlitch();
  }
