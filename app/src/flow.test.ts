import { describe, expect, test } from "vitest";
import example from "../../shared/guide/examples/step-artifacts.guide.json";
import { validateGuide } from "../../shared/guide/validate.ts";
import { EXAMPLE_DIFF, SAMPLE_DIFF, SAMPLE_MOVE_DIFF } from "./fixtures";
import { findUnguided, readingFlow, risksAt, type ReadingFlow } from "./flow";
import { buildDiff } from "./patch";
import type { DiffFile, Guide, GuideLocation, Risk, TaskDiff } from "./types";

// 見本はアプリ側の検証を通して Guide 型で取り出す（guide.test.ts と同じやり方）
const validated = validateGuide(example);
if (!validated.ok) throw new Error(validated.issues.join("\n"));
const exampleGuide: Guide = validated.guide;

const makeGuide = (groups: GuideLocation[][], risks: Risk[] = []): Guide => ({
  version: 1,
  why: "",
  what: [],
  how: [],
  readingOrder: groups.map((locations, i) => ({
    title: `g${i}`,
    body: "",
    locations,
    refs: { decisions: [], risks: [], tests: [], diagrams: [] },
  })),
  decisions: [],
  risks,
  tests: [],
  diagrams: [],
});

const spot = (file: DiffFile, i: number) => (file.hunks.length === 0 ? file.path : `${file.path}#${i}`);

/** 流れに出てくる hunk（hunk の無いファイルはパスだけ）を、groups から tail の順に並べる */
const occurrences = (flow: ReadingFlow): string[] =>
  [...flow.groups.flatMap((g) => g.chunks), ...flow.tail.chunks].flatMap((c) =>
    c.hunks.length === 0 ? [c.file.path] : c.hunks.map((i) => spot(c.file, i))
  );

/** diff にある hunk（hunk の無いファイルはパスだけ）の全部 */
const everything = (files: DiffFile[]): string[] =>
  files.flatMap((f) => (f.hunks.length === 0 ? [f.path] : f.hunks.map((_, i) => spot(f, i))));

const expectExactlyOnce = (flow: ReadingFlow, files: DiffFile[]) => {
  const seen = occurrences(flow);
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual(everything(files).sort());
};

const fileOf = (files: DiffFile[], path: string) => files.find((f) => f.path === path)!;

/** 見本の diff に、ガイドが触れていない src/extra.ts を足したもの */
const withExtra = (): TaskDiff => ({
  ...EXAMPLE_DIFF,
  files: [...EXAMPLE_DIFF.files, { path: "src/extra.ts", status: "A", binary: false, additions: 1, deletions: 0 }],
  patch: `${EXAMPLE_DIFF.patch.endsWith("\n") ? EXAMPLE_DIFF.patch : EXAMPLE_DIFF.patch + "\n"}` +
    `diff --git a/src/extra.ts b/src/extra.ts\nnew file mode 100644\nindex 0000000..1111111\n` +
    `--- /dev/null\n+++ b/src/extra.ts\n@@ -0,0 +1 @@\n+export const extra = 1;\n`,
});

/** keep.ts の後ろに、patch の届いていない src/later.ts が続く打ち切りの diff */
const truncatedDiff = (): TaskDiff => ({
  ...SAMPLE_DIFF,
  files: [...SAMPLE_DIFF.files, { path: "src/later.ts", status: "M", binary: false, additions: 1, deletions: 1 }],
  truncated: true,
});

