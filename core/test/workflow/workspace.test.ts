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

const LINEAR_HEAD = "projects:\n  a: .\ntracker:\n  kind: linear\n  team: ENG\n";

test("tracker に github を書ける", () => {
  const cfg = parseWorkspaceConfig("projects:\n  a: .\ntracker:\n  kind: github\n", "root");
  assert.deepEqual(cfg.tracker, { kind: "github" });
});

test("tracker に Linear のチームを書ける", () => {
  const cfg = parseWorkspaceConfig(LINEAR_HEAD, "root");
  assert.deepEqual(cfg.tracker, { kind: "linear", team: "ENG" });
});

test("tracker: linear は段階ごとの状態の名前を持てる", () => {
  const cfg = parseWorkspaceConfig(`${LINEAR_HEAD}  states:\n    inReview: レビュー中\n`, "root");
  assert.deepEqual(cfg.tracker, {
    kind: "linear",
    team: "ENG",
    states: { inReview: "レビュー中" },
  });
});

test("tracker.states に知らない段階があれば弾く", () => {
  assert.throws(
    () => parseWorkspaceConfig(`${LINEAR_HEAD}  states:\n    done: X\n`, "root"),
    WorkflowValidationError,
  );
});

test("tracker.states の名前が空なら弾く", () => {
  assert.throws(
    () => parseWorkspaceConfig(`${LINEAR_HEAD}  states:\n    todo: ""\n`, "root"),
    WorkflowValidationError,
  );
});

test("Linear の tracker に team が無ければ落とす", () => {
  try {
    parseWorkspaceConfig("projects:\n  a: .\ntracker:\n  kind: linear\n", "root");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    assert(e.issues.some((i) => i.includes("tracker.team")));
  }
});

test("github の tracker に team を書くと落とす", () => {
  try {
    parseWorkspaceConfig("projects:\n  a: .\ntracker:\n  kind: github\n  team: ENG\n", "root");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    assert(e.issues.some((i) => i.includes("認識できないキー") && i.includes("team")));
  }
});

test("知らない kind は落とし、選べる値を示す", () => {
  try {
    parseWorkspaceConfig("projects:\n  a: .\ntracker:\n  kind: jira\n", "root");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    assert(
      e.issues.some((i) =>
        i.includes("tracker.kind") && i.includes("github") && i.includes("linear")
      ),
    );
  }
});

test("tracker が null なら落とす", () => {
  assert.throws(
    () => parseWorkspaceConfig("projects:\n  a: .\ntracker:\n", "root"),
    WorkflowValidationError,
  );
});
