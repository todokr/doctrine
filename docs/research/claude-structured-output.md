# Claude Code にスキーマに沿った構造化出力を出させる方法（調査）

チケット: #25（地図 #23）／調査日: 2026-09-15／ローカルの CLI: `claude --version` → `2.1.272 (Claude Code)`

決定はしない。形式とステップ型は #29・#26 で決める。ここには事実と制約だけを並べる。

## 0. doctrine の現状（`src/adapter/claude.ts`, `src/adapter/ndjson.ts`）

- 起動引数（`buildArgs`）: `-p [--resume <id>] <prompt> --output-format stream-json --verbose [--session-id <uuid>] [--permission-mode <m>] --permission-prompts none [--model <m>]`
- stdout の NDJSON を `readNdjson` で1行ずつ読む。1行の長さに上限は無い（改行まで貯める）。壊れた行は捨てる。
- `normalize` が拾うのは `system`（subtype のみ）、`assistant`（text ブロックだけ連結）、`result`、`rate_limit_event` だけ。`tool_use` ブロックは捨てている。
- `resultFrom` が result 行から読むのは `is_error`・`result`（文字列）・`total_cost_usd`・`num_turns`・`duration_ms`・`permission_denials` だけ。`subtype`・`structured_output`・`terminal_reason`・`stop_reason` は読んでいない。
- 再開は `-p --resume <id> <prompt> ...` の順で、v2.1.269 で動作確認済み（claude.ts のコメント）。

## 1. CLI にスキーマで出力を拘束する機能はあるか

ある。`--json-schema <schema>`。

### フラグと仕様

- ローカルの `claude --help`（2.1.272）: `--json-schema <schema>  JSON Schema for structured output validation.`
- CLI リファレンス: "Get validated JSON output matching a JSON Schema after the agent completes its workflow (print mode only)." 不正なスキーマではエラーで終了する。`format` キーワードは注記として受け付けるだけで検証しない。
  出典: https://code.claude.com/docs/en/cli-reference
- headless のドキュメントの例は `--output-format json` と組み合わせていて、結果は **`structured_output` フィールド** に入る（テキストの結果は従来どおり `result`）。
  出典: https://code.claude.com/docs/en/headless#get-structured-output
- スキーマの値は文字列で渡す（ファイルパスは受け付けない）。ヘルプとドキュメントの例はどれも JSON 文字列を直接渡している。

### 仕組み

- CLI はスキーマから合成した `StructuredOutput` ツールを作り、モデルはそのツールを呼んで答えを出す。CHANGELOG には `StructuredOutput` ツールの修正が繰り返し載っている（2.1.89, 2.1.187, 2.1.196）。issue #92584 は実行ログ `tool=StructuredOutput` と、バイナリ（2.1.263）内の文字列 `Strict structured-output schema derivation failed, falling back to non-strict` を示している。
  出典: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, https://github.com/anthropics/claude-code/issues/92584
- ツール入力の検証は CLI 側（クライアント側）で行う。Agent SDK のドキュメントでは "the SDK validates the output against it, re-prompting on mismatch" と説明されている。検証は JSON Schema **draft-07** で行う（"schemas that declare a newer version are rejected"）。
  出典: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- API 側の strict（文法で拘束するサンプリング）が効いているかどうかは、呼び出し側から見分けられない（#92584、open の feature request）。strict に変換できないスキーマは黙って non-strict に落ちる分岐がある、というのが報告者の主張。一次ドキュメントに strict を保証するという記述は無い。

### バージョン

| 版 | 変化 | 出典 |
|---|---|---|
| 2.1.22 | "Fixed structured outputs for non-interactive (-p) mode" | CHANGELOG |
| 2.1.84 | 外側セッションが `--json-schema`、ワークフローのサブエージェントもスキーマを持つと API 400 になる問題を修正 | CHANGELOG |
| 2.1.89 | 複数スキーマ使用時に `StructuredOutput` のスキーマキャッシュが原因で約50%失敗する問題を修正 | CHANGELOG |
| 2.1.187 | 成功後にモデルが `StructuredOutput` を際限なく呼び直す問題を修正。"follow-up turns now reliably return structured output" | CHANGELOG |
| 2.1.205 | 不正なスキーマを黙って無視しテキストを返していた挙動を、起動時エラーに変更。`format` を含むスキーマが不正扱いされていた問題を修正 | CHANGELOG, headless |
| 2.1.260 | リトライ上限エラーに最後の検証失敗の内容を含めるよう改善 | CHANGELOG |

CHANGELOG: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

