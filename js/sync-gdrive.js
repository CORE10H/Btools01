/* =====================================================================
   同期の保存先：Googleドライブ（段階2）
   設計：docs/planning/claude_クラウド同期_仕様書.md

   - 置き場所はGoogleドライブの appDataFolder（このアプリ専用の見えない領域）。
     求める権限は drive.appdata だけ（利用者のほかのファイルには触れない）
   - ログインはGoogleの公式ライブラリ（GIS）。読み込むのは、利用者が
     「Googleドライブで同期」を押したときだけ（同期を使わない端末では読み込まない）
   - アクセストークン（約1時間で切れる）はメモリにだけ置き、保存しない
   - 保存先の操作は sync.js と同じ list / read / write / remove の4つ。
     ドライブは同じ名前のファイルを複数持てるため、名前 → ID の対応を一覧から作る
     （同じ名前が複数あれば、読むときは新しい方、書くときは1つに揃えて残りを消す）

   フールプルーフ：
     1) クライアントIDが未設定なら、ボタンを押してもログインに進まない
     2) 401（ログイン切れ）は、トークンを捨てて「もう一度同期を押す」よう表示する
     3) 429・5xx（混雑・一時的な障害）は、間隔を広げながら最大4回までやり直す
     4) 5MBを超えるファイルは分割アップロード（resumable）。セッションURLを
        受け取れなかったら、通常のアップロードに切り替える
   ===================================================================== */
