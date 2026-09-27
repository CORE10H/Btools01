# IndexedDB機能実装の定型パターン 仕様書

似た内容の改修（プロンプトギャラリー→メモ→Discotica→通知パネルの外部連携→DONE MORE→SCRIBIT）が繰り返し発生したため、共通するパターンを抽出したもの。新しい機能（新しいアプリ、新しい永続化データ）を追加する際は、これを土台にすると実装が速い。

## DB初期化：Promiseラッパーの型

```js
const DB_NAME = 'sideops_xxx';      // アプリ・機能ごとに一意な名前
const DB_VERSION = 1;
const STORE = 'items';              // ストア名は機能に応じて命名
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const _db = ev.target.result;
      if (!_db.objectStoreNames.contains(STORE)) {
        _db.createObjectStore(STORE, { keyPath: 'id' });
      }
      // 設定を分けて持ちたい場合は SETTINGS_STORE も同様に追加
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

**ポイント**：

- DB名は機能ごとに完全に独立させる（他アプリのデータへ誤ってアクセスする手段自体を作らない設計にする。アプリ管理画面の削除仕様もこの独立性を前提にしている）
- ストアのキーは基本的に`keyPath: 'id'`で統一。設定値だけを別に持ちたい場合は`keyPath: 'key'`の`settings`ストアを追加する（`{ key: 'sourceUrl', value: ... }`のような形）

## CRUD操作：get/getAll/put/delete/clearの最小セット

```js
function store(name, mode) {
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}
function getAll(name) {
  return new Promise((resolve, reject) => {
    const req = store(name, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function put(name, value) {
  return new Promise((resolve, reject) => {
    const req = store(name, 'readwrite').put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function del(name, id) {
  return new Promise((resolve, reject) => {
    const req = store(name, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
```

新しい機能を作るたびにこれをゼロから書き直しているので、関数名の頭に機能名を付けて（`logGetAll`・`launcherGetAll`等）名前衝突を避けつつ、中身はコピーして使う運用でよい（共通モジュール化は見送り中。「共通化するかどうか」節参照）。

## 初期化〜初回描画〜フォールバックの型

DBを開く→データを読み込む→画面に描画する、という流れも毎回同じ形。**失敗時にダッシュボード全体を落とさず、その機能だけ空表示にフォールバックする**のが必須パターン。

```js
openDb().then(async (_db) => {
  db = _db;
  await loadData();      // getAllで読み込み、変数に格納
  render();              // 画面に反映
}).catch((err) => {
  console.error('◯◯用DBの初期化に失敗しました', err);
  // 空データでフォールバック。例外を投げっぱなしにしない。
  items = [];
  render();
});
```

## フールプルーフの定番セット

新しい永続化機能を追加するたびに、以下は毎回検討すること：

- **DB初期化失敗時のフォールバック**：空データで安全に描画
- **書き込み失敗の握りつぶし**：1件の`put`/`delete`が失敗しても、ループ全体を巻き込んで落とさない（`try/catch`で個別に握る）
- **不正データのバリデーション**：外部由来・ユーザー入力由来のデータは、保存前に型・必須項目をチェックし、不正なものは1件ずつスキップする
- **表示は`textContent`のみ**：動的に生成した文字列を画面に出す箇所は、`innerHTML`を使わず`textContent`で挿入する（XSS対策）
- **保持件数の上限**：際限なく増え続けるデータ（通知・ログ等）は上限件数を決め、超えたら古いものから自動的に間引く
- **重複防止**：一意なキー（`id`）で重複を排除する。IDが空/未設定のデータは受け付けない

## 現在稼働中のIndexedDB一覧

`sideops_launcher`（カバーフロー）・`sideops_settings`（設定）・`sideops_log`（LOG）と、各アプリ専用のもの（`sideops_memo`・`sideops_prompt_gallery`・`sideops_discotica`・`sideops_donemore`・`sideops_scribit`等）。

## 今後の検討：共通化するかどうか

現状は「似た内容を毎回コピーして機能ごとに独立させる」方針を取っている。これは各アプリ・機能が完全に独立して壊れにくい反面、同じコードが複数箇所に散らばる。改修対象が増えてきたら、`js/main.js`とは別に共通ユーティリティファイル（例：`js/idb-helper.js`）を切り出し、各アプリ・各機能から読み込む形への集約を検討してもよい（ただし今のところ「別ファイル化する複雑さ」と「コピーのシンプルさ」を比べて後者を優先している）。