describe("findUnguided", () => {
  test("見本のガイドと patch では、読む順に入っていない変更は無い", () => {
    expect(findUnguided(buildDiff(EXAMPLE_DIFF), exampleGuide, false)).toEqual({ items: [], truncated: false });
  });

  test("ガイドが触れていないファイルを足した diff では、その hunk が出る", () => {
    const files = buildDiff(withExtra());
    const { items } = findUnguided(files, exampleGuide, false);
    expect(items).toEqual([{ kind: "hunk", file: fileOf(files, "src/extra.ts"), index: 0 }]);
  });

  test("hunk を持たないファイルは、パスで指されていなければファイルとして出る", () => {
    const files = buildDiff(SAMPLE_DIFF);
    const { items } = findUnguided(files, makeGuide([[{ path: "src/keep.ts" }]]), false);
    expect(items).toEqual([
      { kind: "file", file: fileOf(files, "logo.png") },
      { kind: "hunk", file: fileOf(files, "src/added.ts"), index: 0 },
      { kind: "hunk", file: fileOf(files, "src/gone.ts"), index: 0 },
      { kind: "file", file: fileOf(files, "src/renamed.ts") },
    ]);
  });

  test("リネームは旧い名前で指しても新しい名前で指しても一致する", () => {
    const files = buildDiff(SAMPLE_DIFF);
    for (const path of ["src/moved.ts", "src/renamed.ts"]) {
      const { items } = findUnguided(files, makeGuide([[{ path }]]), false);
      expect(items.map((i) => i.file.path)).not.toContain("src/renamed.ts");
    }
  });

  test("ファイル全体を指す location は、そのファイルの hunk を全部覆う", () => {
    const files = buildDiff(EXAMPLE_DIFF);
    const { items } = findUnguided(files, makeGuide([[{ path: "src/core/engine.ts" }]]), false);
    expect(items.map((i) => i.file.path)).not.toContain("src/core/engine.ts");
    expect(items).toHaveLength(21);
  });

  test("risks だけが指す hunk は、読む順に入っていないとして出る", () => {
    const files = buildDiff(SAMPLE_DIFF);
    const added = fileOf(files, "src/added.ts");
    const risk: Risk = { id: "r", kind: "unknown", body: "", locations: [{ path: "src/added.ts", hunk: added.hunks[0].id }] };
    const { items } = findUnguided(files, makeGuide([[{ path: "src/keep.ts" }]], [risk]), false);
    expect(items).toContainEqual({ kind: "hunk", file: added, index: 0 });
  });

  test("diff が打ち切られているときは truncated を立て、中身の届いていないファイルは cutOff として出す", () => {
    const files = buildDiff(truncatedDiff());
    const res = findUnguided(files, makeGuide([[{ path: "src/keep.ts" }]]), true);
    expect(res.truncated).toBe(true);
    expect(res.items.at(-1)).toEqual({ kind: "cutOff", file: fileOf(files, "src/later.ts") });
  });

  test("打ち切りで中身の届いていないファイルでも、パスで指されていれば出さない", () => {
    const files = buildDiff(truncatedDiff());
    const guide = makeGuide([[{ path: "src/keep.ts" }, { path: "src/later.ts" }]]);
    const { items } = findUnguided(files, guide, true);
    expect(items.map((i) => i.file.path)).not.toContain("src/later.ts");
  });
});