(() => {
  'use strict';

  // Google Cloud で発行した OAuth クライアントID（秘密ではないので、ここに書いてよい）
  const CLIENT_ID = '';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const SMALL_UPLOAD_MAX = 5 * 1024 * 1024;
  const RETRY_MAX = 4;

  // 動作確認用：localhost で開いたときだけ、偽のドライブとトークンに差し替えられる
  // （公開サイトでは効かない）
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const testHook = isLocal && window.__SIDEOPS_DRIVE_TEST__ ? window.__SIDEOPS_DRIVE_TEST__ : null;
  const API = testHook ? String(testHook.apiBase).replace(/\/+$/, '') : 'https://www.googleapis.com';

  class DriveError extends Error {
    constructor(message, code) { super(message); this.code = code || 'error'; this.userFacing = true; }
  }

  let token = null; // { value, expiresAt }
  function tokenValid() { return !!token && Date.now() < token.expiresAt - 60 * 1000; }
  function configured() { return !!(CLIENT_ID || testHook); }

  let gisPromise = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (!gisPromise) {
      gisPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = GIS_SRC;
        s.async = true;
        s.onload = () => (window.google && window.google.accounts && window.google.accounts.oauth2 ? resolve() : reject(new DriveError('Googleのログイン部品を読み込めませんでした')));
        s.onerror = () => { gisPromise = null; reject(new DriveError('Googleのログイン部品を読み込めませんでした（ネットワークを確認してください）')); };
        document.head.appendChild(s);
      });
    }
    return gisPromise;
  }

  // ログインしてトークンを受け取る。ポップアップを開くため、ボタンを押した直後に呼ぶこと
  async function requestToken() {
    if (testHook) {
      if (testHook.failLogin) throw new DriveError('ログインを中止しました', 'login');
      token = { value: String(testHook.token), expiresAt: Date.now() + 3600 * 1000 };
      return token.value;
    }
    if (!CLIENT_ID) throw new DriveError('Googleドライブの設定（クライアントID）がまだありません', 'config');
    await loadGis();
    return new Promise((resolve, reject) => {
      const oauth2 = window.google.accounts.oauth2;
      const client = oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (!resp || resp.error) { reject(new DriveError('Googleドライブへのアクセスが許可されませんでした', 'login')); return; }
          if (!oauth2.hasGrantedAllScopes(resp, SCOPE)) { reject(new DriveError('Googleドライブへのアクセスが許可されませんでした', 'login')); return; }
          token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
          resolve(token.value);
        },
        error_callback: (err) => {
          const t = err && err.type;
          reject(new DriveError(t === 'popup_closed' ? 'ログインを中止しました'
            : t === 'popup_failed_to_open' ? 'ログイン画面を開けませんでした（ポップアップを許可してください）'
              : 'ログインに失敗しました', 'login'));
        },
      });
      client.requestAccessToken({ prompt: '' });
    });
  }
  function signOut() {
    const t = token;
    token = null;
    if (t && !testHook && window.google && window.google.accounts && window.google.accounts.oauth2) {
      try { window.google.accounts.oauth2.revoke(t.value, () => {}); } catch (err) { /* 取り消しに失敗しても、トークンは捨て済み */ }
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(method, url, { body, headers } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (!tokenValid()) throw new DriveError('Googleドライブのログインが切れました。もう一度「Googleドライブで同期」を押してください', 'login');
      let res;
      try {
        res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token.value, ...(headers || {}) }, body });
      } catch (err) {
        throw new DriveError('Googleドライブにつながりません（ネットワークを確認してください）', 'network');
      }
      if (res.status === 401) {
        token = null;
        throw new DriveError('Googleドライブのログインが切れました。もう一度「Googleドライブで同期」を押してください', 'login');
      }
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|limit/i.test(await res.clone().text().catch(() => '')));
      if (retryable && attempt < RETRY_MAX) {
        await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 300));
        continue;
      }
      if (!res.ok) throw new DriveError(`Googleドライブでエラーが起きました（${res.status}）`, 'http');
      return res;
    }
  }

  function createBackend() {
    let index = null; // 名前 → [{ id, modifiedTime(ms), size }]（新しい順）
    const newest = (name) => (index && index.get(name) ? index.get(name)[0] : null);
    async function ensureIndex() { if (!index) await list(); }
    async function list() {
      const map = new Map();
      let pageToken = '';
      do {
        const u = new URL(API + '/drive/v3/files');
        u.searchParams.set('spaces', 'appDataFolder');
        u.searchParams.set('fields', 'nextPageToken,files(id,name,size,modifiedTime)');
        u.searchParams.set('pageSize', '1000');
        if (pageToken) u.searchParams.set('pageToken', pageToken);
        const j = await (await api('GET', u.toString())).json();
        for (const f of j.files || []) {
          if (!f || typeof f.id !== 'string' || typeof f.name !== 'string') continue;
          if (!map.has(f.name)) map.set(f.name, []);
          map.get(f.name).push({ id: f.id, modifiedTime: Date.parse(f.modifiedTime) || 0, size: Number(f.size) || 0 });
        }
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      map.forEach((arr) => arr.sort((a, b) => b.modifiedTime - a.modifiedTime));
      index = map;
      return Array.from(map.keys());
    }
    async function read(name) {
      await ensureIndex();
      const e = newest(name);
      if (!e) return null;
      const res = await api('GET', `${API}/drive/v3/files/${encodeURIComponent(e.id)}?alt=media`);
      return new Uint8Array(await res.arrayBuffer());
    }
    function remember(name, meta) {
      const entry = { id: meta.id, modifiedTime: Date.parse(meta.modifiedTime) || Date.now(), size: Number(meta.size) || 0 };
      index.set(name, [entry]);
    }
    async function uploadResumable(method, url, metadata, bytes) {
      const init = await api(method, url, {
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(bytes.length) },
        body: JSON.stringify(metadata),
      });
      const session = init.headers.get('Location');
      if (!session) return null; // セッションURLを読めない環境 → 通常のアップロードに切り替える
      const res = await api('PUT', session, { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      return res.json();
    }
    async function write(name, bytes) {
      await ensureIndex();
      const existing = index.get(name) || [];
      const fields = 'fields=id,name,size,modifiedTime';
      let meta = null;
      if (existing.length) {
        const id = encodeURIComponent(existing[0].id);
        if (bytes.length > SMALL_UPLOAD_MAX) meta = await uploadResumable('PATCH', `${API}/upload/drive/v3/files/${id}?uploadType=resumable&${fields}`, {}, bytes);
        if (!meta) {
          meta = await (await api('PATCH', `${API}/upload/drive/v3/files/${id}?uploadType=media&${fields}`, { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json();
        }
        // 同じ名前のファイルが複数あれば（書き込みの途中で止まった等）、1つに揃える
        for (const extra of existing.slice(1)) {
          try { await api('DELETE', `${API}/drive/v3/files/${encodeURIComponent(extra.id)}`); } catch (err) { /* 次の同期で再び揃える */ }
        }
      } else {
        const metadata = { name, parents: ['appDataFolder'] };
        if (bytes.length > SMALL_UPLOAD_MAX) meta = await uploadResumable('POST', `${API}/upload/drive/v3/files?uploadType=resumable&${fields}`, metadata, bytes);
        if (!meta) {
          const boundary = 'sideops' + Math.random().toString(36).slice(2);
          const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
            `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, bytes, `\r\n--${boundary}--`,
          ]);
          meta = await (await api('POST', `${API}/upload/drive/v3/files?uploadType=multipart&${fields}`, { headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
        }
      }
      if (!meta || typeof meta.id !== 'string') throw new DriveError('Googleドライブへの保存に失敗しました', 'http');
      remember(name, meta);
    }
    async function remove(name) {
      await ensureIndex();
      for (const e of index.get(name) || []) {
        await api('DELETE', `${API}/drive/v3/files/${encodeURIComponent(e.id)}`);
      }
      index.delete(name);
    }
    // ファイルが最後に書き換えられてからの時間（使わなくなった画像を、猶予を置いて片付けるため）
    function ageMs(name) {
      const e = newest(name);
      return e ? Date.now() - e.modifiedTime : 0;
    }
    // 保存先でのファイルの状態（更新時刻と大きさ）。中身の変わっていないファイルを書き直さないために使う
    function stamp(name) {
      const e = newest(name);
      return e ? e.modifiedTime + ':' + e.size : '';
    }
    return { kind: 'gdrive', list, read, write, remove, ageMs, stamp };
  }

  window.SideOpsSyncDrive = { configured, tokenValid, requestToken, signOut, createBackend, DriveError, isTest: !!testHook };
})();
