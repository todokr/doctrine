import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { Guide, GuideLocation } from "../../../shared/guide/schema.ts";
import { type GuideHunk, listHunks } from "../../../shared/guide/hunkId.ts";
import { validateGuide } from "../../../shared/guide/validate.ts";
import { checkGuideLocations } from "../../src/domain/guideFile.ts";
import type { DiffFile } from "../../src/domain/diff.ts";

const patchUrl = new URL("../../../shared/guide/examples/step-artifacts.patch", import.meta.url);
const guideUrl = new URL(
  "../../../shared/guide/examples/step-artifacts.guide.json",
  import.meta.url,
);

async function loadGuide(): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(guideUrl));
}

async function loadHunks(): Promise<GuideHunk[]> {
  return listHunks(await Deno.readTextFile(patchUrl));
}

function locationsOf(guide: Guide): GuideLocation[] {
  return [
    ...guide.readingOrder.flatMap((g) => g.locations),
    ...guide.risks.flatMap((r) => r.locations),
  ];
}

test("見本のガイドは validateGuide を通る", async () => {
  const result = validateGuide(await loadGuide());
  assert.ok(result.ok, result.ok ? "" : result.issues.join("\n"));
});

test("見本が指す hunk とパスは patch に実在する", async () => {
  const result = validateGuide(await loadGuide());
  assert.ok(result.ok, result.ok ? "" : result.issues.join("\n"));
  const guide = result.guide;

  const hunks = await loadHunks();
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const paths = new Set(hunks.map((h) => h.path));

  const locations = locationsOf(guide);
  assert.ok(locations.length > 0, "突き合わせる location が1件もない");
  for (const loc of locations) {
    if (loc.hunk === undefined) {
      assert.ok(paths.has(loc.path), `patch に無いパス: ${loc.path}`);
      continue;
    }
    const hunk = hunkById.get(loc.hunk);
    assert.ok(hunk, `patch に無い hunk id: ${loc.hunk}`);
    assert.equal(hunk.path, loc.path, `hunk ${loc.hunk} のパスが違う`);
  }

  for (const p of guide.what.flatMap((w) => w.paths)) {
    assert.ok(paths.has(p), `what が指すパスが patch に無い: ${p}`);
  }
  for (const t of guide.tests) {
    assert.ok(paths.has(t.path), `tests が指すパスが patch に無い: ${t.path}`);
  }
});

async function loadFiles(): Promise<DiffFile[]> {
  const paths = new Set((await loadHunks()).map((h) => h.path));
  return [...paths].map((path) => ({
    path,
    status: "M",
    binary: false,
    additions: 0,
    deletions: 0,
  } as const));
}

async function loadValidGuide(): Promise<Guide> {
  const result = validateGuide(await loadGuide());
  assert.ok(result.ok, result.ok ? "" : result.issues.join("\n"));
  return result.guide;
}

test("見本の risks は 3 段階の impact をすべて含み、hunk に紐づいた risk がある", async () => {
  const guide = await loadValidGuide();
  assert.deepEqual(
    new Set(guide.risks.map((r) => r.impact)),
    new Set(["high", "medium", "low"]),
  );
  assert.ok(guide.risks.some((r) => r.locations.some((l) => l.hunk !== undefined)));
});

test("見本の箇所は checkGuideLocations を通る", async () => {
  const guide = await loadValidGuide();
  const issues = checkGuideLocations(guide, { hunks: await loadHunks(), files: await loadFiles() });
  assert.deepEqual(issues, []);
});

test("risk の箇所を patch に無い hunk に書き換えると checkGuideLocations が落とす", async () => {
  const guide = structuredClone(await loadValidGuide());
  guide.risks[0].locations[0] = { path: "src/core/worktree.ts", hunk: "h_00000000000000" };
  const issues = checkGuideLocations(guide, { hunks: await loadHunks(), files: await loadFiles() });
  assert.ok(
    issues.some((i) => i.includes("risks.0.locations.0") && i.includes("h_00000000000000")),
    issues.join("\n"),
  );
});

test("risk の箇所を変更に無いファイルにすると checkGuideLocations が落とす", async () => {
  const guide = structuredClone(await loadValidGuide());
  guide.risks[0].locations[0] = { path: "src/nowhere.ts" };
  const issues = checkGuideLocations(guide, { hunks: await loadHunks(), files: await loadFiles() });
  assert.ok(
    issues.some((i) =>
      i.includes("risks.0.locations.0") && i.includes("変更に含まれないファイルです")
    ),
    issues.join("\n"),
  );
});

test("参照を 1 つ壊すと validateGuide が落ちる", async () => {
  const broken = structuredClone(await loadGuide()) as Guide;
  assert.ok(broken.readingOrder[0].refs.decisions.length > 0, "書き換える参照が無い");
  broken.readingOrder[0].refs.decisions[0] = "d-nonexistent";

  const result = validateGuide(broken);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.includes("d-nonexistent")), result.issues.join("\n"));
  }
});
