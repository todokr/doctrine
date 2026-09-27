import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parseWorkspaceConfig, workspaceYamlFor } from "../../src/workflow/workspace.ts";
import { WorkflowValidationError } from "../../src/workflow/schema.ts";

test("workspace.yaml を書かれた順で読む", () => {
  const cfg = parseWorkspaceConfig(
    [
      "name: tp",
      "projects:",
      "  terraform: assured-terraform",
      "  tp: assured-tp",
      "  kubernetes: ../elsewhere/assured-kubernetes",
      "tracker:",
      "  kind: linear",
      "  team: ENG",
      "",
    ].join("\n"),
    "tp-root",
  );
  assert.deepEqual(cfg, {
    name: "tp",
    projects: [
      { name: "terraform", path: "assured-terraform" },
      { name: "tp", path: "assured-tp" },
      { name: "kubernetes", path: "../elsewhere/assured-kubernetes" },
    ],
    tracker: { kind: "linear", team: "ENG" },
  });
});

test("name と tracker を省略すると root のディレクトリ名と github になる", () => {
  const cfg = parseWorkspaceConfig("projects:\n  doctrine: .\n", "doctrine");
  assert.equal(cfg.name, "doctrine");
  assert.deepEqual(cfg.tracker, { kind: "github" });
});

test("プロジェクトの名前は [a-z0-9-]+ でなければ落ちる", () => {
  assert.throws(
    () => parseWorkspaceConfig("projects:\n  Assured_TP: assured-tp\n", "tp"),
    WorkflowValidationError,
  );
});

test("projects が空なら落ちる", () => {
  assert.throws(() => parseWorkspaceConfig("projects: {}\n", "tp"), WorkflowValidationError);
});

test("同じパスを 2 つの名前で指すと落ちる", () => {
  assert.throws(
    () => parseWorkspaceConfig("projects:\n  a: repo\n  b: ./repo\n", "tp"),
    WorkflowValidationError,
  );
});

test("雛形は読み直すと同じ projects になる", () => {
  const projects = [{ name: "doctrine", path: "." }];
  assert.deepEqual(
    parseWorkspaceConfig(workspaceYamlFor(projects), "doctrine").projects,
    projects,
  );
});
