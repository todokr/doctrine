# 図とアニメーションを Tauri の WebView と GitHub の PR 本文の両方で表示する方法

チケット: #24（地図 #23）。調査日: 2026-09-15。

この文書は選択肢ごとの事実と制約を並べるだけで、形式は決めない（決定は #29）。
出典は各項の末尾に付けた。一次ソースで確かめられなかったことは「未確認」と書いた。

## 前提

- UI は Tauri + React + Vite。WebView は Windows が WebView2（Chromium）、macOS が WKWebView、Linux が WebKitGTK。
  Linux の WebKitGTK の版はディストリビューションで違い、正確な情報を集めにくいと Tauri 自身が書いている。
  [Tauri: Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- プロトタイプ `prototype/review-app-mvp.html` は、ガイドの `sequence: { actors, messages }` から画面側の関数
  `sequenceSvg()` で SVG 文字列を組み立て、CSS の `stroke-dashoffset` と `@keyframes` で矢印を順に描く。
  遅延は `style="--d:0.14s"` の style 属性で渡し、ラベルは `<foreignObject>` 内の `style` 属性つき `<div>` で出している。
  `prefers-reduced-motion` ではアニメーションを止める。関係図 `relationSvg()` は固定の SVG。

## 1. Tauri 側の制約（どの選択肢にも効く）

### CSP とノンス

- Tauri はビルド時にフロントエンドの資産を解析し、`script-src` と `style-src` にハッシュとノンスを注入する。
  「ローカルのスクリプトはハッシュ化され、スタイルと外部スクリプトは暗号学的ノンスで参照される」。
  CSP は `tauri.conf.json` の `app.security.csp` を設定したときだけ有効になる。
  [Tauri: Content Security Policy](https://v2.tauri.app/security/csp/)
- この自動注入は `dangerousDisableAssetCspModification` で全体または指令ごと（例 `["style-src"]`）に止められる。
  設定リファレンスは「分かっている場合だけ無効にせよ。XSS に弱くなりうる」と警告している。
  [Tauri: Configuration (SecurityConfig)](https://v2.tauri.app/reference/config/)
- CSP Level 3 の仕様では、ソースリストにノンスかハッシュが1つでもあれば `'unsafe-inline'` は無視される
  （「Does a source list allow all inline behavior for type?」の手順で、nonce-source / hash-source があれば "Does Not Allow" を返す）。
  [W3C: CSP Level 3 §6.7.3.2](https://www.w3.org/TR/CSP3/)
- したがって Tauri が `style-src` にノンスを注入した状態では、実行時に差し込んだ `<style>` 要素と `style="..."` 属性は、
  `'unsafe-inline'` を書いても通らない。CSS-in-JS の質問に対し Tauri のメンテナは、静的に書き出せないなら
  `"dangerousDisableAssetCspModification": ["style-src"]` と `style-src 'self' 'unsafe-inline'` の組み合わせが
  「唯一の解」だと答えている。
  [tauri-apps/tauri Discussion #8578](https://github.com/tauri-apps/tauri/discussions/8578)
- 一方、JavaScript から `element.style` プロパティ（CSSOM）で設定したスタイルは `style-src` で止められない。
  React の `style` prop はこの経路で設定される。
  [MDN: CSP style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src)
- プロトタイプへの含意（事実の整理のみ）: 文字列で組んだ SVG の `style="--d:..."` 属性と `<foreignObject>` 内の
  `style` 属性は、Tauri の既定の CSP 変更の下では効かない。同じ SVG を React の要素として組み、
  `style` prop（CSSOM）かクラスで渡せば、この制約には当たらない。これは本番の WebView での動作確認をしていない。

### IPC と iframe

- Tauri v2.0.0-beta.19 以前には、リモートオリジンの iframe が capability で許可されていないのに IPC を呼べる脆弱性があった
  （CVE-2024-35222）。v2.0.0-beta.20 で、Tauri コアが初期化していないフレームからの IPC を拒むための
  `__TAURI_INVOKE_KEY__` が入り、iframe での IPC 初期化は無効になった。
  例外は「Windows で Tauri ウィンドウと iframe のオリジンが同じとき」。
  この鍵は「侵害された Tauri ウィンドウや WebView を守るものではなく、サブフレームからの IPC を塞ぐだけ」。
  回避策としては「信頼できないオリジンには iframe でなく専用ウィンドウを使う、または iframe 内のスクリプト実行を無効にする」が挙がっている。
  [GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)
- つまり、メインの WebView の DOM に差し込んだものがスクリプトを実行できれば、そのスクリプトはアプリのフロントエンドと同じ権限で IPC を呼べる。
  呼べるコマンドの範囲はウィンドウ/WebView ごとの capability で決まる。
  [Tauri: Capabilities](https://v2.tauri.app/security/capabilities/)
- Isolation パターンは、フロントエンドから Tauri コアへ行く IPC メッセージを、サンドボックス化した iframe 内の JavaScript で検査・改変してから
  AES-GCM で暗号化して渡す仕組み。想定する脅威は依存パッケージなど開発側から入る不正な呼び出しで、
  「多くのアプリは暗号化のコストに気づかない」。Windows ではサンドボックス iframe で外部ファイルが読めないためスクリプトをインライン化する制約がある。
  [Tauri: Isolation Pattern](https://v2.tauri.app/concept/inter-process-communication/isolation/)
- 現行の `@tauri-apps/api` は 2.11.1（npm, 2026-09-15 時点）。

## 2. GitHub の PR 本文の制約

- Markdown で描画される図の記法は mermaid、GeoJSON、TopoJSON、ASCII STL の4つ。Issues、Discussions、PR、Wiki、Markdown ファイルで描画される。
  サードパーティの mermaid プラグインを使うとエラーになりうる。GitHub が使う mermaid の版は、
  ` ```mermaid ` ブロックに `info` と書くと表示される。
  [GitHub Docs: Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)
- 描画の仕組み: HTML パイプラインのフィルタが `mermaid` 指定の `pre` を見つけ、Viewscreen サービスを指す iframe を差し込む。
  JavaScript のない環境（API 経由など）では元の Markdown のコードが見える。
  [GitHub Blog: Include diagrams in your Markdown files with Mermaid](https://github.blog/developer-skills/github/include-diagrams-markdown-files-mermaid/)
  - mermaid の `click` を使うと「This content is blocked」と出るという報告がある。
    [GitHub Community Discussion #46096](https://github.com/orgs/community/discussions/46096)
- GitHub が今どの mermaid の版を使っているかは一次ソースで確認できなかった（未確認。`info` で確かめる必要がある）。
  mermaid 本体の最新は 12.0.0（2026-09-10 公開、npm）。12.0.0 では ELK が同梱の既定レイアウトになり、
  既定のテーマとルックが変わった（`redux-color` + `neo`）。GitHub がどちらの版かで見た目が変わりうる。
  [mermaid 12.0.0 release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0)
- mermaid 自体の上限は既定で `maxTextSize: 50000`（文字数）、`maxEdges: 500`。GitHub がこれを変えているかは未確認。
  [mermaid: config schema](https://mermaid.js.org/config/schema-docs/config.html)
- PR 本文の長さは 65536 文字が上限という API エラーが多数報告されている（公式ドキュメントでの記載は見つけられなかった）。
  [GitHub Community Discussion #27190](https://github.com/orgs/community/discussions/27190)、
  [renovatebot/renovate #14551](https://github.com/renovatebot/renovate/issues/14551)
- 生の HTML: GitHub.com の実際の許可リストは公式に文書化されていない。GitHub が公開している html-pipeline の
  サニタイズフィルタでは、`svg` 要素も `style` 属性も許可リストにない（`img`、`picture`、`details` などは許可）。
  インライン SVG や `<style>` を本文に書いて描画・アニメーションさせることはできないと考えるのが安全。
  [html-pipeline: sanitization_filter.rb](https://github.com/gjtorikian/html-pipeline/blob/main/lib/html_pipeline/sanitization_filter.rb)
- 画像添付: SVG、GIF、PNG/JPEG と動画（.mp4, .mov, .webm）を添付できる。画像と GIF は 10MB、動画は無料プランで 10MB、有料プランで 100MB。
  [GitHub Docs: Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
- Markdown の画像は Camo でプロキシされる。Camo の許可する Content-Type に `image/svg+xml` は含まれる。
  [GitHub Docs: About anonymized URLs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)、
  [atmos/camo mime-types.json](https://github.com/atmos/camo/blob/master/mime-types.json)
- リポジトリ内の SVG を `raw.githubusercontent.com` から取ると、`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
  が付く（2026-09-15 に `curl -I` で確認）。
- `<img>` として読み込んだ SVG では JavaScript が無効になり、外部リソースは読めない（data: URL は可）。
  [MDN: SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)
  画像としての SVG 内で CSS/SMIL アニメーションが動くかは、MDN のこのページに明記がない（未確認）。

## 3. 選択肢ごとの事実と制約

### A. 構造化データから画面側のコードで SVG を組む（プロトタイプの方式）

- エージェントが出すのは `actors` / `messages` のようなデータだけで、描画するコードはアプリ側にある。
  文字列はテキストノードか属性値としてエスケープされて入るので、データからスクリプトは生まれない。
  overview 8章「設定はデータであって、実行可能コードではない」（YAML にし、スキーマで検証する）と同じ形になる。
- CSP: React 要素として組めば、style prop は CSSOM 経由でノンス注入の制約に当たらない（§1）。
  文字列を `innerHTML`/`dangerouslySetInnerHTML` で入れる場合は style 属性が止まる（§1）。
- アニメーション: CSS（`@keyframes` をアプリの静的 CSS に置く）でも、描画側のコード（Web Animations API など）でも付けられる。
- 描画の速さ: 外部ライブラリの読み込みもレイアウト計算もないので、図の数が少ない限り問題になりにくい（計測はしていない）。
- 図の種類ごとに描画コードを書く必要があり、表現できる図はアプリが用意した種類に限られる。
- GitHub: この表現は GitHub では描画されない。PR 本文には別の形（mermaid への変換、画像など）が要る。
  データから mermaid のテキストを生成する経路はコードで書ける（ライブラリを使わない文字列生成）。

### B. mermaid をアプリに同梱して描画する

- 同梱: npm の `mermaid` を Vite で取り込める。12.0.0 の `dist/mermaid.min.js`（IIFE の単一ファイル）は 5.58MB、gzip で約 1.60MB。
  ESM 版のエントリ `mermaid.esm.min.mjs` は 30KB で、図の種類ごとのコードは `import()` で遅延読み込みされる
  （例: シーケンス図のチャンクは 118KB、ELK のチャンクは 1.61MB）。オフラインでもローカル資産として読める。
  （サイズは 2026-09-15 に `npm pack mermaid@12.0.0` を展開して計測）
  [mermaid: sequenceDetector.ts](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/diagrams/sequence/sequenceDetector.ts)、
  [mermaid: loadDiagram.ts](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/diagram-api/loadDiagram.ts)
- ELK を含まない小さい「Tiny Mermaid」ビルドがあり、約半分のサイズ（Mindmap、Architecture、KaTeX、ELK を除く。ELK 指定時は dagre に戻る）。
  [mermaid: Usage](https://mermaid.js.org/config/usage.html)、[mermaid 12.0.0 release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0)
- 12.0.0 は Safari 17.4+ / ES2024 を対象にビルドされている。WKWebView は OS 更新でしか上がらないので、対象 macOS の Safari 相当の版に依存する。
  [mermaid 12.0.0 release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0)、[Tauri: Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- API: `const { svg, bindFunctions } = await mermaid.render(id, text)` で SVG 文字列を得て DOM に入れる。
  描画は DOM 上で行われる（テキストの計測などに一時要素を使う）。
  [mermaid: Usage](https://mermaid.js.org/config/usage.html)
- CSP との相性:
  - mermaid は生成する SVG に `<style>` を埋め込む（`createCssStyles` でテーマとユーザー定義の CSS を組み立てる）。
    [mermaid: mermaidAPI.ts](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/mermaidAPI.ts)
    厳しい `style-src` の下でインライン CSS が拒否される問題は mermaid に古くから報告されている。
    [mermaid-js/mermaid #856](https://github.com/mermaid-js/mermaid/issues/856)
  - Tauri の既定の CSP 変更（`style-src` へのノンス注入）の下では、§1 の理由でこの `<style>` は通らない。
    `dangerousDisableAssetCspModification: ["style-src"]` と `style-src 'unsafe-inline'` が必要になる見込み（Tauri での実機確認はしていない）。
  - テーマが Google Fonts を `@import` し CSP 違反になるという第三者の報告がある（mermaid の一次ソースでは未確認）。
    [nesquena/hermes-webui #1044](https://github.com/nesquena/hermes-webui/issues/1044)
- securityLevel:
  - `strict`（既定）: ラベル中の HTML をエンコードし、click を無効にする。`antiscript`: script 要素だけ除く。`loose`: HTML と click を許す。
  - `sandbox`: 描画全体をサンドボックス iframe で行い、JavaScript が文脈内で動かない。ポップアップやリンクなどの対話機能は妨げられうる。
    [mermaid: Usage](https://mermaid.js.org/config/usage.html)
  - 実装では、`sandbox` のとき SVG を `data:text/html;base64,...` の `src` と `sandbox="allow-top-navigation-by-user-activation allow-popups"`
    （`allow-scripts` なし）の iframe に入れる。それ以外のレベルでは出力を DOMPurify で無害化する（`foreignobject` を追加で許可）。
    [mermaid: mermaidAPI.ts](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/mermaidAPI.ts)
    `sandbox` を Tauri で使うなら CSP の `frame-src`（または `child-src`/`default-src`）で `data:` を許す必要がある。
    data: の iframe 内の `<style>` に親の CSP がどう効くかは WebView での確認が要る（未確認）。
  - `secure` に列挙された設定（`securityLevel`、`maxTextSize`、`maxEdges` など）は `mermaid.initialize` からしか変えられず、図のテキスト側の指示では変えられない。
    [mermaid: config schema](https://mermaid.js.org/config/schema-docs/config.html)
- 脆弱性の履歴: 2026年だけで、state 図の `classDef` からの HTML 注入（CVE-2026-41149、11.15.0 / 10.9.6 で修正、アドバイザリは緩和策に `sandbox` を挙げる）、
  classDef や設定経由の CSS 注入、Gantt・XY Chart・radar の無限ループ DoS、Architecture 図と設定 API のプロトタイプ汚染などのアドバイザリが出ている。
  2025年には Architecture 図の iconText の XSS（Critical）があった。エージェントが書いた mermaid テキストは、この攻撃面を通って描画される。
  [GHSA-ghcm-xqfw-q4vr](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-ghcm-xqfw-q4vr)、
  [mermaid Security overview](https://github.com/mermaid-js/mermaid/security)
- 描画の速さ: 公式のベンチマークは見つからなかった（未計測）。初回は図の種類のチャンクの読み込みが入り、ELK レイアウトでは 1.6MB のチャンクを読む。
- アニメーション: flowchart の辺に ID を付け `{ animate: true }`（速さは `fast` / `slow`）または `classDef` で `stroke-dasharray` などを指定して動かせる。
  ドキュメントの例は flowchart だけで、シーケンス図の矢印を順に描くような指定は見当たらない。GitHub の mermaid でこれが動くかは版次第（未確認）。
  [mermaid: Flowchart syntax](https://mermaid.js.org/syntax/flowchart.html)
- 描画後の SVG に対し、アプリの CSS やコードでアニメーションを後から付けることもできる（mermaid の要素クラスや ID に依存する）。
- GitHub との関係: 同じ mermaid テキストを PR 本文の ` ```mermaid ` に置けば GitHub でも描画される。ただしアプリ同梱版と GitHub の版が一致する保証はない。
- 原則との関係: mermaid テキストは実行可能コードではないが、パーサと描画器という大きな攻撃面を通る「データ」になる。
  `%%{init: ...}%%` などの指示で図側から設定を一部変えられる（`secure` 以外）。

### C. エージェントが書いた SVG / HTML をそのまま出す

危険:

- インラインで DOM に入れた SVG/HTML は、`<script>`、`on*` イベント属性、`javascript:` URL、`<foreignObject>` 内の HTML、`<animate>`/`<set>` による属性書き換えなどで
  スクリプト実行や DOM 注入の経路を持つ。メインの WebView でスクリプトが動けば、フロントエンドと同じ capability で IPC を呼べる（§1）。
- Tauri の CSP はスクリプトをハッシュで縛るので、差し込んだ `<script>` やイベント属性は既定では実行されにくい。ただしこれは CSP の設定に依存する多層防御の1枚で、
  CSS 注入（見た目の偽装、UI を覆う）は `style-src` を緩めていれば止まらない。
- overview 8章の原則の言い方でいえば、エージェントの出力を「実行されうる形式」で受け取ることになり、データとして検証する形から外れる。

無害化・隔離の手段:

1. **DOMPurify で無害化してからインラインに入れる**（3.4.15）。`USE_PROFILES: { svg: true }` で SVG を許す。
   `svgDisallowed` に `animate`、`set`、`foreignobject`、`script` が入っており既定で除かれる。`animatemotion`、`animatetransform` と `style` 要素は SVG の許可リストにある。
   `RETURN_TRUSTED_TYPE` で Trusted Types と組める。無害化の後に文字列を加工すると安全性が崩れる。
   [cure53/DOMPurify](https://github.com/cure53/DOMPurify)、[DOMPurify: tags.ts](https://github.com/cure53/DOMPurify/blob/main/src/tags.ts)
   - `<style>` が残るので CSS 注入の面は残り、また Tauri の `style-src` の制約（§1）にも当たる。
2. **`<img src="data:image/svg+xml,...">` や blob URL で画像として出す**。画像としての SVG ではスクリプトが無効で外部リソースも読めない。
   [MDN: SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)
   CSP の `img-src` で `data:` か `blob:` を許す必要がある（Tauri の例に `img-src 'self' asset: http://asset.localhost blob: data:` がある）。
   [Tauri: Content Security Policy](https://v2.tauri.app/security/csp/)
   テキスト選択やリンクなどの対話はできない。
3. **サンドボックス iframe（`sandbox` 属性、`allow-scripts` なし、`srcdoc` か data: URL）**。空の `sandbox` はすべての制限を課す。
   同一オリジンの文書に `allow-scripts` と `allow-same-origin` を併用すると、中から `sandbox` を外せるので無意味になる。
   [MDN: iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
   Tauri v2 では iframe に IPC は初期化されない（Windows の同一オリジンを除く）（§1）。
   高さの自動調整などは親子間の通信なしにはできない。
4. **別ウィンドウ / 別 WebView に分け、capability を与えない**。Tauri のアドバイザリが信頼できないオリジン向けに挙げる方法。
   [GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)、[Tauri: Capabilities](https://v2.tauri.app/security/capabilities/)
5. **Isolation パターン**で IPC 呼び出しを検査する。これは IPC の手前の検査で、描画の隔離ではない。
   [Tauri: Isolation Pattern](https://v2.tauri.app/concept/inter-process-communication/isolation/)

GitHub との関係: インライン SVG・`<style>` は本文で使えない（§2）。SVG を画像として添付するか、リポジトリ内のファイルを `<img>` で参照する形になる。

### D. 画像ファイル（静止 SVG/PNG、GIF、動画）として持つ

- GitHub では添付の画像・GIF・動画として表示でき、上限は §2 のとおり。
- 生成には描画器が必要（mermaid をヘッドレスブラウザで動かす、A の描画コードをデーモン側で動かすなど）。デーモン（Deno）で DOM なしに mermaid は動かない（§B の DOM 依存）。
- Tauri では `<img>` として表示でき、スクリプトは動かない（C-2 と同じ）。
- 画像化した図は差分や読み上げ（`aria-label` など）の情報を失う。

## 4. アニメーションをどの表現で持てるか

| 表現 | Tauri の WebView | GitHub の PR 本文 | 備考 |
| --- | --- | --- | --- |
| アプリの静的 CSS（`@keyframes`） | 可。静的 CSS はノンス/ハッシュの対象で問題ない | 不可（`style` 不許可） | プロトタイプの方式。`prefers-reduced-motion` で止められる |
| 実行時に入れる `<style>` / `style` 属性 | Tauri の既定の CSP 変更の下では不可。`dangerousDisableAssetCspModification` が要る | 不可 | mermaid の出力、文字列で組む SVG が該当 |
| CSSOM（React の `style` prop、`element.style`） | 可（CSP で止まらない） | 不可 | |
| 描画側のコード（Web Animations API など） | 可 | 不可 | アニメーションの定義はアプリ側に置ける |
| SMIL（`<animate>` など） | WebView では Baseline（2020年1月から全ブラウザ） | インライン不可。画像 SVG 内で動くかは未確認 | DOMPurify は `animate`/`set` を既定で除く |
| mermaid の辺アニメーション | 可（flowchart のみ例示。CSS は mermaid の `<style>` 経由なので上の制約あり） | 版次第（未確認） | |
| GIF / 動画 | 可 | 可（添付上限あり） | 生成に描画器と録画が要る |

SMIL の Baseline: [MDN: `<animate>`](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/animate)

## 5. 両方で表示するときの組み合わせ（事実の整理）

- Tauri と GitHub で**同じ表現がそのまま動くのは mermaid テキストと画像ファイルだけ**。
  - mermaid: 版の不一致、Tauri の `style-src` 設定の変更、mermaid 自体の攻撃面が付いてくる。アニメーションは GitHub 側では当てにできない。
  - 画像: 対話と読み上げを失い、生成の仕組みが要る。
- それ以外は、アプリ側と GitHub 側で別の表現を持つことになる。データ（A の構造）を正とし、アプリは描画コード、GitHub は mermaid テキストや画像を生成する、という分け方は技術的に可能。
- エージェントが書いた SVG/HTML を直接出す形は、GitHub では使えず、Tauri では隔離（C の 2〜4）が前提になる。

## 未確認のまま残したこと

- GitHub が現在使っている mermaid の版と、辺アニメーションや 12.x の新テーマが GitHub で効くか（`info` ブロックで確認できる）
- GitHub がインライン HTML に適用している実際の許可リスト（公開の html-pipeline は参考）
- 画像として読み込んだ SVG 内の CSS/SMIL アニメーションが GitHub（Camo 経由）と各 WebView で動くか
- mermaid を Tauri の本番ビルド（ノンス注入あり）で描画したときの実際の CSP 違反の内容、`sandbox` レベルの data: iframe の挙動
- mermaid の描画時間（WebKitGTK を含む各 WebView での計測）
