import { describe, expect, test } from "vitest";
import example from "../../shared/guide/examples/step-artifacts.guide.json";
import { validateGuide } from "../../shared/guide/validate.ts";
import type { Guide } from "../../shared/guide/schema.ts";
import type { TaskGuide } from "../../shared/protocol.ts";
import { groupPaths, receiveGuide } from "./guide";

// JSON の import では version が number になり、Guide のリテラル型に合わない。
// キャストせず、アプリ側の検証を通して Guide 型で取り出す（見本がアプリ側の検証を通る確認も兼ねる）。
const validated = validateGuide(example);
if (!validated.ok) throw new Error(validated.issues.join("\n"));
const guide: Guide = validated.guide;

const ok = (stale: boolean, g: Guide = guide): TaskGuide => ({
  status: "ok",
  guide: g,
  createdAt: "2026-09-21T00:00:00Z",
  tree: "t1",
  worktreeTree: stale ? "t2" : "t1",
  stale,
});

describe("receiveGuide", () => {
  test("ok はそのまま通る", () => {
    const view = receiveGuide(ok(false));
    expect(view.kind).toBe("ok");
    if (view.kind !== "ok") return;
    expect(view.guide.why).toBe(guide.why);
    expect(view.stale).toBe(false);
    expect(view.createdAt).toBe("2026-09-21T00:00:00Z");
  });

  test("ok でも検証に落ちたら broken にする", () => {
    const bad = { ...guide, readingOrder: "x" } as unknown as Guide;
    const view = receiveGuide(ok(false, bad));
    expect(view.kind).toBe("broken");
    if (view.kind !== "broken") return;
    expect(view.issues.length).toBeGreaterThan(0);
  });

  test("stale は写す", () => {
    const view = receiveGuide(ok(true));
    expect(view.kind).toBe("ok");
    if (view.kind !== "ok") return;
    expect(view.stale).toBe(true);
  });

  test("none / missing / too_large / broken は写す", () => {
    expect(receiveGuide({ status: "none" })).toEqual({ kind: "none" });
    expect(receiveGuide({ status: "missing" })).toEqual({ kind: "missing" });
    expect(receiveGuide({ status: "too_large", size: 300000 })).toEqual({ kind: "too_large", size: 300000 });
    expect(receiveGuide({ status: "broken", issues: ["x"] })).toEqual({ kind: "broken", issues: ["x"] });
  });
});

describe("groupPaths", () => {
  test("グループ1つが指すパスは出現順で重複を除く", () => {
    const g = { ...guide.readingOrder[0], locations: [
      { path: "a.ts" }, { path: "b.ts", hunk: "h1" }, { path: "a.ts", hunk: "h2" },
    ] };
    expect(groupPaths(g)).toEqual(["a.ts", "b.ts"]);
  });
});