2.1.205 で厳しくなった結果、`"$schema": "https://json-schema.org/draft/2020-12/schema"` を宣言したスキーマは `Error: --json-schema is not a valid JSON Schema: no schema with key or ref ...` で起動に失敗する（#80402、open）。回避策は draft-07 を宣言するか `$schema` を消すこと。
出典: https://github.com/anthropics/claude-code/issues/80402

### `--output-format stream-json` との併用

- 公式ドキュメントに併用例は無い。ただし stream-json の最後の行は `result` メッセージで（headless のドキュメント）、その型 `SDKResultMessage` の success 形には `structured_output?: unknown` がある。
  出典: https://code.claude.com/docs/en/headless#stream-responses, https://code.claude.com/docs/en/agent-sdk/typescript （`SDKResultMessage`）
- Agent SDK は CLI を子プロセスとして stream-json で動かす作りで、SDK の `outputFormat` の結果もこの result メッセージの `structured_output` で受け取る。したがって stream-json の result 行に `structured_output` が載ることは SDK の型から読み取れる。
- issue #82258 は stream-json の実行で `StructuredOutput` ツールのイベントが流れることに触れている（allowlist 付きエージェントではゼロ件、通常実行では出る）。つまりモデルの試行はストリーム上では `tool_use` ブロックとして見え、doctrine の今の `normalize` はこれを捨てる。
  出典: https://github.com/anthropics/claude-code/issues/82258
- stream-json の `result` 行の `.result`（テキスト）が、複数イベントに分かれた最終メッセージの最初の断片しか持たないことがある（#78686、open）。`structured_output` とは別のフィールドの話だが、テキストの `result` に JSON を書かせて読む方式には直接効く。
  出典: https://github.com/anthropics/claude-code/issues/78686
- ここは実際に呼んで確かめていない（モデル呼び出しは今回の調査の範囲外）。

### `--resume` との併用

- 公式ドキュメントに、`--resume` と `--json-schema` の併用についての記述は無い。
- CHANGELOG 2.1.187 の "follow-up turns now reliably return structured output" は、同じ会話の後続ターンで構造化出力が返らなかった不具合を直したものと読める。
- それ以前の報告として、`--resume` と `--json-schema` の組み合わせで「`StructuredOutput` を呼んだ」というフラグがセッションをまたいで残り、再開したターンで強制が働かず `structured_output: null` になる、というものがあった（#40022、2026-03、活動が無く自動クローズ・not_planned）。2.1.187 の修正との関係は公式には示されていない。
  出典: https://github.com/anthropics/claude-code/issues/40022
- 再開したターンでスキーマを渡し直す必要があるかどうかも、ドキュメントに記述が無い（フラグは起動ごとに指定するもので、doctrine の `buildArgs` も毎回組み立てている）。

### スキーマに合わなかったときの振る舞い

- 合わなければ CLI がモデルに再試行させる。回数は環境変数 `MAX_STRUCTURED_OUTPUT_RETRIES` で決まり、既定は **5**（初回＋4回の再試行）。使い切ると実行は失敗する。
  出典: https://code.claude.com/docs/en/env-vars
- 失敗したときの result は `subtype: "error_max_structured_output_retries"`、`terminal_reason: "structured_output_retry_exhausted"`。ローカルのバイナリ（2.1.272）には、テキスト出力で `Error: ${errors[0] ?? "Failed to provide valid structured output after maximum retries"}` を出すコードがある。
  出典: https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling, https://code.claude.com/docs/en/agent-sdk/typescript
- **`subtype: "success"` なのに `structured_output` が無い** ことがある。公式ドキュメントはこれを失敗として扱うよう求めている。例として、どの出力も満たせないスキーマ（矛盾する長さ制約など）が挙がっている。
  出典: https://code.claude.com/docs/en/agent-sdk/troubleshooting#structured_output-is-none-but-the-result-says-success
- モデルのフォールバックが、完了済みの出力をストリームの途中で取り消し、再試行で置き換わらなければ同じエラーで終わる。
  出典: https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling
- open の issue で報告されている、成功扱いのまま中身が壊れる例:
  - `tools:` allowlist を持つエージェント（`--agent`）では `StructuredOutput` ツールが使えず、`success`・終了コード 0・`structured_output` キー無しになる（#82258、2.1.220）。
  - 長い文字列フィールドとオブジェクト配列を持つスキーマで、モデルが配列を XML 風テキストにして文字列フィールドの中に入れる。厳しいスキーマではリトライを使い切り、緩いスキーマでは `"placeholder"` のような値で検証を通して `success` になる（#77026、2.1.204、約5,000文字の文字列フィールド）。
  - ツールを持たない呼び出しで、初回の `StructuredOutput` 呼び出しがキー名に `$PARAMETER_NAME` を使う。内部の再試行で直るが、1往復余計にかかる（#87234、2.1.233、71セッション中19件）。
  出典: https://github.com/anthropics/claude-code/issues/82258, https://github.com/anthropics/claude-code/issues/77026, https://github.com/anthropics/claude-code/issues/87234
