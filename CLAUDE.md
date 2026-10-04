# SIDE-OPS（Btools01）

ブラウザで動くダッシュボード兼アプリランチャー「SIDE-OPS」。ビルド不要の素のHTML/CSS/JS。
GitHub Pages で公開：https://core10h.github.io/Btools01/

## 最初に読むもの

- 開発ナレッジは `docs/` 配下に一元化されている。仕分けルールは `docs/README.md`
- 経緯は `docs/history/claude_SIDE-OPS_変更履歴.md`（時系列・1行要約）
- 影響範囲の確認は `docs/planning/claude_機能間依存関係マップ.md`
- 作業対象の機能に対応する仕様書（`docs/apps/` または `docs/core/`）を読んでから触る

## 構成

- 本体：`index.html` / `style.css` / `js/main.js`
- 同期（複数端末）：`js/sync.js`。設計は `docs/planning/claude_クラウド同期_仕様書.md`
- 個別アプリ：`apps/*.html`（Stage に iframe で読み込む）。カバー画像は `apps/img/`
- 本体テーマをアプリに伝える仕組み：`apps/sideops-theme-bridge.js`（postMessage）
- 永続化はすべて IndexedDB（DB名は `sideops_*`）

## 運用ルール

- 機能の改修・新設が完了したら、確認を待たずに制作資料（`docs/` の該当する仕様書と変更履歴）を更新して push する
- 実装したら必ず push まで行う（未 push のままセッションが終わってコードが消えた前例あり）
- 動作確認は `file://` で直接開かない（IndexedDB が動かない）。ローカルサーバーか GitHub Pages で確認する
- コミットメッセージは `feat:` / `fix:` / `docs:` / `add:` などの接頭辞と日本語で書く
- 同期の決まり：アプリの `DB_VERSION` を上げたら `js/sync.js` の `DB_RULES` の `version` と `SYNC_APP_BUILD` も上げる。レコードの項目を変えたら `SYNC_APP_BUILD` を上げる。新しいアプリ（DB）を足したら `DB_RULES` に足す。同期まわりを変えたら `D:\dev\sideops_sync_verify\sync_e2e.dart` で確認する
