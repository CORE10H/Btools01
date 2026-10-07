/* =====================================================================
   同期の保存先：OneDrive（個人用Microsoftアカウント）
   設計：docs/planning/claude_クラウド同期_仕様書.md

   - 置き場所は OneDrive の「アプリ」フォルダ（special/approot）。求める権限は
     Files.ReadWrite.AppFolder（このアプリのフォルダだけ）と offline_access（更新用トークン）
   - ログインは OAuth 2.0 の認可コード＋PKCE（標準の手順を自前で実装。外部のスクリプトは読み込まない）。
     ページごとMicrosoftのログイン画面へ移り、戻ってきたURLの # からコードを受け取る
     （ポップアップより、スマホでも確実に動くため）。戻ったら同期の続きをする
   - アクセストークン（約1時間）はメモリだけ。更新用トークン（単一ページアプリでは最長24時間）は、
     同期の鍵で暗号化して sideops_sync に保存する（ページを開き直してもログインし直さずに済む）
   - 保存先の操作は sync.js と同じ list / read / write / remove の4つ

   フールプルーフ：
     1) クライアントIDが未設定なら、ボタンを押してもログインに進まない
     2) ログインから戻ったときは state を照合し、10分以上前の・別のタブの要求は受け付けない。
        URL からはコードをすぐに消す
     3) 401 は更新用トークンで1回だけ取り直す。だめなら「ログインが必要」
     4) 429・503 は Retry-After（最大30秒）に従い、最大4回までやり直す
     5) ダウンロード用URLは数分で切れるので、失敗したら取り直して1回だけやり直す
   ===================================================================== */
