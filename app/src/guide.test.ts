import { describe, expect, test } from "vitest";
import example from "../../shared/guide/examples/step-artifacts.guide.json";
import { validateGuide } from "../../shared/guide/validate.ts";
import type { Guide, GuideLocation, Risk } from "../../shared/guide/schema.ts";
import type { TaskGuide } from "../../shared/protocol.ts";
import { EXAMPLE_DIFF, SAMPLE_DIFF } from "./fixtures";
import { groupPaths, locationAnchor, receiveGuide, sortRisks, splitRisks } from "./guide";
import { buildDiff } from "./patch";

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

const risk = (id: string, kind: Risk["kind"], impact: Risk["impact"], locations: GuideLocation[] = []): Risk =>
  ({ id, kind, impact, body: "", locations });
const ids = (risks: Risk[]) => risks.map((r) => r.id);

describe("sortRisks", () => {
  test("impact の強い順に並べ、同じ impact の中は元の順を保つ", () => {
    const input = [
      risk("a", "breaks", "low"), risk("b", "breaks", "high"),
      risk("c", "breaks", "medium"), risk("d", "breaks", "high"),
    ];
    expect(ids(sortRisks(input))).toEqual(["b", "d", "c", "a"]);
    expect(ids(input)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("splitRisks", () => {
  test("considered と low は畳み、それ以外は開いて出す", () => {
    const { shown, folded } = splitRisks([
      risk("a", "breaks", "low"), risk("b", "considered", "high"),
      risk("c", "assumption", "medium"), risk("d", "unknown", "high"),
    ]);
    expect(ids(shown)).toEqual(["d", "c"]);
    expect(ids(folded)).toEqual(["b", "a"]);
  });

  test("見本では high の breaks だけが開いて出る", () => {
    const { shown, folded } = splitRisks(guide.risks);
    expect(ids(shown)).toEqual(["r-column-stale"]);
    expect(ids(folded)).toEqual(["r-exclude", "r-column-kept", "r-role-charset"]);
  });
});

describe("locationAnchor", () => {
  test("hunk を指す箇所はその hunk へ飛ぶ", () => {
    const files = buildDiff(EXAMPLE_DIFF);
    const res = locationAnchor(files, { path: "src/core/engine.ts", hunk: "h_180733771bf8d2" });
    expect(res?.anchor).toBe("h_180733771bf8d2");
    expect(res?.file.path).toBe("src/core/engine.ts");
    expect(res?.hunk).toBe(res?.file.hunks.findIndex((h) => h.id === "h_180733771bf8d2"));
    expect(res?.hunk).not.toBeNull();
    expect(res?.hunk).toBeGreaterThanOrEqual(0);
  });

  test("パスだけの箇所はファイルの見出しへ飛ぶ", () => {
    const files = buildDiff(SAMPLE_DIFF);
    const keep = locationAnchor(files, { path: "src/keep.ts" });
    expect(keep?.anchor).toBe("file:src/keep.ts");
    expect(keep?.hunk).toBeNull();
    const png = locationAnchor(files, { path: "logo.png" });
    expect(png?.anchor).toBe("file:logo.png");
    expect(png?.hunk).toBeNull();
  });

  test("リネームは旧名で指しても新しい名前の見出しへ飛ぶ", () => {
    const files = buildDiff(SAMPLE_DIFF);
    expect(locationAnchor(files, { path: "src/moved.ts" })?.anchor).toBe("file:src/renamed.ts");
  });

  test("今の diff に無い箇所は null", () => {
    const files = buildDiff(SAMPLE_DIFF);
    expect(locationAnchor(files, { path: "src/nowhere.ts" })).toBeNull();
    expect(locationAnchor(files, { path: "src/keep.ts", hunk: "h_00000000000000" })).toBeNull();
  });
});