- 古い（クローズ済みの）報告: `--json-schema` でハングする（#27926、2.1.50）、モデルが `StructuredOutput` の指示をプロンプトインジェクションとみなして無限ループになる（#37904、2026-03、duplicate でクローズ）。2.1.187 の「際限なく呼び直す」修正より前のもの。
  出典: https://github.com/anthropics/claude-code/issues/27926, https://github.com/anthropics/claude-code/issues/37904

### スキーマの書き方の制約

- CLI／SDK の検証は draft-07。`format` は注記扱い（検証しない）。
- strict に変換される場合、API の strict（structured outputs／strict tool use）の制約が効く。対応しないのは再帰スキーマ、`minimum`/`maximum`、`minLength`/`maxLength`、`minItems` の 0/1 以外、`additionalProperties` の `false` 以外など。上限は optional パラメータが全体で24、union 型のパラメータが16。ほかに文法サイズの内部上限（"Schema is too complex for compilation."）とコンパイルのタイムアウト180秒がある。
  出典: https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations, https://platform.claude.com/docs/en/build-with-claude/structured-outputs#schema-complexity-limits
- #92584 の報告者によれば、CLI は strict に変換できない場合（`unsupported_keyword`、`additional_properties`、schema too large など）に non-strict へ落ちる。その場合は API の制約で 400 にはならず、CLI のクライアント側検証と再試行だけが効くことになる。一次ドキュメントでは確認できない。
- API の structured outputs でも、大文字小文字だけ違う `enum`／`const` の値が返ることがある（エラーにならない）。
  出典: https://platform.claude.com/docs/en/build-with-claude/structured-outputs#invalid-outputs
- SDK ドキュメントの注意書き: 深い入れ子と多くの required はスキーマを満たしにくくする。
  出典: https://code.claude.com/docs/en/agent-sdk/structured-outputs#error-handling

## 2. ファイルに書かせて検証し、同じ会話で直させるやり方

### 使える部品（一次ソース）

- **再開**: `claude -p "<直す指示>" --resume <session_id>` で同じ会話を続けられる。セッション ID からは、どのディレクトリからでも見つかる（v2.1.223 以降）。
  出典: https://code.claude.com/docs/en/headless#continue-conversations
  doctrine の adapter はこの経路を既に持っている（`resume`）。
- **PostToolUse フック**: ツールの実行が成功した直後に動く。入力に `tool_input`（Write なら `file_path` と `content`）が入る。`decision: "block"` を返すと `reason` がツールの結果の横に付き、同じターンのうちにモデルがそれを読む。つまり、ファイルを書いた直後に doctrine 側の検証器を走らせてエラーを返せる。
  出典: https://code.claude.com/docs/en/hooks#posttooluse
- **Stop フック**: エージェントが応答を終えたときに動く。`decision: "block"` で止まるのを防ぎ、`reason` を渡して続けさせられる。**連続8回ブロックすると、Claude Code はフックを無視してターンを終える**。`stop_hook_active` で、既にフックによって続いている最中かどうかが分かる。
  出典: https://code.claude.com/docs/en/hooks#stop
- フックの設定は `--settings <file-or-json>` で起動ごとに渡せる（`claude --help`）。

### 実例と信頼性

- 公式ドキュメントに「ファイルに書かせて検証し、失敗したら直させる」まとまった例は無い。
- 近い実例は issue にある。#40022 の報告者は、再開したセッションで `--json-schema` の強制が効かないのを、SDK の Stop フックから `{"decision": "block", "reason": "You MUST call the StructuredOutput tool..."}` を返して回避した（`continue: false` はセッションを終わらせてしまい効かない、とも書いている）。#78686 の報告者は、`.result` が壊れているとき assistant の text ブロックを連結して組み立て直している。
  出典: https://github.com/anthropics/claude-code/issues/40022, https://github.com/anthropics/claude-code/issues/78686
