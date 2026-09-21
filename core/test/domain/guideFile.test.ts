import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { GUIDE_RELPATH, MAX_GUIDE_BYTES, readGuideFile } from "../../src/domain/guideFile.ts";
import type { Guide } from "../../../shared/guide/schema.ts";
import { validateGuide } from "../../../shared/guide/validate.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => Deno.remove(d, { recursive: true })));
});

const exampleUrl = new URL(
  "../../../shared/guide/examples/step-artifacts.guide.json",
  import.meta.url,
);

async function example(): Promise<Guide> {
  return JSON.parse(await Deno.readTextFile(exampleUrl));
}

async function worktree(guideJson?: string): Promise<string> {
  const wt = await Deno.makeTempDir({ prefix: "doctrine-guidefile-" });
  dirs.push(wt);
  if (guideJson !== undefined) {
    await Deno.mkdir(join(wt, ".doctrine-out"), { recursive: true });
    await Deno.writeTextFile(join(wt, GUIDE_RELPATH), guideJson);
  }
  return wt;
}

test("ガイドが無ければ missing", async () => {
  const wt = await worktree();
  assert.deepEqual(await readGuideFile(wt), { status: "missing" });
});

test("上限を超えたガイドは中身を返さない", async () => {
  const wt = await worktree("x".repeat(MAX_GUIDE_BYTES + 1));
  const res = await readGuideFile(wt);
  assert.equal(res.status, "too_large");
  if (res.status !== "too_large") throw new Error("unreachable");
  assert.equal(res.size, MAX_GUIDE_BYTES + 1);
});

test("JSON として読めなければ broken", async () => {
  const wt = await worktree("{");
  const res = await readGuideFile(wt);
  assert.equal(res.status, "broken");
  if (res.status !== "broken") throw new Error("unreachable");
  assert.equal(res.issues.length, 1);
});

test("封筒の tree が無ければ broken", async () => {
  const guide = await example();
  const wt = await worktree(JSON.stringify({ createdAt: "2026-09-21T00:00:00Z", guide }));
  const res = await readGuideFile(wt);
  assert.equal(res.status, "broken");
  if (res.status !== "broken") throw new Error("unreachable");
  assert.ok(res.issues.some((i) => i.includes("tree")), res.issues.join("\n"));
});

test("検証を通らないガイドは broken で、issues は validateGuide と同じ", async () => {
  const guide = await example();
  guide.readingOrder[0].refs.risks = ["r-nonexistent"];
  const expected = validateGuide(guide);
  assert.equal(expected.ok, false);
  const wt = await worktree(
    JSON.stringify({ tree: "t1", createdAt: "2026-09-21T00:00:00Z", guide }),
  );
  const res = await readGuideFile(wt);
  assert.equal(res.status, "broken");
  if (res.status !== "broken" || expected.ok) throw new Error("unreachable");
  assert.deepEqual(res.issues, expected.issues);
});

test("正しいガイドは封筒ごと返る", async () => {
  const guide = await example();
  const wt = await worktree(
    JSON.stringify({ tree: "t1", createdAt: "2026-09-21T00:00:00Z", guide }),
  );
  const res = await readGuideFile(wt);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") throw new Error("unreachable");
  assert.equal(res.envelope.tree, "t1");
  assert.equal(res.envelope.createdAt, "2026-09-21T00:00:00Z");
  assert.equal(res.envelope.guide.why, guide.why);
});
