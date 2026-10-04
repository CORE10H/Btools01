# 動作確認時の注意点（ローカル環境・ブラウザ機能の制限）仕様書

「見た目は正しく実装できているのに、確認方法が原因で動いていないように見える」パターンに関する知見。ブラウザのセキュリティ制限に関わる機能（ストレージ・クリップボード・カメラ／マイク等）を追加する際は、まずここを疑うこと。

## `file://`直接オープンではIndexedDBが使えない（ブラウザ依存）

**現象**：`apps/prompt-gallery.html`等をローカルのファイルシステムからダブルクリックで直接開く（アドレスバーが`file:///C:/...`のような表示になる）と、「保存機能を利用できません」の初期化失敗メッセージが最初から表示される。

**原因**：Edge/Chromium系ブラウザは、`file://`オリジンに対してIndexedDB等のストレージAPIの利用を許可しない仕様になっている（セキュリティ上の制約）。Firefoxなど一部ブラウザでは動作することがあるため、ブラウザによって挙動が割れる点にも注意。

**対策・確認方法**：

- 最も確実なのは、実際にGitHub Pages（`https://core10h.github.io/Btools01/`）にpushしてHTTPS環境で確認すること
- ローカルで素早く試したい場合は、`python3 -m http.server`等でローカルサーバーを立て、`http://localhost:xxxx`経由でアクセスする（`file://`ではなく`http://`にする）
- ダブルクリックでの直接オープンは、どのアプリを実装する場合も動作確認の手段として使わないこと

## ブラウザ機能を使う実装は「配信方法込み」で動作確認する

IndexedDBに限らず、以下のようなAPIも`file://`環境やHTTP（非HTTPS）環境では制限・無効化されることがある：

- `navigator.clipboard`（クリップボードAPI）：HTTPSまたはlocalhostでのみ動作
- Service Worker、通知API、位置情報APIなど

**方針**：新しい機能を「実装できた」と判断する前に、必ず実際の配信環境（GitHub Pagesまたはローカルサーバー）で一度動作確認してから完成報告する。

## このPCで自動操作して確認する方法（ヘッドレスEdge＋CDP）

2026-09-30時点、ローカルPC（`D:\dev`）には Python・Node.js が入っていない（`python`はMicrosoft Storeへの誘導だけ）。Playwrightの代わりに、次の組み合わせで自動操作・画面の撮影をした（MINDFRAMEの検証で使用）。

- **ローカルサーバー**：Flutterに同梱のDart（`C:\flutter\bin\cache\dart-sdk\bin\dart.exe`）で、`dart:io`の`HttpServer`を使った数十行の静的ファイルサーバーを書いて起動する（`localhost`限定、`..`を含むパスは拒否、キャッシュ無効）
- **ブラウザ**：Microsoft Edge（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）を`--headless=new --remote-debugging-port=<番号> --user-data-dir=<使い捨てのフォルダ>`で起動。使い捨てのフォルダにすれば毎回IndexedDBが空の状態から試せる
- **操作**：Dartの`WebSocket`でChrome DevTools Protocolに接続し、`Input.dispatchMouseEvent`（クリック・ドラッグ・ホイール）、`Input.dispatchKeyEvent`（キー）、`Input.insertText`（文字入力）、`Input.imeSetComposition`→`insertText`（日本語入力の変換中→確定）、`Input.dispatchTouchEvent`＋`Emulation.setTouchEmulationEnabled`（タップ・ピンチ）、`Page.captureScreenshot`（撮影）、`Browser.setDownloadBehavior`（書き出したファイルの受け取り）、`DOM.setFileInputFiles`（ファイル選択欄への指定）を使う
- **iframeの中（Stage）**：同じオリジンなので、親ページから`iframe.contentDocument`で中の要素の位置を取り、ページ全体の座標に足してクリックできる
- **端末2台の受け渡し（同期）**：使い捨てプロファイルのEdgeを2つ（別々のポート・別々の`--user-data-dir`）立ち上げ、同じローカルサーバーを開くと、IndexedDBが別々の「端末A・B」になる。`Target.createTarget`で同じブラウザにタブを足せば「他のタブで開いている」状態も作れる。端末の時計のずれは`Page.addScriptToEvaluateOnNewDocument`で`Date.now`を置き換えて再現する。キットは`D:\dev\sideops_sync_verify\`（`planning/claude_クラウド同期_仕様書.md`の「動作確認」）
- **ログインが要る外部サービス（Googleドライブ）**：本物にはログインできないので、同じ形の要求・応答を返す偽のサーバー（Dartの`HttpServer`。CORSの応答も付ける）を別のポートで立て、ページの読み込み前に`Page.addScriptToEvaluateOnNewDocument`で差し替え用の変数を入れる。差し替えはlocalhostのときだけ効くようにしておく（公開サイトでは効かない）。画面を離れた・戻ったことは、`document.visibilityState`を上書きして`visibilitychange`を起こして再現する

Claude Code デスクトップの内蔵ブラウザ（Browser pane）は、画面に表示していない間は`requestAnimationFrame`が止まり、スクリーンショットも画面の一部しか写らない（表示倍率136%の環境で確認）。描画を`requestAnimationFrame`でまとめているアプリの確認には、上のヘッドレスEdgeを使う方が確実。

## ポインタを捕まえる（setPointerCapture）と click・dblclick の対象が変わる

ドラッグ操作のために`pointerdown`で`setPointerCapture`を呼ぶと、その後の`click`・`dblclick`の`target`は、実際に指・カーソルの下にある要素ではなく**捕まえた要素**になる（Pointer Eventsの仕様どおりの動き）。MINDFRAMEでは、線やノードをダブルクリックしても`target`が常にキャンバス（`<svg>`）になり、「空白をダブルクリックした」扱いになる不具合が出た。

**対策**：`dblclick`の中では`document.elementFromPoint(e.clientX, e.clientY)`で実際に下にある要素を調べて判定する。自前のダブルタップ判定（`pointerup`で行う）も同様。
