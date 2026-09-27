# 3D変形とスタッキングコンテキスト 仕様書

対象：カバーフロー・Stage・設定モーダル等、3D傾斜や重なり順（z-index）に関わる技術基盤。

## 3D傾斜の実装

左カラム（カバーフロー・タスク）と右カラム（INTEL・LOG）に`perspective`+`rotateY`をかけ、画面端が手前、中央のStageに向かって奥にすぼまる遠近感を演出。

```css
.shell { perspective: 1400px; perspective-origin: 50% 50%; }
.left-col  { transform: rotateY(50deg);  transform-origin: right center; }
.right-col { transform: rotateY(-50deg); transform-origin: left center; }
```

軸（`transform-origin`）はStage側の内側の端に置く。外側の端を軸にすると傾きの向きが逆になる。3D傾斜角度は50度に固定（可変UIなし）。

## 3D変形要素はクリック・ホイール判定がズレる

**現象**：`rotateY`や`rotateX`で3D変形された要素の内部に配置したボタンやリンクは、見た目の位置にマウスを持っていっても`click`や`wheel`イベントが発火しないことがある。

**原因**：`getBoundingClientRect()`が返す座標は3D変形前のレイアウト計算結果であり、実際に画面に描画されている位置とズレる。`elementFromPoint()`で実際にその座標にある要素を調べると、期待した要素ではなく別の（変形されていない）祖先要素がヒットする。

**対策パターン**：

1. 単純な固定UI（ボタン・ラベル）→ 3D変形コンテキストの外側に`position: fixed`で独立配置し、画面座標を直接指定する
2. 中央バナーのクリック判定など、3D要素と重なる必要があるもの → 3D変形の外側に透明な当たり判定用オーバーレイを重ね、位置は固定ピクセル値ではなくJSで動的計算する

## 固定ピクセル座標は解像度が変わると破綻する

ウィンドウサイズが変わるとCSS Gridの`1fr`行（Stage行）の高さが変わり、カバーフロー自体の表示位置も変わるため、固定ピクセル値では別解像度でズレる。

**解決策**：3D変形されていない祖先要素（`.coverflow-v`）の`getBoundingClientRect()`を基準点として使う。

```js
const r = coverflowVEl.getBoundingClientRect();
const cx = r.left + r.width / 2;
const cy = r.top + r.height / 2;
const w = r.width;
const h = w * 9 / 16; // banner の aspect-ratio: 16/9 に合わせる
openHitEl.style.left = (cx - w / 2) + 'px';
openHitEl.style.top  = (cy - h / 2) + 'px';
openHitEl.style.width  = w + 'px';
openHitEl.style.height = h + 'px';
```

`positionOpenHit()`を初期化時と`window.addEventListener('resize', ...)`の両方で呼び出すことで、あらゆるウィンドウサイズで追従する。

## 透明な当たり判定オーバーレイは、独立したスタッキングコンテキストの子要素より必ず手前に来る

**現象**：`#cfOpenHit`（中央カード全体を覆う`position: fixed`の透明オーバーレイ）を導入した後、カード自体に削除ボタン（🗑）を追加したところ、ボタンの`z-index`をいくら上げてもクリックできない。

**原因**：`#cfOpenHit`は`position: fixed`で、3D変形されたカード（`.cf-item`、`position: absolute`）とは全く別の独立したスタッキングコンテキストに属している。スタッキングコンテキストが異なる要素同士は、子要素の`z-index`をどれだけ大きくしても比較対象にならない。

**対策**：`z-index`による解決を諦め、`#cfOpenHit`のクリックハンドラ内で、クリック座標が削除ボタンの実際の画面上矩形（`getBoundingClientRect()`）と重なっているかを判定し、重なっていれば削除ボタン側の`.click()`を代わりに発火させる。

```js
openHitEl.addEventListener('click', (ev) => {
  const centerEl = track.querySelector('.cf-item.is-center .cf-item-delete-btn');
  if (centerEl) {
    const r = centerEl.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
      centerEl.click();
      return;
    }
  }
  // ...通常のカードオープン処理
});
```

この問題は`:hover`にも同様に及ぶ。対策は、クリック時と同じ座標判定ロジックを`#cfOpenHit`の`mousemove`／`mouseleave`イベントでも行い、判定結果に応じてJS側で`.is-hover-forced`のようなクラスを付け外しし、CSS側で`:hover`と`.is-hover-forced`の両方に同じスタイルを当てる。

**設計ルール**：この種の透明オーバーレイに覆われた要素へ後から新しい操作可能要素（ボタン等）を追加する場合、単純な`z-index`調整では対処できないことを前提に設計する。座標判定によるクリック委譲、またはオーバーレイ側に穴あけ領域を持たせる設計を検討すること。

## `perspective`を持つ祖先要素もスタッキングコンテキストを分離する

**現象**：STAGE（`#stageEl`）や設定モーダル（`.settings-overlay`）を`position: fixed`のフルスクリーンオーバーレイにし、`z-index`を`.shell`外の固定要素より確実に大きい値に設定したにもかかわらず、それらの要素が透けて手前に見えてしまう。

**原因**：`.shell`（Gridのルート要素）に`perspective: 1400px`が指定されており、これが新しいスタッキングコンテキストを生成する。対象要素が`.shell`の内側（子要素）に配置されていると、その`z-index`は「`.shell`が作るスタッキングコンテキストの中でのみ」意味を持ち、`.shell`の外側にある要素とは直接比較されない。

**対策**：対象要素をDOM構造ごと`.shell`の外側（`.cf-head-fixed`等と同じ階層）に移動する。

**設計ルール**：`transform`だけでなく`perspective`もスタッキングコンテキストを生成しうる。画面全体を覆うオーバーレイ（モーダル・ダイアログ・Stage）を新しく追加するときは、最初から`.shell`の外に置く。z-indexの数値だけでなく、スタッキングコンテキストの生成元（祖先要素）を疑う視点を持つこと。

## 検証時の注意（自動テストツール特有の制約）

Playwright等のヘッドレスブラウザで`page.mouse.click(x, y)`のような座標指定クリックを行うと、3D変形要素に対しては正しく反応しないことがある。検証時は以下のいずれかの手順を踏む：

- 対象要素の`getBoundingClientRect()`を都度取得してから、その中心座標をクリックする
- 3D変形の外側にある要素（対策後の透明ボタンなど）を直接クリックする

カバーフロー内のボタン（削除ボタン等）は要素セレクタへの直接`.click()`だと`#cfOpenHit`に奪われて失敗することがあるため、`page.mouse.click(x, y)`など座標ベースのクリックを使うこと。タッチ操作はCDPの`Input.dispatchTouchEvent`で再現し、開始→移動→終了を1回の呼び出しの中で完結させること（複数回に分けると途中の状態が保たれず正しく検証できない）。
