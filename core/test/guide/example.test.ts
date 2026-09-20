import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { Guide, GuideLocation } from "../../../shared/guide/schema.ts";
import { type GuideHunk, listHunks } from "../../../shared/guide/hunkId.ts";
import { validateGuide } from "../../../shared/guide/validate.ts";

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
