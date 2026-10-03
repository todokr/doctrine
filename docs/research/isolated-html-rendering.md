# エージェントが書いた HTML を Tauri のレビュー画面で隔離して表示する方法

チケット: #35（地図 #23）。前提の調査: #24（`docs/research/diagram-rendering.md`）。調査日: 2026-10-03。

この文書は選択肢ごとの事実と制約を並べるだけで、形式は決めない（形式の決定は #29、置き場所と読む経路は #30）。
出典は各項に付けた。一次ソースで確かめられなかったことは「未確認」と書いた。

#24 で分かっていること（Tauri が `style-src` にノンスを注入するので実行時の `<style>` と `style` 属性は通らない、
iframe には IPC が初期化されない、`dangerousDisableAssetCspModification` で無効化できる）は繰り返さない。
ここではその先、**隔離の器をどう作るか**を見る。

## 0. 手元で確かめた方法と、確かめていないこと

各 WebView の実機ではなく、**同じエンジン系統**を手元で動かして測った。

- **Chromium 系**: Google Chrome 151.0.7922.71 を headless で起動し、DevTools Protocol でコンソールと計測結果を取った。
  Windows の WebView2 は Chromium ベースだが、WebView2 本体では確かめていない。
  [Tauri: Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- **WebKit 系**: WebKitGTK 2.52.5（`webkit2gtk-4.1`、Tauri が Linux で使う系統）を Python GI から起動した。
  macOS の WKWebView は同じ WebKit でも別移植であり、**WKWebView では確かめていない**。
- 独自スキーム `app:`（親）と `guide:`（ガイド）を登録し、wry と同じく `register_uri_scheme_as_secure` を呼んだ。
  親は Tauri 相当の CSP ヘッダ
  `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; img-src 'self' data:; frame-src 'self' data: blob: guide:`
  を付けて配信した。Chromium 側は同じ構成をローカルの HTTP サーバ2つ（親と別オリジンのガイド）で作った。
- ガイドの HTML には `<style>`、`style` 属性、SVG 内の `<style>`、CSS アニメーション、SMIL の `<animate>`、
  インラインの `<script>`、`onerror` 属性、外部の CSS と画像（読み込まれたらサーバのログに残る）を入れた。
- **Tauri アプリはビルドしていない。** Tauri 固有の挙動（ノンス注入後の実機の CSP、Windows でのサブフレームへのスクリプト注入、
  capability の効き方）は、ソースと仕様からの推論であり、実機では未確認。

Tauri 2.11.5 / wry 0.57.0 のソース（`dev` ブランチ、2026-09-15 取得）を読んだ。

## 1. Tauri の CSP はどこに付き、ノンスはいつ決まるか

- CSP は `tauri://localhost`（Windows/Android は `http://tauri.localhost`）で返すアセットの
  **`Content-Security-Policy` レスポンスヘッダ**として付く。
  [tauri: `crates/tauri/src/protocol/tauri.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/protocol/tauri.rs)
- ノンスは**アセットを返すたびに乱数で作られる**（`getrandom::u64()`）。HTML 中のトークンを置換し、
  同じ値を `script-src` / `style-src` に足す。ノンスかハッシュが1つでもあれば `'self'` も足される。
  [tauri: `crates/tauri/src/manager/mod.rs` の `set_csp` / `replace_csp_nonce`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/manager/mod.rs)
- トークンが入るのは `<style>` 要素と `src` が `http` で始まる `<script>` 要素。ローカルのスクリプトはハッシュになる。
  [tauri: `crates/tauri-utils/src/html2.rs` の `inject_nonce_token`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/html2.rs)
- **アプリが自分で登録した独自スキームの応答には、Tauri は CSP を足さない。** ヘッダはハンドラが自分で付ける
  （`protocol/tauri.rs` の CSP 付与はアセット応答の分岐の中にしかない）。これは後述の2の前提になる。

含意: 親の文書に効いている CSP は「ノンス付きで、ノンスの値は毎回変わる」。
ガイドの HTML を**ビルド時に**ノンス付きで書くことはできない（値が起動のたびに変わる）。
実行時に親の JavaScript がノンスを読んで差し込むことはできる（後述 3-4）。

## 2. srcdoc / data: / blob: の iframe は、親の CSP を継承する

### 仕様

HTML の「determine navigation params policy container」は次の順で決める。

- `historyPolicyContainer` があればそれ
- **responseURL が `about:srcdoc` なら、親の policy container の複製**
- **responseURL が local（Fetch の定義で `about:` / `blob:` / `data:`）で、initiator の policy container があればその複製**
- それ以外は応答から作る

`blob:` は別に、「create a policy container from a fetch response」の第1ステップで
**blob URL を作った環境の policy container の複製**になる。
[HTML Standard §7.1.4 Policy containers](https://html.spec.whatwg.org/multipage/browsers.html#determining-navigation-params-policy-container)

policy container には CSP リストが入るので、**`srcdoc` / `data:` / `blob:` の iframe は親の CSP をそのまま持つ**。
iframe 側の `<meta http-equiv>` で CSP を足すことはできるが、緩めることはできない
（インラインのスタイルは「every policy allows inline style」でなければ阻まれる）。
[CSP Level 3 §6.1.13 style-src](https://www.w3.org/TR/CSP3/)

### 実測（Chrome 151 / WebKitGTK 2.52.5、どちらも同じ結果）

親の CSP が `style-src 'self' 'nonce-…'` の状態で、`srcdoc`・`data:`・`blob:` の iframe に入れたガイド HTML は、

| ガイド側の書き方 | 結果 |
| --- | --- |
| `<style>…</style>` | **効かない**（"Refused to apply a stylesheet / Applying inline style violates…"） |
| `style="…"` 属性 | **効かない**（両エンジンとも、ハッシュは属性に効かないという注記つき） |
| SVG 内の `<style>` | **効かない**（`fill` が既定の黒のまま） |
| 外部 CSS（`<link href="guide://…">`） | **止まる**（親の `style-src` 違反。サーバにリクエストは来ない） |
| 外部画像（`<img src="guide://…">`） | **止まる**（親の `img-src` 違反） |
| インライン `<script>` / `onerror` 属性 | **止まる**（sandbox なしの iframe でも、親の `script-src` のノンスで阻まれた） |
| 親オリジンの `<link rel=stylesheet href="/theme.css">` | **効く**（`'self'` に当たる。`about:srcdoc` の base URL は親から継承される） |

つまり **Tauri の既定の CSP 変更のもとでは、`srcdoc` / `data:` / `blob:` に入れたガイドは「文字だけが出て、見た目は全部消える」**。
図は SVG の形としては出るが、色も線もアプリ側の CSS から当てるしかない。

これを変えるには、`dangerousDisableAssetCspModification: ["style-src"]` と `style-src 'unsafe-inline'` でアプリ全体を緩めるしかない
（継承される CSP は親の CSP なので、iframe の中だけ緩めることはできない）。#24 の §1 と同じ結論が、器を変えても動かないということ。
Tauri 実機では未確認。

### 親がノンスを差し込む場合（実測）

親の JavaScript が、ガイドの `<style>` に自分のノンス（`document.currentScript.nonce` などで読める）を付けてから `srcdoc` に入れると、

- `<style>` は**効く**（背景色も `@keyframes` のアニメーションも動いた。両エンジン）
- `style="…"` 属性は**依然として効かない**（ノンスは属性には効かない。CSP3 では `'unsafe-hashes'` ＋属性ごとのハッシュが要る）
  [CSP Level 3 §6.1.13 / §6.7.3](https://www.w3.org/TR/CSP3/)

これは「エージェントが書いた CSS 全体にアプリのノンスを貸す」ことであり、CSP の保護を CSS については外すのと同じになる。
ノンスの値は親の DOM から読めるので、iframe の中でスクリプトが動かない限り漏れはしないが、
**CSS 注入（画面の偽装、UI を覆う）に対する守りは無くなる**。

## 3. 独自スキームで別オリジン＋独自の CSP ヘッダにして配信する

### API と URL の形

- `register_uri_scheme_protocol`（同期）/ `register_asynchronous_uri_scheme_protocol`（非同期、別スレッドで応答できる）。
  応答は `http::Response` なので、**任意のヘッダ（CSP を含む）を付けられる**。
- URL の形は OS で違う（Tauri のドキュメントコメントより）。
  - macOS / iOS / Linux: `<scheme>://localhost/<path>`（例 `guide://localhost/x.html`）
  - Windows / Android: `http://<scheme>.localhost/<path>`（`use_https_scheme` で `https` にできる）
  [tauri: `crates/tauri/src/app.rs` の `register_uri_scheme_protocol`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/app.rs)
- したがって **CSP の `frame-src` に書く値も OS で変わる**（`guide:` ／ `http://guide.localhost`）。両方並べて書くことになる。
- 実装は OS ごとに違う仕組みに載っている。
  - Windows: `AddWebResourceRequestedFilter`。wry は `ICoreWebView2_22` があれば
    `AddWebResourceRequestedFilterWithRequestSourceKinds(…, SOURCE_KINDS_ALL)` を使う。
    コメントに「Shared Worker と **iframe** で独自プロトコルが動くようにするため」とある（[WebView2Feedback #1114](https://github.com/MicrosoftEdge/WebView2Feedback/issues/1114)）。
    古い WebView2 ランタイムでは古い API に落ちるので、**iframe からの独自スキームの読み込みはランタイムの版に依存する**（実機未確認）。
    [wry: `src/webview2/mod.rs`](https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs)
  - macOS: `setURLSchemeHandler`。Linux: `webkit_web_context_register_uri_scheme` ＋ `register_uri_scheme_as_secure`。
    [wry: `src/webkitgtk/web_context.rs`](https://github.com/tauri-apps/wry/blob/dev/src/webkitgtk/web_context.rs)

### 実測（Chrome / WebKitGTK）

ガイドを `guide://localhost/…`（Chromium 側は別ポート）から
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:` 付きで返し、`sandbox=""` の iframe に入れた。

- `<style>`、`style` 属性、SVG 内の `<style>` は**すべて効いた**（両エンジン）。
- 外部 CSS と外部画像は**ガイド自身の CSP で止まった**（サーバにリクエストが来ない）。
- インライン `<script>` と `onerror` は **sandbox で止まった**。
- **CSP ヘッダを付け忘れた応答**（対照）では、外部 CSS と外部画像が実際に読み込まれた（サーバのログに残った）。
  → **独自スキームの応答に CSP を付けるのはハンドラの責任**であり、忘れると外部通信が素通りする。
- `sandbox="allow-same-origin"` を付けても、親からは中を読めない（別オリジンのまま。
  WebKit は "Protocols must match"、Chromium は access denied）。

つまり **「エージェントの CSS をそのまま効かせたい」なら、別オリジン＋独自 CSP の経路しかない**
（アプリ全体の `style-src` を緩めない限り）。

### Tauri の IPC から見た独自スキーム

- Tauri の `is_local_url` は、**登録済みの独自スキームの URL を「ローカル」とみなす**
  （Windows/Android では `<name>.localhost` のサブドメイン名で判定）。
  つまり独自スキームのページが**トップレベルの WebView として**読み込まれた場合、ACL 上は `Origin::Local` になり、
  `remote` capability ではなくローカルの capability が効く。
  [tauri: `crates/tauri/src/webview/mod.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/webview/mod.rs)
- ただし iframe に入れる限り、IPC の初期化スクリプトは入らない（次節）。

## 4. IPC に届かないこと・外部読み込み・遷移・ポップアップを止める

### IPC に届かない理由は4枚ある

1. **初期化スクリプトがメインフレーム限定**。Tauri が入れるスクリプト（`__TAURI_INTERNALS__`、invoke キーを持つ IPC スクリプト、
   メタデータ、プラグインのスクリプト）はすべて `for_main_frame_only: true` で登録される。
   [tauri: `crates/tauri/src/manager/webview.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/manager/webview.rs)
   **ただし wry のドキュメントに「Windows ではこのオプションに関係なくサブフレームにも必ず入る」と書かれている。**
   [wry: `src/lib.rs` `with_initialization_script_for_main_only`](https://github.com/tauri-apps/wry/blob/dev/src/lib.rs)
   これが #24 で見た GHSA-57fm-592m-34r7 の「Windows で同一オリジンのとき」の例外に対応する。
   sandbox でスクリプトを止めた iframe でも WebView2 の注入スクリプトが動くかどうかは**未確認**。
2. **invoke キー**。IPC の受け口は `__TAURI_INVOKE_KEY__`（起動時の乱数）が一致しなければ、コマンドを解決する前に捨てる。
   キーはスクリプト内のクロージャに閉じ込められていて `toString()` で漏れないようにしてある。
   [tauri: `crates/tauri/src/webview/mod.rs` の `on_message`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/webview/mod.rs)、
   [tauri: `crates/tauri/scripts/ipc-protocol.js`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/scripts/ipc-protocol.js)
3. **sandbox でスクリプトが動かない**（`allow-scripts` を付けない）。実測では、インライン `<script>`、`onerror` 属性、
   `<meta http-equiv=refresh>` のすべてが両エンジンで止まった
   （Chromium: "Blocked script execution … the document's frame is sandboxed"、
   WebKit: "Unable to do meta refresh due to sandboxing"）。
   HTML 仕様の sandboxed scripts flag（スクリプトを止める）と sandboxed automatic features flag（自動実行の機能を止める）に対応する。
   [HTML Standard §7.6 Sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing)
4. **capability**。コマンドの許可はウィンドウ／WebView のラベル単位で書く。リモートオリジンには `remote: { urls: [...] }` が要る。
   [Tauri: Capabilities](https://v2.tauri.app/security/capabilities/)

スクリプトが動かないフレームからは IPC を呼ぶ手段がない（IPC は `fetch` かメッセージハンドラ経由）。
**逆に言えば、`allow-scripts` を足した瞬間に、残りは 1・2・4 の3枚だけになる。**

### 外部リソースの読み込み

- `srcdoc` / `data:` / `blob:`: 親の CSP がそのまま効く。`default-src 'self'` のままなら外部は止まる（実測）。
- 独自スキーム: **ハンドラが付ける CSP がすべて**。`default-src 'none'` を基点に、必要なものだけ足す形になる（実測）。
- 画像・フォント・CSS の `url()` は、それぞれ `img-src` / `font-src` / `style-src` の対象になる。

### 遷移・ポップアップ・ダウンロード・フォーム

HTML の sandbox フラグで止まるもの（仕様の定義）:

- **ポップアップ**: `allow-popups` なし → sandboxed auxiliary navigation flag が
  「`target` 属性や `window.open()` で新しい補助ブラウジングコンテキストを作ること」を止める。
- **トップレベルの遷移**: `allow-top-navigation`（および user activation 版）なし → 親ごと遷移させられない。
- **フォーム送信**: `allow-forms` なし → sandboxed forms flag が止める。
- **ダウンロード**: `allow-downloads` なし → sandboxed downloads flag が
  「リンクや遷移からダウンロードを始めること」を止める。
  [HTML Standard §7.6 Sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing)

**止まらないもの**: iframe が**自分自身**を別の URL へ遷移させること（リンクのクリックなど）。
sandboxed navigation flag は「自分自身と、その中の入れ子」は対象外と仕様に明記されている。
CSP 側にも自分の遷移を止める指令はない（`navigate-to` は現行の CSP3 ドラフトに存在しない。ドラフト全文を検索して0件）。
使える抑えは次の2つ。

- **`frame-src`**: iframe に読み込める URL を制限する。
- **Tauri の `on_navigation`**: wry の navigation handler。**OS でカバー範囲が違う。**
  - **Linux（WebKitGTK）**: 手元で確かめた。`decide-policy` の `NAVIGATION_ACTION` は
    **サブフレームの遷移でも発火した**（`about:srcdoc`、`data:…`、`blob:app://…`、`guide://localhost/…` すべて通った）。
    [wry: `src/webkitgtk/mod.rs`](https://github.com/tauri-apps/wry/blob/dev/src/webkitgtk/mod.rs)
  - **Windows（WebView2）**: wry は `add_NavigationStarting` だけを使う。
    Microsoft のドキュメントは「フレーム内の遷移を監視・取り消すには、フレーム用の API とイベントを使う」と別立てにしている
    → **iframe の遷移は `on_navigation` に来ない見込み**（実機未確認）。
    [WebView2: Navigation events](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/navigation-events)、
    [wry: `src/webview2/mod.rs`](https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs)
  - **macOS（WKWebView）**: `decidePolicyForNavigationAction` を使う。サブフレームにも来るかは**未確認**
    （Apple のドキュメントページを取得できなかった）。
- `window.open` 自体は wry の new window handler（Tauri の `on_new_window`）でも受けられる。
  [tauri: `WebviewBuilder::on_new_window`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/webview/mod.rs)

## 5. 中でスクリプトを動かさずに高さを内容に合わせる

### `srcdoc` ＋ `sandbox="allow-same-origin"`（スクリプトなし）

実測（両エンジン）: 親から `iframe.contentDocument.documentElement.scrollHeight` を読めた。
読んだ値を `iframe.style.height`（**CSSOM 経由なので親の `style-src` に引っかからない**）に入れると、
`getBoundingClientRect().height` がその値になった（573px）。
**スクリプトを一切動かさずに高さを内容に合わせられる。**

内容が後から変わる場合（画像の読み込み、フォントの切り替え）に親の `ResizeObserver` で追えるかは**未確認**。

### `allow-same-origin` を付けると何が変わるか

- `srcdoc` の文書の origin は**親（アプリ）と同じ**になる。`allow-scripts` を付けていない限りスクリプトは動かないので、
  その origin で能動的に何かをする主体はいない。
- **危ないのは組み合わせ**。HTML 仕様は「埋め込みページが埋め込み元と同一オリジンのときに `allow-scripts` と `allow-same-origin` を
  両方指定すると、埋め込みページは `sandbox` 属性を外して自分を再読み込みでき、サンドボックスを完全に破れる」と警告している。
  [HTML Standard: the iframe element](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)
  つまり `allow-same-origin` を付けた設計は、**後から誰かが `allow-scripts` を足した瞬間に隔離が無くなる**。
- Windows では Tauri の初期化スクリプトがサブフレームにも入り（§4-1）、同一オリジンの iframe は
  GHSA-57fm-592m-34r7 の例外にあたる。sandbox でスクリプトを止めている間は呼び手がいないが、
  **`allow-scripts` との併用は Windows では特に危うい**（実機未確認）。
- 親のコードが `contentDocument` を触れるようになる＝**親が中の DOM を本体の文書へ持ち込める**ようになる。
  持ち込むと §8 のとおり CSP の判定が変わるので、「測るだけで、ノードは持ち出さない」と決めておく必要がある。

### 別オリジン（独自スキーム）のとき

- 親からは測れない。中から `postMessage` する以外にない。実測では、`sandbox="allow-scripts"` のガイドから
  `parent.postMessage` が親に届いた（`event.origin` は `"null"`。opaque origin なので送信元で検証できない）。
- **中でスクリプトを動かすなら**、ガイド自身の CSP の `script-src` を
  ハンドラが差し込む計測スクリプトのノンス／ハッシュだけに絞れば、エージェントが書いたスクリプトは動かせない
  （理屈の上では成り立つ。**未検証**）。
- スクリプトを一切動かさないなら、高さは「固定＋中でスクロール」か「アプリ側が内容から見積もる」になる。

### `frame-sizing`（iframe の自動リサイズ）

- 埋め込み側が `<meta name="responsive-embedded-sizing">` で opt-in し、親が `frame-sizing: content-height` などを指定すると、
  iframe が内容の大きさに合う。動的な変化には埋め込み側が `Window.requestResize()` を呼ぶ必要がある（＝スクリプトが要る）。
  MDN は「限定的な対応（Baseline ではない）」「実験的」と表示している。
  [MDN: frame-sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/frame-sizing)、
  [Intent to Prototype: Responsive iframes](https://groups.google.com/a/chromium.org/g/blink-dev/c/QirdSBIvM1k/m/rZdHOE59AQAJ)
- 実測: Chrome 151 では `CSS.supports('frame-sizing', …)` が `content-height` / `content-block-size` / `auto` のすべてで false、
  `window.requestResize` も `undefined`。WebKitGTK 2.52.5 でも false。**今は当てにできない。**

## 6. アプリのテーマ（色・フォント）を中の HTML に渡す

CSS のカスタムプロパティは文書の中でしか継承されないので、iframe の境界は越えない。経路は3つある。

1. **親オリジンのスタイルシートを `<link>` で読ませる**（`srcdoc` の場合）。実測で両エンジンとも効いた
   （継承した CSP の `'self'` に当たる。`about:srcdoc` の base URL は親のものになるので `/theme.css` と書ける）。
   アプリのビルド成果物の CSS をそのまま使える。
2. **独自スキームのハンドラが、応答の HTML にテーマを埋めて返す**。色やフォントを `:root{--…}` として文字列で差し込むか、
   `guide://localhost/theme.css` を別に返す。テーマを切り替えたら iframe を読み直す（中でスクリプトを動かさないなら他に手がない）。
3. **`prefers-color-scheme` に任せる**。CSS Color Adjustment の §2.1 は
   「iframe や SVG の `img` のような埋め込み文書では、**埋め込み側の要素の color scheme** が、
   利用者の設定の代わりに、埋め込まれた文書の preferred color scheme として使われる」と定める。
   [CSS Color Adjustment Module Level 1 §2.1](https://drafts.csswg.org/css-color-adjust/#color-scheme-prop)
   - 実測 **Chrome 151: 仕様どおり**。システムが dark でも、`color-scheme: light` を継承した iframe の中では
     `prefers-color-scheme: dark` が false、`#iframe{color-scheme: dark}` を当てた iframe の中では true になった。
   - 実測 **WebKitGTK 2.52.5: 従わない**。親の `:root{color-scheme: light}` を継承した iframe でも、
     中の `matchMedia('(prefers-color-scheme: dark)')` はシステム設定（dark）のまま true を返した。
     GSettings をメモリバックエンドにし、別の D-Bus セッションで起動しても変わらなかった。
     WKWebView での挙動は**未確認**（WebKit には「システムの設定を上書きする」別の私的 API が入った経緯がある。
     [WebKit changeset 287030 / bug 234199](https://trac.webkit.org/changeset/287030/webkit)）。
   - → **アプリ内のテーマ切り替え（OS 設定と独立）を効かせたいなら、`prefers-color-scheme` ではなく 1 か 2 で渡すほうが移植性が高い。**
   - 同じ仕様の §2.4 に、埋め込み元と埋め込み文書の color scheme が食い違うときは
     **透明なキャンバスではなく不透明なキャンバスが使われる**とある（＝iframe の背景が意図せず塗られうる）。

## 7. CSS アニメーションと SMIL は iframe の中で動くか

実測（Chrome 151 / WebKitGTK 2.52.5）。1.5秒後と2.3秒後の2点で、親（または中のスクリプト）から
`opacity` の計算値と `<rect>` の `x.animVal` を読んだ。

| 置き方 | CSS アニメーション | SMIL（`<animate>`） |
| --- | --- | --- |
| `srcdoc` ＋ `sandbox="allow-same-origin"`（スクリプトなし、ガイドの `<style>` が CSP で落ちる） | そもそも定義が消えるので動かない（`getAnimations()` が 0） | **動く**（両エンジンで `x` が進んだ。Chrome 75.1→15.1、WebKit 73.8→13.2） |
| 同上＋親がノンスを差し込んで `<style>` を通した場合 | **動く**（Chrome 0.587→0.787、WebKit 0.584→0.779。`getAnimations()` が 1） | **動く** |
| 別オリジン（独自スキーム）＋ `sandbox="allow-scripts"`、ガイド自身の CSP | **動く**（Chrome 0.547→0.253、WebKit 0.522→0.277） | WebKit は**動く**（29.5→55.1）。Chrome は `animVal` が両方 0 のまま（原因不明、未確認） |

要点は、**SMIL はスクリプトを一切動かさない sandbox フレームの中でも進む**ということ
（SMIL は宣言的なので `allow-scripts` を要らない）。一方 **CSS アニメーションは `<style>` が通るかどうかに完全に従属する**ので、
§2 の CSP の話がそのままアニメーションの可否になる。

WebView2 と WKWebView 本体では未確認。SMIL 自体が Baseline であることは #24 §4 のとおり。

## 8. iframe を使わない代替（Shadow DOM ＋ 無害化）と CSP の扱い

ノンス付き CSP（`style-src 'self' 'nonce-…'`）のもとで、本体の文書の shadow root に対して各手段を試した実測。

| 手段 | Chrome 151 | WebKitGTK 2.52.5 |
| --- | --- | --- |
| `shadowRoot.innerHTML` の `<style>` | 効かない | 効かない |
| `shadowRoot.innerHTML` の `style` 属性 | 効かない | 効かない |
| `el.setAttribute('style', …)` | 効かない | 効かない |
| `el.style.cssText = …`（CSSOM） | **効く** | **効く** |
| `new CSSStyleSheet()` ＋ `replaceSync()` ＋ `adoptedStyleSheets` | **効く** | **効く** |
| 同上 ＋ `insertRule()` | **効く** | **効く** |
| `document.createElement('style')` にテキストを入れる | 効かない | 効かない |
| 同上 ＋ 親のノンスを `style.nonce` に入れる | **効く** | **効く** |
| `DOMParser` で解析 → `importNode` → 追加（`style` 属性） | **効く** | **効く** |
| 同上の `<style>` 要素 | 効かない | 効かない |
| `DOMParser` で解析 → `adoptNode` → 追加（`style` 属性） | **効かない** | **効く** |
| `<template>.innerHTML` → `content.cloneNode()`（`style` 属性） | **効く** | **効く** |
| `setHTMLUnsafe()` の `<style>` / `style` 属性 | 効かない | 効かない |
| `setHTML()`（Sanitizer API） | 対応あり。既定で `<style>`・`style` 属性・`class`・`<animate>`・`<script>` が消えた | **未対応** |

読み取れること。

- **CSSOM 経由（`style.cssText`、`adoptedStyleSheets`、`insertRule`）は CSP で止まらない。**
  CSP3 は「insert a CSS rule / parse a CSS rule / parse a CSS declaration block は `unsafe-eval` に紐づく」と書きつつ、
  同じ箇所に「これはもっとうまく説明する必要がある [Issue #212]」と注記が付いたままで、実装は追随していない。
  [CSP Level 3 §6.1.13 style-src](https://www.w3.org/TR/CSP3/)
  → **エージェントの CSS を文字列で受け取り、`CSSStyleSheet.replaceSync()` に通して `adoptedStyleSheets` で当てる**経路は、
  アプリ全体の CSP を緩めずに成立する。`@import` は `replaceSync()` / `replace()` の仕様で取り除かれるので外部読み込みにはならない。
  [CSSOM §6.1.2](https://drafts.csswg.org/cssom/#dom-cssstylesheet-replacesync)
  ただし CSS の中身は無検査で通る（`position: fixed` などで画面を覆える）。
- **不活性な文書で解析した `style` 属性は、取り込み方しだいで CSP をすり抜ける。** しかも
  `importNode` と `adoptNode` でエンジンの結果が割れた（Chromium は adopt を止め、WebKit は通した）。
  DOMPurify は既定で文字列を返すので `innerHTML` 経由になり止まるが、`RETURN_DOM_FRAGMENT` は
  **解析用の不活性な文書のノードをそのまま断片に移して返す**（`importNode` を呼ぶのは shadowroot 属性を許したときだけ）。
  [cure53/DOMPurify: `src/purify.ts`](https://github.com/cure53/DOMPurify/blob/main/src/purify.ts)
  → **「CSP が守ってくれる」はこの経路では成り立たない。エンジン差も含めて当てにしない前提で設計する必要がある。**
- **Sanitizer API は当てにできない。** Firefox 148 が最初に出荷、Chrome は追随、Safari は未着手で Baseline ではない。
  手元でも WebKitGTK 2.52.5 は未対応だった。
  [MDN: HTML Sanitizer API](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API)
- **Shadow DOM は視覚の隔離ではない。** スタイルの適用範囲は分かれるが、`position: fixed` などで外へはみ出せる。
  はみ出しを抑えるには CSS の containment が要る（layout containment は絶対・固定配置の包含ブロックを作り、
  paint containment は中身を overflow clip edge に切り詰める）。
  [CSS Containment Module Level 2 §3.4 / §3.5](https://drafts.csswg.org/css-contain-2/#containment-paint)
- **決定的な違いは失敗したときの被害**。shadow root は本体の文書の中にあるので、無害化をすり抜けてスクリプトが動けば、
  アプリのフロントエンドと同じ権限で IPC を呼べる（#24 §1）。iframe ＋ sandbox なら、すり抜けても
  §4 の1〜4 がまだ残っている。

## 9. 選択肢ごとのまとめ（事実のみ、決定はしない）

| | A. `srcdoc` ＋ sandbox（`allow-same-origin` あり） | B. `data:` / `blob:` ＋ sandbox | C. 独自スキーム ＋ 独自 CSP ＋ sandbox | D. Shadow DOM ＋ 無害化 | E. 別 WebView |
| --- | --- | --- | --- | --- | --- |
| ガイドの `<style>` | 効かない（親の CSP を継承）。親がノンスを差せば効く | 効かない | **効く**（ハンドラの CSP 次第） | 効かない（CSSOM へ変換すれば効く） | 効く |
| ガイドの `style` 属性 | 効かない（ノンスを差しても不可） | 効かない | **効く** | 効かない（`cssText` へ変換すれば効く） | 効く |
| 外部読み込みを止める主体 | 親の CSP（そのまま継承） | 親の CSP | **ハンドラが付ける CSP**（付け忘れると素通り） | 親の CSP | その WebView の CSP |
| スクリプト | sandbox で停止。CSP でも停止 | 同左 | 同左 | **止める主体は無害化のコードと CSP** | sandbox 無し。capability で縛る |
| IPC | 初期化スクリプトが入らない（Windows は要注意） | 同左 | 同左 | **本体の文書と同じ＝届く** | capability を与えなければ届かない |
| 高さ合わせ | **親が測れる**（スクリプト不要、実測） | 測れない | 中で `postMessage`（スクリプトが要る） | 本体の DOM なので自然に流れる | ウィンドウ側で制御 |
| テーマ | 親の `<link>`（実測で可） | 同左（ノンス差し込みと同様の制約） | ハンドラが埋める | そのまま継承（カスタムプロパティが flat tree を流れる） | 同左 |
| `frame-src` の要否 | 不要（`about:srcdoc` は取得されない） | `data:` / `blob:` が要る | `guide:` ／ `http://guide.localhost`（OS で違う） | 不要 | 不要 |
| Tauri 側の変更 | なし | なし | スキーム登録とハンドラ（Rust） | なし | `unstable` フィーチャ（`Window::add_child`） |

E の補足: 子 WebView の API（`Window::add_child`）は `unstable` フィーチャの下にある。
[tauri: `crates/tauri/src/window/mod.rs`](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/window/mod.rs)

`docs/overview.md` 8章「設定はデータであって、実行可能コードではない」との関係（事実の整理のみ）:
A/B/C は、エージェントの出力を「実行されない表示物」として扱うための器であり、器の強さは
**どこに信頼境界を置くか**（親の CSP を継承するか、別オリジンの CSP を立てるか）で決まる。
D は境界を置かず、無害化のコードの正しさに賭ける形になる。

## 未確認のまま残したこと

- Tauri の実機（ノンス注入あり）での §2 の挙動。本文はすべて同等の CSP を手で作った再現であり、Tauri アプリはビルドしていない。
- WKWebView（macOS）と WebView2（Windows）本体での全項目。特に
  - WebView2 の古いランタイムで iframe から独自スキームを読めるか
  - Windows でサブフレームに入る Tauri の初期化スクリプトが、`allow-scripts` なしの sandbox フレームでも動くか
  - WKWebView で `decidePolicyForNavigationAction` がサブフレームの遷移にも来るか
  - WKWebView の `prefers-color-scheme` が埋め込み側の `color-scheme` に従うか
- 独自スキームのガイドで、`script-src` をハンドラのノンスだけに絞って「計測スクリプトだけ動かす」構成が実際に成立するか。
- 親の `ResizeObserver` で `allow-same-origin` な iframe の内容の変化を追えるか。
- Chromium で、別オリジンの sandbox フレーム内の SMIL（`<animate>`）が進むか。
  手元の計測では CSS アニメーションは進んだのに `animVal` が 0 のままだった（`srcdoc` の sandbox フレームでは進んだ）。原因不明。
- `prefers-reduced-motion` が iframe の中に伝わるか。画面外の iframe の描画が間引かれるか。
