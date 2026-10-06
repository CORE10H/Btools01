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
- 同期（複数端末）：`js/sync.js`（本体）・`js/sync-onedrive.js`（OneDrive）・`js/sync-gdrive.js`（Googleドライブ）。設計は `docs/planning/claude_クラウド同期_仕様書.md`
- 戻る操作（モーダル・Stageを1つずつ閉じる）：`js/back-nav.js`。ホーム画面に追加したときの設定：`manifest.webmanifest`・`icons/`
- 個別アプリ：`apps/*.html`（Stage に iframe で読み込む）。カバー画像は `apps/img/`
- 本体テーマをアプリに伝える仕組み：`apps/sideops-theme-bridge.js`（postMessage）
- 永続化はすべて IndexedDB（DB名は `sideops_*`）

## 運用ルール

- 機能の改修・新設が完了したら、確認を待たずに制作資料（`docs/` の該当する仕様書と変更履歴）を更新して push する
- 実装したら必ず push まで行う（未 push のままセッションが終わってコードが消えた前例あり）
- 動作確認は `file://` で直接開かない（IndexedDB が動かない）。ローカルサーバーか GitHub Pages で確認する
- コミットメッセージは `feat:` / `fix:` / `docs:` / `add:` などの接頭辞と日本語で書く
- 新しいアプリ（`apps/*.html`）は、必ず `<head>` の早い位置で `sideops-theme-bridge.js` を読み込む（テーマのため、同期の「変えたよ」の印のため、スマホの戻るボタンでアプリのモーダルを閉じるため。読み込まないと、そのアプリの変更は☁を押すまで同期されない）
- アプリのモーダルは `.modal-overlay` 等に `is-open` を付けて開き、背景のクリック・Esc で閉じられるようにする（戻るボタンで閉じる仕組みがこれを使う。`docs/core/claude_メインステージ_仕様書.md`「戻る操作」）。アプリの中で `history.pushState` や `location.hash` を使わない
- PROMPTGALLERY RED（`apps/prompt-gallery-red.html`）は手で直さず、本家を直してから `D:\dev\sideops_sync_verify\mkred.pl` で作り直す
- 画像を決まった比率の枠に入れて出すとき（カバー・表紙など）は、`apps/sideops-frame.js`（見え方の共通部品）を使い、見え方（`{ ar, z, cx, cy }`）をレコードに保存する。値の意味は変えない（保存済みの見え方がずれる）
- 同期の決まり：アプリの `DB_VERSION` を上げたら `js/sync.js` の `DB_RULES` の `version` と `SYNC_APP_BUILD` も上げる。レコードの項目を変えたら `SYNC_APP_BUILD` を上げる。新しいアプリ（DB）を足したら `DB_RULES` に足す。同期まわりを変えたら `D:\dev\sideops_sync_verify\` の `sync_e2e.dart`（同期ファイル）・`onedrive_e2e.dart`（OneDrive。偽のMicrosoftを使う）・`drive_e2e.dart`（Googleドライブ。偽のドライブを使う）で確認する。戻る操作・全画面まわり（`js/back-nav.js`・`js/main.js`・テーマブリッジ）を変えたら `backnav_e2e.dart`・`backsweep.dart` で確認する（ほかの道具は `docs/platform/claude_動作確認の注意点_仕様書.md`）
