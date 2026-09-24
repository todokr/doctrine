import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackerFor } from "../../src/daemon/tracker.ts";
import { WorkflowValidationError } from "../../src/workflow/schema.ts";
import { fakeTracker } from "../helpers/tracker.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doctrine-tracker-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeProjectYaml(text: string) {
  await mkdir(join(dir, ".doctrine"), { recursive: true });
  await writeFile(join(dir, ".doctrine", "project.yaml"), text);
}

function setup(o: { linearApiKey: string | undefined } = { linearApiKey: "lin_x" }) {
  const { linearApiKey } = o;
  const github = fakeTracker();
  const linearCalls: { apiKey: string | undefined; team: string }[] = [];
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

const LINEAR_YAML = "defaultWorkflow: f\ntracker:\n  kind: linear\n  team: ENG\n";

test("tracker の宣言が無いプロジェクトは GitHub の Tracker を使う", async () => {
  await writeProjectYaml("defaultWorkflow: f\n");
  const { github, linearCalls, trackerOf } = setup();
  assert.equal(await trackerOf(dir), github);
  assert.equal(linearCalls.length, 0);
});

test("tracker: github のプロジェクトは GitHub の Tracker を使う", async () => {
  await writeProjectYaml("defaultWorkflow: f\ntracker:\n  kind: github\n");
  const { github, linearCalls, trackerOf } = setup();
  assert.equal(await trackerOf(dir), github);
  assert.equal(linearCalls.length, 0);
});

test("tracker: linear のプロジェクトは Linear の Tracker を config の API key とチームで作る", async () => {
  await writeProjectYaml(LINEAR_YAML);
  const { linearCalls, trackerOf } = setup({ linearApiKey: "lin_x" });
  assert.equal((await trackerOf(dir)).kind, "linear");
  assert.deepEqual(linearCalls, [{ apiKey: "lin_x", team: "ENG" }]);
});

test("linearApiKey が無くても Linear の Tracker を返す", async () => {
  await writeProjectYaml(LINEAR_YAML);
  const { linearCalls, trackerOf } = setup({ linearApiKey: undefined });
  assert.equal((await trackerOf(dir)).kind, "linear");
  assert.deepEqual(linearCalls, [{ apiKey: undefined, team: "ENG" }]);
});

test("project.yaml を書き換えると次の呼び出しから効く", async () => {
  await writeProjectYaml("defaultWorkflow: f\n");
  const { github, trackerOf } = setup();
  assert.equal(await trackerOf(dir), github);
  await writeProjectYaml(LINEAR_YAML);
  assert.equal((await trackerOf(dir)).kind, "linear");
});

test("project.yaml が無ければ投げる", async () => {
  const { trackerOf } = setup();
  await assert.rejects(trackerOf(dir), /project\.yaml がありません/);
});

test("project.yaml が壊れていれば投げる", async () => {
  await writeProjectYaml("defaultWorkflow: f\ntracker:\n  kind: jira\n");
  const { trackerOf } = setup();
  await assert.rejects(trackerOf(dir), WorkflowValidationError);
});
