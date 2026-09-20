import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { toHtml, toMermaid } from "../src/render.ts";
import { computeStatus } from "../src/status.ts";
import { emptyRecord } from "../src/store.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const pfd = parsePfd(EXAMPLE_YAML);

test("toMermaid: 成果物は四角、プロセスは丸、矢印は成果物とプロセスの間だけ", () => {
  const lines = toMermaid(pfd).split("\n");
  assert.equal(lines[0], "flowchart LR");
  assert.ok(lines.includes('  a0["既存スキーマ"]'));
  assert.ok(lines.includes('  p0(("1<br/>マイグレーションを書く"))'));
  assert.ok(lines.includes("  a0 --> p0"));
  assert.ok(lines.includes("  p0 --> a1"));
  const arrows = lines.filter((l) => l.includes("-->"));
  assert.ok(arrows.every((l) => /^ {2}(a\d+ --> p\d+|p\d+ --> a\d+)$/.test(l)));
});

test("toMermaid: 人のプロセスに human クラスを付ける", () => {
  assert.ok(toMermaid(pfd).split("\n").includes("  class p2 human"));
});

test("toMermaid: 状態を渡さなければ状態のクラスを付けない", () => {
  const stateClass = /^ {2}class p\d+ (finished|ready|active|stopped)$/;
  assert.ok(!toMermaid(pfd).split("\n").some((l) => stateClass.test(l)));
});

test("toMermaid: 状態を渡せば塗り分ける", () => {
  const statuses = computeStatus(pfd, emptyRecord(), { tasks: [], prs: {} });
  const lines = toMermaid(pfd, statuses).split("\n");
  assert.ok(lines.includes("  class p0 ready"));
  assert.ok(lines.includes("  class p2 ready"));
  assert.ok(!lines.some((l) => l.startsWith("  class p1 ")));
});

test("toMermaid: ラベルの引用符を置き換える", () => {
  const quoted = parsePfd(EXAMPLE_YAML.replace("name: 既存スキーマ", 'name: 既存の "users" 表'));
  assert.ok(toMermaid(quoted).includes('a0["既存の #quot;users#quot; 表"]'));
});

test("toHtml: Mermaid の本文を HTML としてエスケープして埋め込む", () => {
  const html = toHtml("#123 <集計>", 'p0(("1<br/>x"))');
  assert.ok(html.includes("<title>#123 &lt;集計&gt;</title>"));
  assert.ok(html.includes('<pre class="mermaid">p0((&quot;1&lt;br/&gt;x&quot;))</pre>'));
  assert.ok(html.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"));
});
