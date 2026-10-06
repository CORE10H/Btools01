# アプリ：画像生成プロンプト見本一覧 RED（`apps/prompt-gallery-red.html`）仕様書

## 概要

PROMPTGALLERY（`apps/prompt-gallery.html`）の微調整版。機能・画面構成・データ構造・フールプルーフは本家と完全に同一で、差分は「強調色の配色」と「データの独立」の2点のみ。詳細な仕様は`アプリ_プロンプトギャラリー_仕様書.md`を参照すること（本ファイルには差分のみを記載する）。

## 本家との差分

### 1. 配色（アプリ固有・テーマブリッジ非追従）

本家は強調色に`--cyan`系（本体テーマのシアン）を使い、`sideops-theme-bridge.js`経由で本体のテーマ変更に追従する。RED版はこの部分だけ切り離し、常に赤で固定表示する。

- `:root`に`--brand-accent`（`#ff2d3c`）・`--brand-accent-dim`（`#4a0a10`）・`--brand-accent-rgb`（`255, 45, 60`）を新設し、本家で`var(--cyan)`・`var(--cyan-dim)`・`var(--cyan-rgb)`を参照していた全箇所（36箇所）をこの新変数に置換した
- `--cyan`系の変数自体は`:root`に残しているが、CSS側からは一切参照していない。そのため、テーマブリッジが本体のテーマ変更を受けて`--cyan`を上書きしても、画面の見た目には影響しない（実機検証済み：ダーク／ライト／ビビッドいずれのテーマでも`--brand-accent`は`#ff2d3c`のまま変化しない）
- 背景・パネル・文字色などその他の色は`--bg`・`--panel`・`--text`等を通常通り使用しており、本体テーマに追従する。**固定なのは強調色（赤）のみ**
- この配色は「PROMPTGALLERY REDというアプリ固有の色」という位置づけで、DONE MOREのプロジェクト色やタグの色と同様、テーマ連携の対象外として扱う（`テーマブリッジ_仕様書.md`の「プロジェクト色・ユーザーが付けたタグ色などアプリ固有の色は対象外」という整理に準ずる）

### 2. データの独立

DB名は`sideops_prompt_gallery_red`。本家（`sideops_prompt_gallery`）とは完全に別のIndexedDBで、データは一切共有しない。

### 3. 表示名・カバー画像

- ヘッダー表記：`// PROMPT GALLERY RED`
- `<title>`：「画像生成プロンプト見本一覧 RED」
- カバー画像：`apps/img/prompt-gallery-red.jpg`（本家の`prompt-gallery.jpg`とは別画像）

## 作り方（2026-10-06〜）：本家から機械的に作る

RED版は、本家（`apps/prompt-gallery.html`）に次の置き換えをしただけのものになっている（2026-10-06に確認：置き換えた結果がRED版と1バイトも違わない）。そのため、**機能の改修は本家だけに行い、RED版は本家から作り直す**。手で両方を直すと食い違いが出やすいため。

- 置き換え：`<title>`と`// PROMPT GALLERY`に「RED」を付ける／`:root`の`--cyan-dim`の次に`--brand-accent`系の3つを足す／CSS・JSの`var(--cyan)`・`var(--cyan-dim)`・`rgba(var(--cyan-rgb)`を`--brand-accent`系に替える／DB名を`sideops_prompt_gallery_red`にする
- 道具：`D:\dev\sideops_sync_verify\mkred.pl`（Git Bashのperl）。`perl mkred.pl < apps/prompt-gallery.html > apps/prompt-gallery-red.html`
- 本家で新しく強調色を使うときも`var(--cyan)`等で書けば、RED版では自動で赤になる
- 動作確認は`D:\dev\sideops_sync_verify\gallery_e2e.dart`が本家とRED版の両方を確かめる
