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
- 個別アプリ：`apps/*.html`（Stage に iframe で読み込む）。カバー画像は `apps/img/`
- 本体テーマをアプリに伝える仕組み：`apps/sideops-theme-bridge.js`（postMessage）
- 永続化はすべて IndexedDB（DB名は `sideops_*`）

## 運用ルール

- 仕様変更・機能追加をしたら、該当する `docs/` の仕様書と変更履歴も同じ作業の中で更新する
- 実装したら必ず push まで行う（未 push のままセッションが終わってコードが消えた前例あり）
- 動作確認は `file://` で直接開かない（IndexedDB が動かない）。ローカルサーバーか GitHub Pages で確認する
- コミットメッセージは `feat:` / `fix:` / `docs:` / `add:` などの接頭辞と日本語で書く
