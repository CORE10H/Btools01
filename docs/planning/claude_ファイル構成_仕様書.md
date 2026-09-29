# ファイル構成 仕様書

## 現在の構成

```
sideops/
├── index.html   # HTML骨格。link/scriptタグで下記2ファイルを参照。
│                 # カバーフロー用の新規作成モーダル・削除確認ダイアログも含む
├── style.css    # 全スタイル・CSS変数・テーマ定義・ランチャー機能拡張分
├── js/
│   └── main.js  # 時計・ヘッダーアイコン・設定モーダル・透過率・壁紙・
│                 # テーマ（基本色＋派生色・テーマブリッジ送信）・
│                 # スポイト・カバーフロー（アプリランチャー、
│                 # cards/apps分離のIndexedDB駆動）・アンビエントFX
└── apps/
    ├── img/                    # 各アプリのカバー画像（BUILTIN_APP_CHOICESのcoverImgとして
    │                            # 「＋新規作成」プルダウン選択時に自動読込される。coverImg未設定の
    │                            # アプリ（blank等）は対象外）
    │   ├── prompt-gallery.jpg
    │   ├── prompt-gallery-red.jpg
    │   ├── manuscript.jpg
    │   ├── memo.jpg
    │   ├── discotica.jpg
    │   ├── done-more.jpg
    │   ├── scribit.jpg
    │   └── scaffold.jpg
    ├── sideops-theme-bridge.js  # テーマブリッジの受信側共通スクリプト。各アプリが
    │                            # <head>で1行読み込むopt-in方式
    ├── prompt-gallery.html      # 画像生成プロンプト見本一覧（本実装済み）
    ├── prompt-gallery-red.html  # PROMPTGALLERYの微調整版（本実装済み。機能は本家と同一、
    │                            # 強調色のみアプリ固有の赤に固定・データも独立）
    ├── manuscript.html      # AI執筆特化の小説制作アプリ（本実装済み）
    ├── scaffold.html        # AIのべりすと執筆支援ツール（本実装済み・push済み）
    ├── memo.html            # メモアプリ（本実装済み）
    ├── discotica.html       # 音楽プロジェクト管理アプリ（本実装済み）
    ├── done-more.html       # タスク＆ガントチャート管理アプリ（本実装済み）
    ├── scribit.html         # AI代書支援ツール（本実装済み・push済み）
    └── blank.html           # 用途未定の予備枠（現状ダミーページ）
```

単一HTML（`dashboard5.html`）だった旧構成から、機能追加のしやすさを優先して3ファイル（`index.html`/`style.css`/`js/main.js`）に分割。分割時に機能面の変更は行っていない。

## 公開・運用

- GitHubリポジトリ：`CORE10H/Btools01`
- 公開URL：`https://core10h.github.io/Btools01/`（GitHub Pages）
- 以降の改修は、このリポジトリの該当ファイルを直接更新する運用

### GitHub作業の運用ルール

- 2026-09-27以降、作業はローカルPC（`D:\dev\Btools01`）上のClaude Code（デスクトップアプリのCodeタブ）で行う
- GitHubへの認証はGitHub CLI（`gh`）で`CORE10H`アカウントにログイン済み。Claudeがそのままclone/pushできるため、セッションごとのPAT発行・失効は不要になった
- pushは`CORE10H`アカウントで行うこと（`yoshimitsu08`アカウントではcloneはできてもpushが403で拒否される）

## ファイル状態の凡例（変更履歴での表記）

- **本実装済み・push済み**：GitHub Pagesの公開版に反映されている
- **未push**：ローカルの一時的な作業領域にのみ存在し、セッション終了で失われる可能性がある状態
- **コード消失**：一度実装されたが、pushされないままセッション終了で失われたことが確認された状態（例：インターネットショートカット機能。`アプリランチャー_仕様書.md`参照）

現時点でのファイル別状態は`SIDE-OPS_変更履歴.md`の最新行を参照。全builtinアプリ（blankを除く）のカバー画像が揃っている。

## 開発ナレッジ（docs/）について

仕様書・設計資料は本リポジトリの`docs/`配下（`apps/` `core/` `platform/` `planning/` `history/`の5フォルダ）で管理している。claude.aiの「プロジェクトの知識」欄はClaudeが直接書き込めないため使用しない（経緯・仕分けルールは`docs/README.md`参照）。
