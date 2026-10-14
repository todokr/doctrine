import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { AgentAdapter, AgentRun } from "../../src/adapter/types.ts";
import {
  branchSlugJsonSchema,
  createClaudeBranchNamer,
  slugFromOutput,
} from "../../src/domain/branchName.ts";

const TITLE = "/healthz を clamd への PING で応答するように変える";

describe("slugFromOutput", () => {
  it("slugFromOutput は slug をそのまま返す", () => {
    assert.equal(slugFromOutput({ slug: "ping-clamd-healthz" }), "ping-clamd-healthz");
  });

  it("slugFromOutput は doctrine/ を剥がして slugify に通す", () => {
    assert.equal(slugFromOutput({ slug: "doctrine/Ping_Clamd Healthz" }), "ping-clamd-healthz");
  });

  it("slugFromOutput は ASCII 以外を落とす", () => {
    assert.equal(slugFromOutput({ slug: "healthz-を-clamd" }), "healthz-clamd");
  });

  it("slugFromOutput は使える文字が無ければ null", () => {
    assert.equal(slugFromOutput({ slug: "ヘルスチェック" }), null);
    assert.equal(slugFromOutput({ slug: "" }), null);
    assert.equal(slugFromOutput({ slug: 1 }), null);
    assert.equal(slugFromOutput(null), null);
  });

  it("slugFromOutput は 40 文字で切る", () => {
    assert.equal(slugFromOutput({ slug: "a".repeat(60) }), "a".repeat(40));
  });
});

describe("createClaudeBranchNamer", () => {
  const ok = { ok: true, structuredOutput: { slug: "ping-clamd-healthz" } };

  it("createClaudeBranchNamer は構造化出力の slug を返す", async () => {
    const namer = createClaudeBranchNamer(createMockAdapter({ result: ok }), { cwd: "/state" });
    assert.equal(await namer({ title: TITLE, prompt: "本文" }), "ping-clamd-healthz");
  });

  it("createClaudeBranchNamer は jsonSchema と model と cwd を渡し、プロンプトに題と本文を載せる", async () => {
    const adapter = createMockAdapter({ result: ok });
    const namer = createClaudeBranchNamer(adapter, { cwd: "/state" });
    await namer({ title: TITLE, prompt: "clamd に PING を送る" });
    assert.equal(adapter.calls.length, 1);
    const call = adapter.calls[0]!;
    assert.equal(call.kind, "start");
    assert.deepEqual(call.opts.jsonSchema, branchSlugJsonSchema());
    assert.equal(call.opts.model, "haiku");
    assert.equal(call.opts.cwd, "/state");
    assert.deepEqual(call.opts.allowedTools, []);
    assert.ok(call.prompt.includes(TITLE));
    assert.ok(call.prompt.includes("clamd に PING を送る"));
  });

  it("createClaudeBranchNamer は本文を 4000 文字で切る", async () => {
    const adapter = createMockAdapter({ result: ok });
    const namer = createClaudeBranchNamer(adapter, { cwd: "/state" });
    await namer({ title: TITLE, prompt: "x".repeat(10000) });
    const prompt = adapter.calls[0]!.prompt;
    assert.ok(prompt.includes("x".repeat(4000)));
    assert.ok(!prompt.includes("x".repeat(4001)));
  });

  it("createClaudeBranchNamer は失敗した実行で null", async () => {
    const adapter = createMockAdapter({
      result: { ok: false, structuredOutput: { slug: "a" } },
    });
    const namer = createClaudeBranchNamer(adapter, { cwd: "/state" });
    assert.equal(await namer({ title: TITLE, prompt: "" }), null);
  });

  it("createClaudeBranchNamer は構造化出力が無ければ null", async () => {
    const adapter = createMockAdapter({ result: { ok: true, structuredOutput: null } });
    const namer = createClaudeBranchNamer(adapter, { cwd: "/state" });
    assert.equal(await namer({ title: TITLE, prompt: "" }), null);
  });

  it("createClaudeBranchNamer は時間切れで null", async () => {
    const adapter = createMockAdapter({ result: ok, delayMs: 200 });
    const namer = createClaudeBranchNamer(adapter, { cwd: "/state", timeoutMs: 20 });
    assert.equal(await namer({ title: TITLE, prompt: "" }), null);
  });

  it("createClaudeBranchNamer は起動の失敗を投げずに null", async () => {
    const adapter: AgentAdapter = {
      start: (_prompt, opts) => {
        const result = Promise.reject(new Error("x"));
        return {
          sessionId: opts.sessionId,
          pid: 1,
          startedAt: new Date().toISOString(),
          events: (async function* () {})(),
          result,
          kill: () => {},
        } satisfies AgentRun;
      },
      resume: () => {
        throw new Error("使わない");
      },
    };
    const namer = createClaudeBranchNamer(adapter, { cwd: "/state" });
    assert.equal(await namer({ title: TITLE, prompt: "" }), null);
  });
});