(() => {
  'use strict';

  // Microsoft Entra で登録したアプリの「アプリケーション（クライアント）ID」（秘密ではないので、ここに書いてよい）
  const CLIENT_ID = '2614141e-d905-4b0d-8a43-748e14b1fd27';
  const SCOPE = 'https://graph.microsoft.com/Files.ReadWrite.AppFolder offline_access';
  const MAX_UPLOAD = 250 * 1024 * 1024;   // 1回の送信で送れる上限（Graph の仕様）
  const RETRY_MAX = 4;
  const PENDING_KEY = 'sideops_onedrive_pending'; // sessionStorage：ログインに出た要求（state・PKCEの検証用の値）
  const RESUME_KEY = 'sideops_sync_resume';        // sessionStorage：ログインから戻ったら同期を続ける印
  const SECRET_NAME = 'onedrive-refresh';
  const DOWNLOAD_URL_TTL_MS = 4 * 60 * 1000;
  // 同じ同期の中で一覧を取り直さない時間（2026-10-08。確認→同期の続きで2回取っていた。書き込み・削除は一覧の控えにも反映するので食い違わない）
  const LIST_REUSE_MS = 20 * 1000;

  // 動作確認用：localhost で開いたときだけ、偽のMicrosoftに差し替えられる（公開サイトでは効かない）
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const hook = isLocal && window.__SIDEOPS_ONEDRIVE_TEST__ ? window.__SIDEOPS_ONEDRIVE_TEST__ : null;
  const clientId = hook ? String(hook.clientId) : CLIENT_ID;
  const AUTH = hook ? String(hook.authBase).replace(/\/+$/, '') + '/consumers/oauth2/v2.0' : 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
  const GRAPH = hook ? String(hook.graphBase).replace(/\/+$/, '') : 'https://graph.microsoft.com';

  class OneDriveError extends Error {
    constructor(message, code) { super(message); this.code = code || 'error'; this.userFacing = true; }
  }

  let access = null;  // { value, expiresAt }
  let refresh = null; // { value, expiresAt }

  function configured() { return !!clientId; }
  // 登録したリダイレクトURIと完全に一致させる（index.html を付けて開いても同じにする）
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

  function b64url(bytes) {
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomUrlSafe(n) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }

  // ---- 更新用トークンの保存（同期の鍵で暗号化。鍵がまだない端末ではメモリだけ） ----
  async function persist() {
    const S = window.SideOpsSync;
    if (!refresh || !S || !S.saveSecret) return false;
    return S.saveSecret(SECRET_NAME, JSON.stringify(refresh));
  }
  async function restore() {
    const S = window.SideOpsSync;
    if (refresh || !S || !S.loadSecret) return;
    try {
      const raw = await S.loadSecret(SECRET_NAME);
      const r = raw ? JSON.parse(raw) : null;
      if (r && typeof r.value === 'string' && Number.isFinite(r.expiresAt) && Date.now() < r.expiresAt) refresh = r;
    } catch (err) { /* 読めなければログインし直す */ }
  }
  async function forgetStored() {
    const S = window.SideOpsSync;
    if (S && S.deleteSecret) { try { await S.deleteSecret(SECRET_NAME); } catch (err) { /* 次のログインで上書きされる */ } }
  }

  // ---- トークンの受け取り ----
  async function tokenRequest(params) {
    let res;
    try {
      res = await fetch(AUTH + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    } catch (err) {
      throw new OneDriveError('Microsoftにつながりません（ネットワークを確認してください）', 'network');
    }
    let j = null;
    try { j = await res.json(); } catch (err) { j = null; }
    if (!res.ok || !j || !j.access_token) {
      const e = j && j.error;
      if (e === 'invalid_grant' || e === 'interaction_required' || e === 'consent_required' || e === 'login_required') {
        throw new OneDriveError('OneDriveのログインが切れました。もう一度「同期する」を押してください', 'login');
      }
      throw new OneDriveError(`Microsoftのログインでエラーが起きました（${e || res.status}）`, 'http');
    }
    return j;
  }
  function takeTokens(j, keepRefreshExpiry) {
    const now = Date.now();
    access = { value: j.access_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 };
    if (j.refresh_token) {
      // 単一ページアプリの更新用トークンは、最初のログインから24時間で切れる（取り直しても延びない）
      const life = Number(j.refresh_token_expires_in) > 0 ? Number(j.refresh_token_expires_in) * 1000 : 24 * 3600 * 1000;
      const expiresAt = keepRefreshExpiry && refresh ? Math.min(refresh.expiresAt, now + life) : now + life;
      refresh = { value: j.refresh_token, expiresAt: expiresAt - 5 * 60 * 1000 };
    }
  }
  async function refreshGrant() {
    if (!refresh || Date.now() >= refresh.expiresAt) throw new OneDriveError('OneDriveのログインが必要です', 'login');
    try {
      const j = await tokenRequest({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh.value, scope: SCOPE });
      takeTokens(j, true);
      await persist();
    } catch (err) {
      if (err.code === 'login') { refresh = null; await forgetStored(); }
      throw err;
    }
  }

  // ログインに出る（ページを離れる）。戻ったら handleRedirect がコードを受け取る
  async function startLogin() {
    const verifier = randomUrlSafe(32);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = randomUrlSafe(16);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, at: Date.now(), redirectUri: redirectUri() }));
    sessionStorage.setItem(RESUME_KEY, 'onedrive');
    const u = new URL(AUTH + '/authorize');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', redirectUri());
    u.searchParams.set('response_mode', 'fragment'); // コードを # に載せる（サーバーへ送られない）
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    location.assign(u.toString());
  }

  // ログインから戻ったときの処理（ページの読み込み時に1回だけ）
  const redirectResult = (async () => {
    const h = location.hash || '';
    if (!/[#&](code|error)=/.test(h)) return null;
    const p = new URLSearchParams(h.slice(1));
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (err) { /* 消せなくても続ける */ }
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch (err) { pending = null; }
    sessionStorage.removeItem(PENDING_KEY);
    if (!pending || pending.state !== p.get('state') || Date.now() - pending.at > 10 * 60 * 1000) {
      sessionStorage.removeItem(RESUME_KEY);
      return { error: 'ログインの確認に失敗しました。もう一度「同期する」を押してください' };
    }
    if (p.get('error')) {
      sessionStorage.removeItem(RESUME_KEY);
      return { error: p.get('error') === 'access_denied' ? 'ログインを中止しました' : `ログインに失敗しました（${p.get('error')}）` };
    }
    try {
      const j = await tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code: p.get('code'), redirect_uri: pending.redirectUri, code_verifier: pending.verifier, scope: SCOPE });
      takeTokens(j, false);
      await persist();
      return { ok: true };
    } catch (err) {
      sessionStorage.removeItem(RESUME_KEY);
      return { error: err.message || 'ログインに失敗しました' };
    }
  })();

  // 使えるトークンを用意する。interactive のときは、必要ならログインに出る（ページを離れるので戻らない）
  async function ensureToken({ interactive } = {}) {
    if (!configured()) throw new OneDriveError('OneDriveの設定（クライアントID）がまだありません', 'config');
    await redirectResult;
    if (access && Date.now() < access.expiresAt - 60 * 1000) return true;
    await restore();
    if (refresh && Date.now() < refresh.expiresAt) {
      try { await refreshGrant(); return true; } catch (err) { if (err.code !== 'login') throw err; }
    }
    if (!interactive) return false;
    await startLogin();
    return new Promise(() => {}); // ページを離れる
  }
  // ログインし直さずに同期できるか（☁の印用）
  async function status() {
    if (!configured()) return 'off';
    await redirectResult;
    if (access && Date.now() < access.expiresAt - 60 * 1000) return 'ready';
    await restore();
    return refresh && Date.now() < refresh.expiresAt ? 'ready' : 'login';
  }
  async function signOut() {
    access = null;
    refresh = null;
    await forgetStored();
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (err) { return '?'; }
  }
  // 読めなかったときの案内。Braveは navigator.brave を持つので、Shields の案内を出す
  function downloadFailMessage(url) {
    const where = url ? `（ダウンロード先：${hostOf(url)}）` : '';
    const hint = navigator.brave
      ? 'Braveをお使いの場合は、このサイトのShields（アドレスバーのライオンのアイコン）をオフにしてから、もう一度試してください'
      : 'ブラウザの拡張機能（広告ブロック等）やセキュリティソフトが通信を止めていないか確かめてください';
    return `OneDriveのファイルを読めませんでした${where}。${hint}`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(method, url, { body, headers, allow404 } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (!access || Date.now() >= access.expiresAt - 60 * 1000) await refreshGrant();
      let res;
      try {
        res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + access.value, ...(headers || {}) }, body });
      } catch (err) {
        throw new OneDriveError('OneDriveにつながりません（ネットワークを確認してください）', 'network');
      }
      if (res.status === 401 && !refreshed) { refreshed = true; access = null; continue; } // 1回だけ取り直す
      if (res.status === 401) throw new OneDriveError('OneDriveのログインが切れました。もう一度「同期する」を押してください', 'login');
      if ((res.status === 429 || res.status === 503 || res.status >= 500) && attempt < RETRY_MAX) {
        const ra = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 500 * 2 ** attempt + Math.floor(Math.random() * 300));
        continue;
      }
      if (res.status === 404 && allow404) return res;
      if (!res.ok) throw new OneDriveError(`OneDriveでエラーが起きました（${res.status}）`, 'http');
      return res;
    }
  }

  function createBackend() {
    let index = null; // 名前 → { id, size, mtime, eTag, url, urlAt }
    let listedAt = 0;
    const itemUrl = (name) => `${GRAPH}/v1.0/me/drive/special/approot:/${encodeURIComponent(name)}`;
    async function list() {
      if (index && Date.now() - listedAt < LIST_REUSE_MS) return Array.from(index.keys());
      const map = new Map();
      let url = `${GRAPH}/v1.0/me/drive/special/approot/children?$select=id,name,size,lastModifiedDateTime,eTag,file,@microsoft.graph.downloadUrl&$top=200`;
      while (url) {
        const j = await (await api('GET', url)).json();
        for (const it of j.value || []) {
          if (!it || !it.file || typeof it.name !== 'string') continue;
          map.set(it.name, {
            id: it.id, size: Number(it.size) || 0, mtime: Date.parse(it.lastModifiedDateTime) || 0, eTag: it.eTag || '',
            url: it['@microsoft.graph.downloadUrl'] || null, urlAt: Date.now(),
          });
        }
        url = j['@odata.nextLink'] || null;
      }
      index = map;
      listedAt = Date.now();
      return Array.from(map.keys());
    }
    // 読む：①一覧に付いてきたダウンロード用URL → ②取り直したダウンロード用URL → ③Graph の /content
    // （③は302で同じ場所へ移る。新しいブラウザは別の場所へ移るときに Authorization を外す）。
    // ダウンロード用URLは OneDrive とは別の場所（my.microsoftpersonalcontent.com 等）なので、
    // ブラウザの保護機能に止められることがある。失敗したら、どこで止まったかを表示する
    async function read(name) {
      if (!index) await list();
      const e = index.get(name);
      if (!e) return null;
      const tried = [];
      const fromUrl = async (url, via) => {
        let res = null;
        try {
          // 事前認証済みのURL：Authorization・Cookie・Referer を付けない
          res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
        } catch (err) {
          tried.push(`${via}:${hostOf(url)}:通信できない`);
          return null;
        }
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        tried.push(`${via}:${hostOf(url)}:${res.status}`);
        return null;
      };
      let lastUrl = e.url;
      if (e.url && Date.now() - e.urlAt < DOWNLOAD_URL_TTL_MS) {
        const b = await fromUrl(e.url, '一覧のURL');
        if (b) return b;
      }
      const meta = await api('GET', `${itemUrl(name)}?$select=id,@microsoft.graph.downloadUrl`, { allow404: true });
      if (meta.status === 404) return null;
      const fresh = (await meta.json())['@microsoft.graph.downloadUrl'];
      if (fresh) {
        lastUrl = fresh;
        const b = await fromUrl(fresh, '取り直したURL');
        if (b) return b;
      }
      try {
        const res = await api('GET', `${GRAPH}/v1.0/me/drive/items/${encodeURIComponent(e.id)}/content`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        tried.push(`content:${err && err.message}`);
      }
      console.warn('OneDriveのファイルを読めませんでした', name, tried);
      throw new OneDriveError(downloadFailMessage(lastUrl), 'download');
    }
    async function write(name, bytes) {
      if (!index) await list();
      if (bytes.length > MAX_UPLOAD) throw new OneDriveError('ファイルが大きすぎます（1つ250MBまで）', 'http');
      const it = await (await api('PUT', `${itemUrl(name)}:/content`, { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json();
      index.set(name, { id: it.id, size: Number(it.size) || bytes.length, mtime: Date.parse(it.lastModifiedDateTime) || Date.now(), eTag: it.eTag || '', url: null, urlAt: 0 });
    }
    async function remove(name) {
      if (!index) await list();
      if (!index.has(name)) return;
      await api('DELETE', itemUrl(name), { allow404: true });
      index.delete(name);
    }
    function ageMs(name) { const e = index && index.get(name); return e ? Date.now() - e.mtime : 0; }
    function stamp(name) { const e = index && index.get(name); return e ? (e.eTag || e.mtime + ':' + e.size) : ''; }
    return { kind: 'onedrive', list, read, write, remove, ageMs, stamp };
  }

  window.SideOpsSyncProviders = window.SideOpsSyncProviders || {};
  window.SideOpsSyncProviders.onedrive = {
    id: 'onedrive', label: 'OneDrive', order: 1, loginLeavesPage: true,
    note: 'OneDriveの「アプリ」→「SIDE-OPS」フォルダに、暗号化して保存します（中身もファイル名も読めない形です。このフォルダは手で消さないでください）。ログインは24時間有効で、その間はページを開き直してもログインし直さずに同期できます。',
    configured, ensureToken, status, signOut, createBackend, persist, redirectResult, resumeKey: RESUME_KEY,
  };
})();