- 成功率の数字は一次ソースに無い。`--json-schema` 側についても、公表されている数字は issue の報告者によるもの（#87234 の 26.8% は「初回で失敗し、内部の再試行で直った」割合）だけ。
- `--json-schema` の内部再試行と、ファイル＋検証＋再開（またはフック）方式との違いとして、一次ソースから言えること:
  - 内部再試行: 回数は `MAX_STRUCTURED_OUTPUT_RETRIES`（既定5）。再試行時にモデルが受け取るのは汎用の検証エラー（#77026 の例では `must have required property 'findings'`）。2.1.260 以降、上限に達したときのエラーには最後の検証失敗の内容が入る。検証は draft-07（Ajv と #80402 の報告者は見ている）。
  - 外部検証: 検証器・エラーメッセージの内容・再試行回数を doctrine が決められる。代わりに、再開のたびにプロセスを起動するコスト（doctrine の今の設計では1回の `-p` 実行が1プロセス）と、ファイルを書く権限（`--permission-mode` と Write）が要る。フックを使えばプロセスは1つで済むが、Stop フックの連続8回の上限がかかる。
- 2つを併用することもできる（`--json-schema` で形を強制し、doctrine 側で意味のチェックをして、足りなければ `--resume` で直させる）。ただし再開したターンでの `--json-schema` の振る舞いは、上記のとおり文書化されていない。

## 3. 出力の大きさ（数千トークン）

- `StructuredOutput` の答えは、1回のアシスタント応答の中の1つのツール呼び出しとして出る。したがって上限は1応答の最大出力トークン。
  - `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: "Defaults and caps vary by model"。認識できないモデル ID では 32000。モデルの上限を超える値はその上限に丸められる。
    出典: https://code.claude.com/docs/en/env-vars
  - モデルの最大出力（同期 Messages API）は、一覧の最新モデルで 128K トークン（64K のモデルもある）。
    出典: https://platform.claude.com/docs/en/about-claude/models/overview
  - 数千トークンはこの上限より1桁以上小さい。
- 上限で切れた場合: API の structured outputs では `stop_reason: "max_tokens"` になり、出力はスキーマに合わないことがある。
  出典: https://platform.claude.com/docs/en/build-with-claude/structured-outputs#invalid-outputs
- 大きさに関係して報告されている失敗: #77026 は「中程度に大きい構造化オブジェクト（長い文字列フィールド＋オブジェクト配列）」で起きている。約5,000文字の文字列フィールドの末尾に、配列が XML 風テキストとして埋め込まれていた。Reading Order の説明文（長い文字列）と項目の配列を1つのスキーマに入れる形は、この報告と同じ形になる。
  出典: https://github.com/anthropics/claude-code/issues/77026
- NDJSON 側: `structured_output` は result 行の1行に丸ごと入る。doctrine の `readNdjson` は1行の長さに上限を設けていないので、読み取り側には制約が無い。遅い読み手で出力が詰まっても、終了時に最大30秒まで排出を待つ（v2.1.214 より前は約2秒で、大きな応答の末尾が切れることがあった）。
  出典: https://code.claude.com/docs/en/headless#stream-responses
- ファイル方式の場合: Write ツールの内容に上限があるという記述は、ツールリファレンスでは見つからなかった。

## 4. doctrine から見た未確認事項

モデルを呼ぶ実行はしていないので、次は未確認のまま残っている。

- `--output-format stream-json --verbose` と `--json-schema` を併用したとき、result 行に `structured_output` が実際に載るか（SDK の型からは載ると読める）。
- `--resume` した実行で `--json-schema` を渡し直したとき、そのターンで `structured_output` が返るか（2.1.187 の修正後）。
- doctrine が渡す `--permission-mode` と `--permission-prompts none` の下で、`StructuredOutput` ツールが拒否されずに呼べるか（#82258 はツールの allowlist で消える例）。
- Reading Order 程度の大きさとスキーマの形で、`error_max_structured_output_retries` や placeholder による success がどのくらい起きるか。

## 出典一覧

- CLI リファレンス: https://code.claude.com/docs/en/cli-reference
- headless（`claude -p`）: https://code.claude.com/docs/en/headless
- Agent SDK structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Agent SDK TypeScript リファレンス（`SDKResultMessage`）: https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK troubleshooting: https://code.claude.com/docs/en/agent-sdk/troubleshooting
- 環境変数: https://code.claude.com/docs/en/env-vars
- フック: https://code.claude.com/docs/en/hooks
- API structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- モデル一覧: https://platform.claude.com/docs/en/about-claude/models/overview
- CHANGELOG: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- issues: #92584, #82258, #77026, #87234, #80402, #78686, #40022, #27926, #37904（https://github.com/anthropics/claude-code/issues/<番号>）
- ローカル: `claude --version`（2.1.272）、`claude --help`、`strings` によるバイナリ内文字列の確認
