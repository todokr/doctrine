import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowFromDisk, pinOf, taskWorkflow } from "../../src/workflow/load.ts";

const A = "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n";
const B = 'name: feature\nsteps:\n  - id: other\n    type: command\n    run: "true"\n';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-load-"));
  await mkdir(join(root, ".doctrine", "workflows"), { recursive: true });
  await writeFile(join(root, ".doctrine", "workflows", "feature.yaml"), A);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("loadWorkflowFromDisk は検証した workflow と YAML の中身をそのまま返す", async () => {
  const loaded = await loadWorkflowFromDisk(root, "feature");
  assert.equal(loaded.text, A);
  assert.equal(loaded.workflow.steps[0].id, "review");
});

test("loadWorkflowFromDisk は無いワークフローを名指しで断る", async () => {
  await assert.rejects(loadWorkflowFromDisk(root, "nope"), /ワークフローがありません/);
});

test("作成時の定義を持つタスクはディスクではなく保存した中身で解決する", async () => {
  await writeFile(join(root, ".doctrine", "workflows", "feature.yaml"), B);
  const task = { workflow_name: "feature", workflow_yaml: A, workflow_setup: null };
  const project = { path: root, setup: null };
  const load = () => {
    throw new Error("呼ばれてはいけない");
  };
  const workflow = await taskWorkflow(task, project, load);
  assert.deepEqual(workflow.steps.map((s) => s.id), ["review"]);
});

test("作成時の setup を差し込み、project の今の setup は見ない", async () => {
  const task = { workflow_name: "feature", workflow_yaml: A, workflow_setup: "echo pinned" };
  const project = { path: root, setup: "echo now" };
  const workflow = await taskWorkflow(task, project, loadWorkflowFromDisk);
  assert.deepEqual(workflow.steps[0], { id: "setup", type: "command", run: "echo pinned" });
});

test("作成時に setup が無ければ、project に後から足した setup を差し込まない", async () => {
  const task = { workflow_name: "feature", workflow_yaml: A, workflow_setup: null };
  const project = { path: root, setup: "echo now" };
  const workflow = await taskWorkflow(task, project, loadWorkflowFromDisk);
  assert.deepEqual(workflow.steps.map((s) => s.id), ["review"]);
});

test("作成時の定義を持たないタスクはディスクの YAML と project の setup で解決する", async () => {
  await writeFile(join(root, ".doctrine", "workflows", "feature.yaml"), B);
  const task = { workflow_name: "feature", workflow_yaml: null, workflow_setup: null };
  const project = { path: root, setup: "echo now" };
  const workflow = await taskWorkflow(task, project, loadWorkflowFromDisk);
  assert.deepEqual(workflow.steps.map((s) => s.id), ["setup", "other"]);
});

test("pinOf は YAML の中身と project の setup を写す", async () => {
  const loaded = await loadWorkflowFromDisk(root, "feature");
  assert.deepEqual(pinOf(loaded, { setup: "echo hi" }), {
    workflow_yaml: A,
    workflow_setup: "echo hi",
  });
  assert.deepEqual(pinOf(loaded, { setup: null }), {
    workflow_yaml: A,
    workflow_setup: null,
  });
});
