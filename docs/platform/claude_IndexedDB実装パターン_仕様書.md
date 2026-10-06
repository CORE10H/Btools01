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

`sideops_launcher`（カバーフロー）・`sideops_settings`（設定）・`sideops_log`（LOG）・`sideops_sync`（同期の管理用：端末ID・鍵・前回同期した時点の状態・競合の控え・同期の記録）と、各アプリ専用のもの（`sideops_memo`・`sideops_prompt_gallery`・`sideops_prompt_gallery_red`・`sideops_scaffold`・`sideops_discotica`・`sideops_donemore`・`sideops_scribit`・`sideops_manuscript`・`sideops_mindframe`・`sideops_recon`等）。

**同期との関係（2026-10-05〜）**：同期（`js/sync.js`）は「DBを機能ごとに独立させる」原則の唯一の例外で、許可リスト（`DB_RULES`）にあるDBを直接読み書きする。新しいアプリを作ったら`DB_RULES`に足す。`DB_VERSION`やレコードの項目を変えたら、`DB_RULES`の`version`と`SYNC_APP_BUILD`を上げる（`planning/claude_クラウド同期_仕様書.md`の「開発時の決まり」）。同期は、端末にないDBを作るときに、同期ファイルに記録されたストア・キー・索引の形で作る。また2026-10-06から、アプリの書き込みには`apps/sideops-theme-bridge.js`が「変えたよ」の印を付ける（`IDBObjectStore`の書き込み用の関数を包む）。新しいアプリでもこのファイルを読み込むこと（`core/claude_テーマブリッジ_仕様書.md`）。そのため、アプリの`onupgradeneeded`で作るストアの形と、DBの版は対応させたままにする。

`sideops_mindframe`（MINDFRAME）は、このパターンに加えて**保存直前の衝突確認**を持つ：保存の前にDBの`updatedAt`を読み、自分が読み込んだ（または最後に保存した）時点より新しければ、別のタブが保存したとみなして黙って上書きしない（どちらを残すか確認する）。同じデータを複数のタブで開ける機能を作るときの参考にする。

## 一括取込の型：1トランザクション＋`add`（RECONで採用）

CSV取込のように「数十〜数百件をまとめて書き、1件でも失敗したら全部なかったことにしたい」場合の型。

```js
const tx = db.transaction(['transactions', 'imports'], 'readwrite');
const done = new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error('中断されました'));
});
try {
  const store = tx.objectStore('transactions');
  records.forEach((rec) => store.add(rec)); // put ではなく add
  tx.objectStore('imports').add(importRecord);
} catch (syncErr) {
  try { tx.abort(); } catch (e) { /* すでに終了 */ }  // 途中で例外→積んだ分も含めて全部取り消す
}
await done; // 失敗時はここで例外になる（何も保存されていない）
```

**ポイント**：

- `put`ではなく`add`を使う。同じ主キーがすでにあれば、その書き込みが失敗してトランザクション全体が中止される＝別タブなどとの競合でも二重登録が起きない
- `add`などを積んでいる途中で同期的な例外（不正なキー等）が出た場合、何もしないとそれまでに積んだ分だけが確定してしまう。catchで明示的に`abort()`する
- 取り消し（取込1回分の削除）も同じく1トランザクションで行う。取込ごとのID（`importId`）に索引を張っておき、`index('importId').getAllKeys(id)`で主キーを集めて削除する
- 重複判定は保存前にも行う（確認画面で「取込済み」を見せるため）が、最後の砦は`add`の一意制約

## 今後の検討：共通化するかどうか

現状は「似た内容を毎回コピーして機能ごとに独立させる」方針を取っている。これは各アプリ・機能が完全に独立して壊れにくい反面、同じコードが複数箇所に散らばる。改修対象が増えてきたら、`js/main.js`とは別に共通ユーティリティファイル（例：`js/idb-helper.js`）を切り出し、各アプリ・各機能から読み込む形への集約を検討してもよい（ただし今のところ「別ファイル化する複雑さ」と「コピーのシンプルさ」を比べて後者を優先している）。
