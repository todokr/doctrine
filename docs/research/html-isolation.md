# エージェントが書いた HTML（インライン SVG/CSS）を Tauri のレビュー画面に隔離して表示する方法

チケット: #35（地図 #23）。調査日: 2026-09-15。

この文書は選択肢ごとの事実と制約を並べるだけで、形式は決めない（決定は #30）。
出典は各項の末尾に付けた。一次ソースで確かめられなかったことは「未確認」と書いた。
#24 の調査（`docs/research/diagram-rendering.md`）の CSP・IPC まわりの結論を前提にし、
本文書はそれを iframe／別オリジン／Shadow DOM の文脈に広げる。

## 前提

- Review Guide の本文をエージェントが HTML（インライン SVG・CSS を含む）で書く前提。
  overview.md 8章の原則（「設定はデータであって、実行可能コードではない」）に照らすと、
  この HTML は実行可能なマークアップであり、そのまま実行可能コードに近い扱いが要る。
  [docs/overview.md](../overview.md)
- UI は Tauri + React + Vite。WebView は Windows が WebView2、macOS が WKWebView、Linux が WebKitGTK。
  [Tauri: Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- Tauri はビルド時に `style-src`/`script-src` にノンス・ハッシュを注入する。この状態では実行時に差し込んだ
  `<style>` 要素・`style` 属性は `'unsafe-inline'` を書いても通らない（#24 での確認）。
  [Tauri: Content Security Policy](https://v2.tauri.app/security/csp/)、
  [docs/research/diagram-rendering.md §1](https://github.com/todokr/doctrine/blob/research/diagram-rendering/docs/research/diagram-rendering.md)

## 1. `srcdoc` / `data:` / `blob:` の iframe に、親の CSP（ノンス注入）は効くか

policy container はドキュメントごとに持つ、CSP を含む状態のまとまりで、HTML 標準がその生成・継承規則を定める。
CSP3 自体はこの継承規則を定義せず、fetch/HTML の policy container を参照するだけ
（"Let CSP list be request's policy container's CSP list" など）。
[W3C: CSP Level 3](https://www.w3.org/TR/CSP3/)

- **`srcdoc` の iframe**: 新しい空のドキュメントは、creator（作成元）が無ければ既定の policy container を持ち、
  ある場合は creator の policy container の**クローン**を持つ。`about:srcdoc` への遷移では、対象フレームの**親**を
  常に「遷移の initiator」とみなす。つまり `srcdoc` の中身は、埋め込んだ親ドキュメントの CSP（Tauri がノンスを
  注入した `style-src`/`script-src` を含む）をそのまま引き継ぐ。
  [antosart/policy-container-explained](https://github.com/antosart/policy-container-explained)（HTML/Fetch の policy container 仕様の共同提案者による解説。WHATWG HTML 本文の該当アルゴリズムは断片的にしか取得できなかったため、この解説を一次情報に近い参照として使う。未確認: WHATWG HTML 本文の当該アルゴリズムのステップ番号）
- **`data:` URL のドキュメント**: ナビゲーションパラメータの **initiator の policy container** を継承する
  （= ナビゲーションを実行した側、通常はそのリンクを作った親ドキュメント）。
  [antosart/policy-container-explained](https://github.com/antosart/policy-container-explained)
- **`blob:` URL のドキュメント**: blob URL を作成したドキュメントが、自分の policy container のクローンを
  blob URL エントリと一緒に保存する。その blob へ遷移すると、保存された policy container のクローンが
  新しいドキュメントに適用される。つまり `URL.createObjectURL()` を呼んだ側（≒同じオリジンの親アプリ）の
  CSP を継承する。
  [antosart/policy-container-explained](https://github.com/antosart/policy-container-explained)
- 結論（事実の整理）: `srcdoc` / `data:` / `blob:` のいずれも、**親（作成元）の CSP を継承する**。
  Tauri がノンスを `style-src` に注入した状態のまま `srcdoc`/`data:`/`blob:` に HTML を入れても、
  そのノンスなしに書かれたガイドの `<style>` 要素・`style` 属性は、iframe の中でも `'unsafe-inline'` と
  同様に拒否される見込みが高い（継承される CSP は親と同じため）。ただし実機の WebView（WKWebView / WebKitGTK /
  WebView2）でこの継承の挙動を確かめたわけではない（未確認）。
- 逃げ道として、iframe 自身に `csp` 属性（Content Security Policy: Embedded Enforcement 仕様）を付けて
  埋め込み先に要求ポリシーを課す方法があるが、これは「埋め込み先が最低限このポリシーを満たすこと」を
  要求するものであり、`srcdoc` ドキュメント自身が**別の（より緩い）CSP を得る**手段ではない。
  [W3C: CSP: Embedded Enforcement](https://www.w3.org/TR/csp-embedded-enforcement/)
- 上記より、`srcdoc`/`data:`/`blob:` の iframe だけでは「エージェントが書いた `<style>`/`style` 属性を
  そのまま有効にする」問題は解決しない。有効にするには、Tauri 側で `dangerousDisableAssetCspModification:
  ["style-src"]` のように緩めるか（#24 で見た「唯一の解」との発言参照）、あるいは §2 の別オリジン配信で
  ノンスの入らない CSP を明示的に与える必要がある。
  [tauri-apps/tauri Discussion #8578](https://github.com/tauri-apps/tauri/discussions/8578)

## 2. 独自 URI スキームで別オリジン配信し、sandbox iframe に読み込む方式

- Tauri v2 の `register_uri_scheme_protocol` は同期ハンドラを、`register_asynchronous_uri_scheme_protocol` は
  別スレッドで非同期にレスポンスを返せるハンドラを登録する。ハンドラは `http::Request` を受け取り
  `http::Response` を返す関数で、macOS/iOS は `setURLSchemeHandler`、Windows は `AddWebResourceRequestedFilter`、
  Linux は `webkit-web-context-register-uri-scheme` を使う。
  [docs.rs: tauri::Builder](https://docs.rs/tauri/latest/tauri/struct.Builder.html)
- オリジンはプラットフォームで異なる。macOS/iOS/Linux は `<scheme>://localhost/<path>`、Windows/Android は
  `http://<scheme>.localhost/<path>`（設定により https も可）。アプリのメインオリジンとは異なるオリジンになる。
  外部サーバーへ `fetch`/`XMLHttpRequest` する場合、CORS 側で同じ Origin か `*` を `Access-Control-Allow-Origin`
  に含める必要がある。
  [docs.rs: tauri::Builder](https://docs.rs/tauri/latest/tauri/struct.Builder.html)
- ハンドラは自分で `http::Response` を組み立てるので、レスポンスヘッダ（`Content-Security-Policy` を含む）を
  ハンドラの中で自由に設定できる。これはビルド時にノンスを注入する「フロントエンド資産の CSP」とは別の経路であり、
  独自スキームのレスポンスに対して独自の CSP ヘッダを付けられる見込みが高い（ハンドラの実装依存。実機での
  ヘッダ到達・ブラウザ側の適用は未確認）。
- 一方、Tauri の `HTTP Headers`（`tauri.conf.json` の `app.security.headers`）による宣言的ヘッダ設定は
  「CSP はここでは定義しない」と明記されており、CSP は `app.security.csp` 側の仕組みに統一されている。
  この宣言的な仕組みで独自スキームごとに別の CSP を割り当てる機能は見当たらない（未確認: 将来的な対応）。
  [Tauri: HTTP Headers](https://v2.tauri.app/security/http-headers/)
- 実行時にレスポンスを書き換える `on_web_resource_request`（`WebviewBuilder`/`WebviewWindowBuilder`）は
  **「現状 `tauri` URI プロトコルにのみ実装されている」**とドキュメントに明記されており、独自スキーム
  （`register_uri_scheme_protocol` で登録したもの）には掛からない。独自スキームで CSP ヘッダを出すには、
  ハンドラ自身が `http::Response` に `Content-Security-Policy` ヘッダを積む必要がある。
  [docs.rs: tauri::webview::WebviewBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)
- 実装上の制約として、v1 時代には「独自スキームの iframe から `<script src="独自スキーム://...">` を読み込めない」
  という報告があった（`net::ERR_CONNECTION_REFUSED`）。これは Tauri 1.0.0-rc.3 時点の報告で、v2 で解消済みかは
  一次ソースで確認できなかった（未確認）。
  [tauri-apps/tauri #3543](https://github.com/tauri-apps/tauri/issues/3543)
- 独自スキームは「アプリの WebView 内でのみ有効で、外のシステムには登録されない」。
  [docs.rs: tauri::Builder](https://docs.rs/tauri/latest/tauri/struct.Builder.html)
- iframe に `src="myscheme://..."` で読み込む場合、親ドキュメントの CSP の `frame-src`（無ければ
  `child-src`／`default-src`）に `myscheme:` を許可しておく必要がある（frame-src は `<iframe>`/`<frame>` が
  読み込める送信元を制御する）。
  [MDN: CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src)
- §1 の継承規則は `srcdoc`/`data:`/`blob:` に関するものであり、独自スキームの `src="myscheme://..."` は
  **通常のネットワークナビゲーションと同じ経路**（別オリジンへの `src` 遷移）なので、ここでは継承ではなく
  「そのレスポンスが自分の CSP ヘッダを持つか」が効く。ハンドラが `Content-Security-Policy` ヘッダを返せば、
  そのヘッダが iframe 内ドキュメントの policy container になる（HTML 標準の「レスポンスから policy container を
  作る」アルゴリズムに沿う一般的な HTTP ナビゲーションの挙動）。この一般論を独自スキームについて明示した
  Tauri 側の一次ソースは見つからなかった（未確認）。

## 3. IPC 到達性と、外部読み込み・ページ遷移の遮断

### IPC

- Tauri v2.0.0-beta.19 以前は、capability で許可していないリモートオリジンの iframe からも IPC を呼べる
  脆弱性があった（CVE-2024-35222）。v2.0.0-beta.20 で `__TAURI_INVOKE_KEY__` が導入され、Tauri コアが
  初期化していないフレームからの IPC 呼び出しは警告ログを出して無視される。例外は「Windows で、Tauri
  ウィンドウと iframe のオリジンが同じ場合」。この鍵は「侵害された Tauri ウィンドウ/WebView を守るものでは
  なく、サブフレームからの IPC を塞ぐだけ」と明記されている。
  [GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)
- capability は「どのウィンドウ/webview に、どの権限を許可するか」を定める。`windows` 配列でラベルまたは
  ワイルドカードで対象を指定する。加えて Capabilities のドキュメントは
  **「Linux と Android では、Tauri は埋め込まれた `<iframe>` からのリクエストとウィンドウ自身からの
  リクエストを区別できない」**と明記している。つまりこれらのプラットフォームでは、iframe に対して
  ウィンドウより狭い capability を与える、という区別が構造的にできない。
  [Tauri: Capabilities](https://v2.tauri.app/security/capabilities/)
- したがって「iframe に IPC が届かない」と言い切れるのは、`__TAURI_INVOKE_KEY__` によるフレーム未初期化の
  遮断（Windows の同一オリジン例外を除く）による。Linux/Android では capability による絞り込みではなく、
  この鍵の仕組みだけが頼りになる。iframe に `allow-scripts` を与えない（= フレーム内で JS が一切実行できない）
  構成であれば、そもそも IPC を呼び出すスクリプトが動かないので、この鍵の穴を突く余地自体がない。
  [GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)、
  [Tauri: Capabilities](https://v2.tauri.app/security/capabilities/)
- Isolation パターンは IPC メッセージを暗号化・検査する別の防御層で、iframe 内コンテンツの隔離とは別の話
  （#24 で確認済み）。
  [Tauri: Isolation Pattern](https://v2.tauri.app/concept/inter-process-communication/isolation/)

### 外部リソース読み込み・ページ遷移の遮断

- `sandbox` 属性は空にするとすべての制限がかかる（スクリプト実行、フォーム送信、ポップアップ、
  トップレベルナビゲーションなど）。個別に緩めるトークン（`allow-scripts`、`allow-forms`、`allow-popups`、
  `allow-top-navigation` 等）を明示的に付けない限り、それぞれの機能は働かない。
  [MDN: `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- ガイド表示用の iframe では `allow-scripts` を付けない（= JS 実行不可）ことを前提にすれば、トップレベル
  ナビゲーションやポップアップ、フォーム送信は `sandbox` の既定ですでに止まる（`allow-top-navigation` や
  `allow-popups` を付けなければ機能しない）。
  [MDN: `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- 外部リソース（画像・フォント・別ドキュメントなど）の読み込みは `sandbox` ではなく CSP の各 `-src` 系
  ディレクティブ（`img-src`、`font-src`、`connect-src`、`frame-src` など）で制御する。`frame-src` は
  `<iframe>`/`<frame>` が読み込める送信元を制御し、`frame-ancestors`（自分を誰が埋め込めるか）とは別。
  [MDN: CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src)
- CSP Level 2 で提案された `navigate-to` ディレクティブ（トップレベルナビゲーション先を制限する）は、
  現行の MDN の CSP ディレクティブ一覧には存在しない。現行仕様での扱いは一次ソースで確認できなかった
  （未確認。ナビゲーション遮断は `sandbox` の `allow-top-navigation*` 系トークンを付けないことで代替する）。
  [MDN: CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src)
- §1 の継承規則により、`srcdoc`/`data:`/`blob:` の iframe は親の CSP（`connect-src`/`img-src` 等）も
  継承する。したがって親アプリの CSP がすでに外部オリジンへの接続を絞っていれば、iframe 内からの
  「スクリプトを介さない」読み込み（例えば CSS の `url()` 経由の画像取得）もその CSP に従う。
  独自スキーム配信（§2）の場合は、iframe 用に別の CSP ヘッダを付けられるので、より狭い `-src` を
  独立に設定できる可能性がある（未確認: 実機動作）。

## 4. スクリプトなしで iframe の高さを親に合わせる方法と、`allow-same-origin` の安全性

- `sandbox="allow-same-origin"` を付け、`allow-scripts` を付けない構成では、iframe 内で JavaScript は
  一切実行されない。一方 MDN は「埋め込みドキュメントが埋め込み元と同一オリジンの場合、`allow-scripts` が
  無くても同一オリジンの親は iframe の DOM にアクセスできる」と明記している。これにより、**親側（アプリの
  React コード）が `iframe.contentDocument.body.scrollHeight` のようなプロパティを読み、iframe要素の
  `height`/`style.height` を書き換える**という、iframe 内では一切スクリプトを実行しないやり方で高さ調整できる。
  [MDN: `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- ただしこの手法が成立するには「iframe が親と同一オリジン」である必要がある。`srcdoc` は §1 の通り
  `about:srcdoc` として親のオリジンをそのまま引き継ぐため、同一オリジンとして扱われる見込みが高い
  （未確認: 実機の同一オリジン判定）。独自スキーム配信（§2）で iframe を別オリジンにした場合は、
  `allow-same-origin` を付けても同一オリジンにならないため、この方法は使えず `postMessage` 経由で
  子から高さを能動的に伝える必要がある（ただし子が `postMessage` を呼ぶには `allow-scripts` が要る）。
  [MDN: Window.postMessage()](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- `allow-same-origin` の安全性への影響: MDN は「埋め込みドキュメントが埋め込み元と**同一オリジン**の場合、
  `allow-scripts` と `allow-same-origin` の**両方**を付けるのは強く非推奨」と明記する。理由は、両方を
  付けると埋め込み側のスクリプトが自分自身から `sandbox` 属性を外せてしまい、`sandbox` を付けていないのと
  同じになるため。
  [MDN: `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- 本ケースでは `allow-scripts` を付けない前提なので、この既知の抜け穴（`allow-scripts`＋`allow-same-origin`
  の併用）自体は発生しない。`allow-same-origin` だけを付けた場合の残る意味は、「iframe 内のスクリプトが
  自分の sandbox を外す」経路ではなく、「**親から** iframe の DOM に（同一オリジンの扱いにより）触れる」
  ことだけになる。iframe 内で JS が動かない以上、iframe 側から能動的に何かする余地はない。
  [MDN: `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- 高さ調整以外に副作用がないかは、`allow-same-origin` によって「同一オリジンの親からの DOM 操作」全般が
  可能になる点に注意が必要（読み取りだけでなく書き込みも可能）。読み取り専用の高さ計測に留める運用は
  アプリ側のコード規律であり、`sandbox` 属性自体はそこまで制限しない（未確認: sandbox 属性による
  読み取り専用強制の有無。MDN・CSP3 のいずれにもそのような記述は見当たらなかった）。

## 5. アプリのテーマ（ライト/ダーク、フォント、色変数）を iframe 内の HTML に渡す方法

- **CSS カスタムプロパティの継承**: カスタムプロパティ（`--foo`）は通常のCSSプロパティと同様カスケードに従い
  親要素から子要素へ継承されるが、これは**同一ドキュメント内のツリー**での話であり、iframe は別ドキュメントに
  なるため、親ドキュメントの `:root` に定義したカスタムプロパティは iframe の中には自動では継承されない。
  同一オリジンであっても iframe は別のドキュメント境界であり、スタイルは自動伝播しない。
  [MDN: Using CSS custom properties](https://developer.mozilla.org/en/docs/Web/CSS/Using_CSS_custom_properties)（カスタムプロパティの継承規則）。
  iframe 境界を越えて伝播しないことの明確な一次仕様記述は見つけられなかった（未確認。ただし同一オリジンの
  iframe に親から `contentDocument` 経由でアクセスできるなら、親のコードが子の `:root` に直接
  `style.setProperty()` するか、`<link>`/`<style>` を注入することでカスタムプロパティを渡すことは可能。
  これは §4 の「同一オリジンなら親から DOM 操作できる」性質の応用）。
- **`postMessage`**: 別オリジンの iframe には `postMessage()` で任意の構造化複製可能なデータを送れる。
  受信側は `message` イベントで受け取り、`event.origin` を検証してから処理する必要がある。送信側は
  `targetOrigin` を `*` にせず、送り先のオリジンを明示することが強く推奨される（`data:` 由来のオリジンだけ
  例外的に `*` が要る）。テーマ値（ライト/ダーク、フォント名、色のカスタムプロパティの値）を
  `{ type: "theme", vars: { "--color-bg": "#fff", ... } }` のような JSON として送る使い方自体は MDN に
  明記されていない（一般的な postMessage の用途からの適用であり、確認できたのは postMessage の仕組みそのもの）。
  子側でこれを受け取るには `allow-scripts` が要る。
  [MDN: Window.postMessage()](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- **クエリパラメータ / URL フラグメント**: `srcdoc` では URL 自体が `about:srcdoc` になるため使えない。
  独自スキーム配信（§2）で `src="myscheme://guide/render?theme=dark&font=..."` のように渡す方式は、
  iframe を読み込み直す（毎回 URL を変える）必要があり、テーマがランタイムで切り替わる場合は iframe の
  再読み込みが発生する。ページ全体をサーバー側（ハンドラ）でテーマ差し込み済みの HTML として返す設計になる。
  この方式のメリット・デメリットは Tauri や MDN の一次ソースには記述がなく、一般的な URL 設計の帰結
  （未確認: 実機でのちらつき等の体験）。
- 制約のまとめ: `allow-scripts` を付けない（＝子がメッセージを受信できない）構成では `postMessage` は使えず、
  クエリパラメータ渡し（iframe 再読み込み）か、同一オリジンの場合に限り親からの直接 DOM/スタイル注入
  （§4 と同じ機構）のどちらかになる。別オリジンかつスクリプトなしという組み合わせでは、テーマは
  **iframe を作る/差し替える時点**でしか渡せない。

## 6. WKWebView / WebKitGTK の iframe 内で CSS アニメーションと SMIL は動くか

- #24 の調査では、メインドキュメント文脈での CSSOM・静的 CSS アニメーションと、Tauri の
  Webview Versions ページの存在までは確認したが、**iframe 内かつ別オリジンのケース**は未調査だった。
  [docs/research/diagram-rendering.md](https://github.com/todokr/doctrine/blob/research/diagram-rendering/docs/research/diagram-rendering.md)
- 本調査でも、WebKit公式ブログ（webkit.org/blog）の一覧を確認したが、SMIL・CSS アニメーションが
  iframe の中で（トップレベルドキュメントと異なる扱いを受けるかどうかを含めて）動作するかを明記した
  投稿は見つからなかった。
  [WebKit Blog](https://webkit.org/blog/)
- WebKitGTK の公式リリースノートも確認した。2.50（2025年11月）は「CSS Animations: overallProgress の既定有効化」、
  2.52（2026年3月）は「run-loop observer を使ってレイヤーのフラッシュとコンポジションを適切にスケジューリングし、
  描画とアニメーションの性能が改善した」といった記述があるが、いずれも SMIL や iframe 特有の扱いには触れていない。
  [WebKitGTK: Highlights of WebKitGTK+ 2.50](https://webkitgtk.org/2025/11/26/webkitgtk-2.50.html)、
  [WebKitGTK+ 2.52 highlights](https://webkitgtk.org/2026/03/18/webkitgtk-2.52-highlights.html)
- CSS アニメーション・SMIL はいずれも CSS/SVG の仕様上「ドキュメント単位」の機能であり、iframe は
  それ自体が独立したドキュメント（ブラウジングコンテキスト）としてレンダリングされるため、**トップレベル
  文書で動くレンダリング機能は iframe 内でも同様に動く**というのが一般的な Web プラットフォームの前提だが、
  これを WKWebView / WebKitGTK について明記した一次ソースは見つけられなかった。
- 結論: **未確認**。WKWebView・WebKitGTK の iframe 内での CSS アニメーション・SMIL 動作について、
  一次情報から追加で確認できたことはなかった。確認するには実機（対象 macOS の Safari 相当バージョンの
  WKWebView、対象 Linux ディストリビューションの WebKitGTK）での動作テストが必要になる。

## 7. iframe を使わない代替: Shadow DOM + サニタイズ（DOMPurify 等）でメイン DOM に直接挿入

- DOMPurify は Shadow DOM をサポートしており、「DOM テンプレートを再帰的にサニタイズする」機能がある
  （Shadow DOM を経由した挿入先の指定・テンプレート走査に対応、という意味。Shadow DOM が CSP から独立する、
  という意味ではない）。
  [cure53/DOMPurify README](https://github.com/cure53/DOMPurify)
- **Shadow DOM は CSP から独立しない**: CSP Level 3 の仕様には `shadow`/`shadow root`/`shadow tree` への
  言及が一切ない。CSP のリストは「グローバルオブジェクトの CSP リスト」として取得され、対象が `Document`
  の場合は「その `Document` の policy container の CSP リスト」を返す、とだけ定義されている。Shadow root は
  DOM 仕様上その `Document` に属する（ノードのオーナードキュメントは shadow root であっても変わらない）ため、
  CSP は Shadow DOM に対して**別の適用範囲を持たず、ページ全体の CSP（`style-src`/`script-src` を含む）が
  そのまま shadow tree 内の要素にも適用される**。
  [W3C: CSP Level 3 §4.2.2「Get the CSP of an object」相当の記述](https://www.w3.org/TR/CSP3/)
- 実例としての裏付け: 厳しい `style-src`（インライン禁止）を持つページに、`<style>` 要素を注入する
  Shadow DOM コンポーネントを組み込んだところ、ページの CSP 違反として扱われたという報告がある
  （Shadow DOM 内の `<style>` はページの `style-src` の対象になる、という Shadow DOM 側の一次ドキュメントに
  よらない実例）。
  [hypothesis/client #293](https://github.com/hypothesis/client/issues/293)
- したがって、Tauri がビルド時に `style-src` へノンスを注入した状態のまま、エージェントが書いた
  `<style>` 要素や `style` 属性を DOMPurify で無害化して Shadow DOM に挿入しても、§1 で確認した
  「ノンスのない `<style>`/`style` 属性は拒否される」制約はそのまま働く。Shadow DOM を使う場合でも
  `dangerousDisableAssetCspModification: ["style-src"]` のような CSP の緩和が必要になる見込みが高い
  （#24 §1、本書 §1 と同じ結論）。
- DOMPurify 自体の無害化能力（#24 で確認済みの内容の再掲）: SVG 用の許可リストでは `animate`/`set`/
  `foreignObject`/`script` は既定で除かれ、`animateMotion`/`animateTransform` と `style` 要素は許可される。
  `style` 要素が残るため、CSS 注入（見た目の偽装）の面は無害化後も残る。
  [DOMPurify: tags.ts](https://github.com/cure53/DOMPurify/blob/main/src/tags.ts)、
  [docs/research/diagram-rendering.md §3-C-1](https://github.com/todokr/doctrine/blob/research/diagram-rendering/docs/research/diagram-rendering.md)
- Shadow DOM 方式は iframe と異なり、`sandbox` 属性や `srcdoc`/`data:`/`blob:` の policy container 継承
  （§1）の対象にならない ― そもそも別ドキュメントではなくメインドキュメントの一部なので、独自の CSP を
  持たせる余地自体がない。CSP を緩めるなら、iframe 方式（別オリジン配信で独立した CSP を与える、§2）より
  Shadow DOM 方式の方が「アプリ全体の CSP を緩める」影響が大きい（Shadow DOM はメイン文書の CSP の外に
  出られないため、緩和は文書全体に効く）。

## 未確認のまま残したこと

- `srcdoc`/`data:`/`blob:` の policy container 継承規則について、WHATWG HTML 本文の該当アルゴリズム
  （ステップ番号を含む正確な記述）は今回 WebFetch で断片しか取得できず、共同提案者による解説
  （antosart/policy-container-explained）を代替の参照にした。HTML 標準の本文で該当セクションを直接
  確認できていない。
- 独自スキーム配信のレスポンスに積んだ `Content-Security-Policy` ヘッダが、実機の WKWebView /
  WebKitGTK / WebView2 で実際にそのドキュメントの policy container として適用されるかどうかの実機確認。
- 独自スキームの iframe から独自スキームのスクリプトを読み込めない、という Tauri v1 時代の報告
  （#3543）が v2 で解消しているか。
- `navigate-to` ディレクティブの現行 CSP 仕様での扱い（MDN の一覧には存在しない）。
- CSS カスタムプロパティが iframe 境界を越えて継承されないことの一次仕様上の明記。
- WKWebView・WebKitGTK の **iframe 内**での CSS アニメーション・SMIL の動作（トップレベル文書での
  動作は #24 で Baseline 対応が確認済みだが、iframe・別オリジンでの挙動は一次情報を見つけられなかった）。
- `allow-same-origin` のみを付けた sandbox iframe で、親から子への「読み取り専用」の強制が sandbox 属性
  自体にあるかどうか（無いと考えるのが妥当だが、明記した一次ソースは見つからなかった）。
