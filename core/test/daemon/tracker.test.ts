import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackerFor } from "../../src/daemon/tracker.ts";
import { WorkspaceConfigError } from "../../src/tracker/tracker.ts";
import type { WorkspaceRef } from "../../src/tracker/workspaceTracker.ts";
import { fakeTracker } from "../helpers/tracker.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doctrine-tracker-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeWorkspaceYaml(text: string) {
  await mkdir(join(dir, ".doctrine"), { recursive: true });
  await writeFile(join(dir, ".doctrine", "workspace.yaml"), text);
}

function ref(): WorkspaceRef {
  return { path: dir, projects: [{ name: "a", path: join(dir, "a") }] };
}

function setup(o: { linearApiKey: string | undefined } = { linearApiKey: "lin_x" }) {
  const { linearApiKey } = o;
  const github = fakeTracker();
  const linearCalls: {
    apiKey: string | undefined;
    team: string;
    states?: Partial<Record<"todo" | "inProgress" | "inReview", string>>;
  }[] = [];
  const trackerOf = trackerFor({
    linearApiKey,
    github,
    linear: (o) => {
      linearCalls.push(o);
      return fakeTracker({}, { kind: "linear" });
    },
  });
  return { github, linearCalls, trackerOf };
}

const LINEAR = "projects:\n  a: a\ntracker:\n  kind: linear\n  team: ENG\n";

test("tracker の宣言が無い workspace は GitHub の Tracker を使う", async () => {
  await writeWorkspaceYaml("projects:\n  a: a\n");
  const { github, linearCalls, trackerOf } = setup();
  const wt = await trackerOf(ref());
  assert.equal(wt.kind, "github");
  assert.equal(wt.tracker, github);
  assert.equal(linearCalls.length, 0);
});

test("tracker: linear の workspace は Linear の Tracker を config の API key とチームで作る", async () => {
  await writeWorkspaceYaml(LINEAR);
  const { linearCalls, trackerOf } = setup({ linearApiKey: "lin_x" });
  const wt = await trackerOf(ref());
  assert.equal(wt.kind, "linear");
  assert.deepEqual(linearCalls, [{ apiKey: "lin_x", team: "ENG" }]);
});

test("tracker.states があれば Linear の Tracker に渡す", async () => {
  await writeWorkspaceYaml(`${LINEAR}  states:\n    inReview: レビュー中\n`);
  const { linearCalls, trackerOf } = setup();
  await trackerOf(ref());
  assert.deepEqual(linearCalls, [
    { apiKey: "lin_x", team: "ENG", states: { inReview: "レビュー中" } },
  ]);
});

test("linearApiKey が無くても Linear の Tracker を返す", async () => {
  await writeWorkspaceYaml(LINEAR);
  const { linearCalls, trackerOf } = setup({ linearApiKey: undefined });
  const wt = await trackerOf(ref());
  assert.equal(wt.kind, "linear");
  assert.deepEqual(linearCalls, [{ apiKey: undefined, team: "ENG" }]);
});

test("workspace.yaml の書き換えは再起動なしで効く", async () => {
  await writeWorkspaceYaml("projects:\n  a: a\n");
  const { trackerOf } = setup();
  assert.equal((await trackerOf(ref())).kind, "github");
  await writeWorkspaceYaml(LINEAR);
  assert.equal((await trackerOf(ref())).kind, "linear");
});

test("workspace.yaml が無ければ workspace_config_missing", async () => {
  const { trackerOf } = setup();
  await assert.rejects(trackerOf(ref()), (e: unknown) => {
    assert.ok(e instanceof WorkspaceConfigError);
    assert.equal(e.reason, "workspace_config_missing");
    assert.ok(e.message.includes("workspace.yaml"));
    return true;
  });
});

test("workspace.yaml が壊れていれば workspace_config_invalid", async () => {
  await writeWorkspaceYaml("projects:\n  a: a\ntracker:\n  kind: jira\n");
  const { trackerOf } = setup();
  await assert.rejects(trackerOf(ref()), (e: unknown) => {
    assert.ok(e instanceof WorkspaceConfigError);
    assert.equal(e.reason, "workspace_config_invalid");
    return true;
  });
});

test("プロジェクトは workspace.yaml ではなく渡した WorkspaceRef から取る", async () => {
  await writeWorkspaceYaml("projects:\n  x: elsewhere\n");
  const { trackerOf } = setup();
  const wt = await trackerOf(ref());
  assert.equal((await wt.status())[0].project, "a");
});