describe("readingFlow", () => {
  test("見本では、すべての hunk がちょうど 1 回ずつ出て、末尾は空", () => {
    const files = buildDiff(EXAMPLE_DIFF);
    const flow = readingFlow(exampleGuide, files, false);
    expectExactlyOnce(flow, files);
    expect(occurrences(flow)).toHaveLength(24);
    expect(flow.tail.chunks).toEqual([]);
  });

  test("ガイドが触れていないファイルを足しても、すべての hunk がちょうど 1 回ずつ出て、足した分は末尾に出る", () => {
    const files = buildDiff(withExtra());
    const flow = readingFlow(exampleGuide, files, false);
    expectExactlyOnce(flow, files);
    expect(flow.tail.chunks).toEqual([{ file: fileOf(files, "src/extra.ts"), hunks: [0], continued: false }]);
  });

  test("hunk の無いファイルと一部だけ指すガイドでも、すべての変更がちょうど 1 回ずつ出る", () => {
    const files = buildDiff(SAMPLE_DIFF);
    const flow = readingFlow(makeGuide([[{ path: "src/keep.ts" }], [{ path: "src/moved.ts" }]]), files, false);
    expectExactlyOnce(flow, files);
    expect(flow.tail.chunks.map((c) => c.file.path)).toEqual(["logo.png", "src/added.ts", "src/gone.ts"]);
    expect(flow.groups[1].chunks).toEqual([{ file: fileOf(files, "src/renamed.ts"), hunks: [], continued: false }]);
  });

  test("グループと hunk は読む順に並ぶ", () => {
    const files = buildDiff(EXAMPLE_DIFF);
    const flow = readingFlow(exampleGuide, files, false);
    expect(flow.groups.map((g) => g.group.title)).toEqual(exampleGuide.readingOrder.map((g) => g.title));
    const ids = flow.groups[0].chunks.flatMap((c) => c.hunks.map((i) => c.file.hunks[i].id));
    expect(ids).toEqual(exampleGuide.readingOrder[0].locations.map((l) => l.hunk));
    // 同じファイルの続けて並ぶ hunk は 1 つの chunk になる（schema.ts の 2 件、schema.test.ts の 2 件）
    expect(flow.groups[0].chunks.map((c) => [c.file.path, c.hunks.length])).toEqual([
      ["src/workflow/schema.ts", 2],
      ["test/workflow/schema.test.ts", 2],
    ]);
  });

  test("同じ hunk を 2 つのグループが指したら、前のグループにだけ出す", () => {
    const files = buildDiff(SAMPLE_DIFF);
    const k = fileOf(files, "src/keep.ts").hunks[0].id;
    const loc = { path: "src/keep.ts", hunk: k };
    const flow = readingFlow(makeGuide([[loc], [loc]]), files, false);
    expect(flow.groups[0].chunks).toEqual([{ file: fileOf(files, "src/keep.ts"), hunks: [0], continued: false }]);
    expect(flow.groups[1].chunks).toEqual([]);
    expect(flow.groups[1].repeats).toEqual([{ location: loc, at: 0 }]);
    expectExactlyOnce(flow, files);
  });

  test("ファイル全体の location は、まだ出ていない hunk だけをファイルの順に出す", () => {
    const files = buildDiff(EXAMPLE_DIFF);
    const engine = fileOf(files, "src/core/engine.ts");
    const [, e1] = engine.hunks.map((h) => h.id);
    const flow = readingFlow(makeGuide([[{ path: engine.path, hunk: e1 }], [{ path: engine.path }]]), files, false);
    expect(flow.groups[0].chunks.map((c) => c.hunks)).toEqual([[1]]);
    expect(flow.groups[1].chunks.map((c) => [c.hunks, c.continued])).toEqual([[[0, 2], true]]);
    expect(flow.groups[1].repeats).toEqual([]);
    expectExactlyOnce(flow, files);
  });

  test("ファイル全体の location がもう全部出ているなら repeat として示す", () => {
    const files = buildDiff(EXAMPLE_DIFF);
    const engine = fileOf(files, "src/core/engine.ts");
    const e1 = engine.hunks[1].id;
    const flow = readingFlow(
      makeGuide([[{ path: engine.path }], [{ path: engine.path, hunk: e1 }], [{ path: engine.path }]]),
      files,
      false,
    );
    expect(flow.groups[1].chunks).toEqual([]);
    expect(flow.groups[2].chunks).toEqual([]);
    expect(flow.groups[1].repeats.map((r) => r.at)).toEqual([0]);
    expect(flow.groups[2].repeats.map((r) => r.at)).toEqual([0]);
    expectExactlyOnce(flow, files);
  });

  test("diff に無い箇所は absent として返す", () => {
    const files = buildDiff(SAMPLE_DIFF);
    const missing = [{ path: "src/nope.ts" }, { path: "src/keep.ts", hunk: "h_00000000000000" }];
    const flow = readingFlow(makeGuide([missing]), files, false);
    expect(flow.groups[0].absent).toEqual(missing);
    expect(flow.groups[0].chunks).toEqual([]);
  });

  test("並べ替えても移動の情報を持ったまま", () => {
    const files = buildDiff(SAMPLE_MOVE_DIFF);
    const flow = readingFlow(makeGuide([[{ path: "src/b.ts" }], [{ path: "src/a.ts" }]]), files, false);
    const b = flow.groups[0].chunks[0].file;
    const a = flow.groups[1].chunks[0].file;
    expect(b).toBe(fileOf(files, "src/b.ts"));
    expect(b.moves).toHaveLength(1);
    expect(a).toBe(fileOf(files, "src/a.ts"));
    expect(a.moves).toHaveLength(1);
  });

  test("打ち切りの diff でも不変条件は保ち、末尾は truncated", () => {
    const files = buildDiff(truncatedDiff());
    const flow = readingFlow(makeGuide([[{ path: "src/keep.ts" }]]), files, true);
    expectExactlyOnce(flow, files);
    expect(flow.tail.unguided.truncated).toBe(true);
  });
});

describe("risksAt", () => {
  test("hunk を指すリスクは hunk に、パスだけのリスクはファイルに付く", () => {
    const { byHunk, byPath } = risksAt(exampleGuide);
    expect(byHunk.get("h_180733771bf8d2")?.map((r) => r.id)).toEqual(["r-column-kept", "r-column-stale"]);
    expect(byPath.size).toBe(0);

    const pathRisk: Risk = { id: "r-path", kind: "assumption", body: "", locations: [{ path: "src/x.ts" }] };
    const added = risksAt({ ...exampleGuide, risks: [...exampleGuide.risks, pathRisk] });
    expect(added.byPath.get("src/x.ts")?.map((r) => r.id)).toEqual(["r-path"]);
  });
});
