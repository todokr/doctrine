import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "@std/testing/bdd";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import { getIntake, listProcesses } from "../../src/db/intakes.ts";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, listTasks } from "../../src/db/tasks.ts";
import { insertWorkspace } from "../../src/db/workspaces.ts";
import { containsCommit, originRef } from "../../src/domain/worktree.ts";
import { ghPrWatcher } from "../../src/github/ghPrWatcher.ts";
import { ghTracker } from "../../src/github/ghTracker.ts";
import type { IntakeTransition } from "../../src/intake/commands.ts";
import { createIntakeWatcher, gitBaseSync } from "../../src/intake/watch.ts";
import { fakeGh, parseGraphqlArgs } from "../helpers/gh.ts";
import { makeRepo } from "../helpers/repo.ts";
import { constTrackerOf } from "../helpers/tracker.ts";
import { fakeWorkflowLoader } from "../helpers/watcher.ts";
import { insertActiveIntake } from "../intake/watchFixture.ts";

const run = promisify(execFile);

type Repo = { name: string; path: string; origin: string; repositoryId: string };

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "doctrine-cross-repo-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** root/<name>/repo に実リポジトリを作り、root/<name>/origin に clone して origin として付ける。 */
async function repoWithOrigin(root: string, name: string): Promise<Repo> {
  const path = await makeRepo(join(root, name), { "README.md": `${name}\n` });
  const origin = join(root, name, "origin");
  await run("git", ["clone", "-q", path, origin]);
  await run("git", ["-C", origin, "config", "user.email", "t@e.com"]);
  await run("git", ["-C", origin, "config", "user.name", "t"]);
  await run("git", ["-C", path, "remote", "add", "origin", origin]);
  return { name, path, origin, repositoryId: `R_${name}` };
}

/** origin の main にコミットを 1 つ積み、その oid を返す。GitHub 上のマージを表す。 */
async function mergeOnOrigin(repo: Repo, file: string): Promise<string> {
  await writeFile(join(repo.origin, file), `${file}\n`);
  await run("git", ["-C", repo.origin, "add", "."]);
  await run("git", ["-C", repo.origin, "commit", "-q", "-m", `merge ${file}`]);
  const { stdout } = await run("git", ["-C", repo.origin, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/** terraform → tp → kubernetes を成果物で直列につないだ PFD。 */
function crossRepoPfd(): Pfd {
  return {
    title: "ネットワークからサービスまでを 3 リポジトリで通す",
    goal: ["deploy"],
    artifacts: [
      { id: "base", name: "既存の基盤", given: true },
      {
        id: "network",
        name: "ネットワーク",
        given: false,
        description: "サービスが使う VPC とサブネット",
        verify: "terraform plan が通る",
      },
      {
        id: "service",
        name: "サービス",
        given: false,
        description: "ネットワーク上で動くサービスの実装",
        verify: "サービスのテストが通る",
      },
      {
        id: "deploy",
        name: "デプロイ",
        given: false,
        description: "サービスを載せるマニフェスト",
        verify: "マニフェストの検証が通る",
      },
    ],
    processes: [
      {
        id: "1",
        name: "ネットワークを用意する",
        actor: "agent",
        project: "terraform",
        inputs: ["base"],
        outputs: ["network"],
        purpose: "サービスの置き場を用意する",
        steps: "VPC とサブネットの terraform を足す",
        done_when: "terraform plan が通る",
      },
      {
        id: "2",
        name: "サービスを実装する",
        actor: "agent",
        project: "tp",
        inputs: ["network"],
        outputs: ["service"],
        purpose: "ネットワーク上で動くサービスを作る",
        steps: "サービスの実装を足す",
        done_when: "サービスのテストが通る",
      },
      {
        id: "3",
        name: "サービスをデプロイする",
        actor: "agent",
        project: "kubernetes",
        inputs: ["service"],
        outputs: ["deploy"],
        purpose: "サービスを動かす",
        steps: "マニフェストを足す",
        done_when: "マニフェストの検証が通る",
      },
    ],
  };
}

test("3 リポジトリの workspace で、1 つの Intake が各リポジトリに sub-issue を作り、PFD の順に投入して完了する", async () => {
  const terraform = await repoWithOrigin(root, "terraform");
  const tp = await repoWithOrigin(root, "tp");
  const kubernetes = await repoWithOrigin(root, "kubernetes");
  const repos = [terraform, tp, kubernetes];

  const db = await openDb(":memory:");
  const workspaceId = await insertWorkspace(db, { path: join(root, "ws"), name: "ws" });
  const projectIds = new Map<string, number>();
  for (const r of repos) {
    projectIds.set(
      r.name,
      await insertProject(db, {
        workspace_id: workspaceId,
        name: r.name,
        path: r.path,
        default_workflow: "feature",
        max_concurrent: 1,
        base_branch: "main",
        setup: null,
      }),
    );
  }
  await insertActiveIntake(db, {
    workspaceId,
    pfd: crossRepoPfd(),
    issueUrl: "https://github.com/o/tp/issues/1",
  });

  const byPath = new Map(repos.map((r) => [r.path, r]));
  const nodes: { id: string; url: string; state: string; body: string }[] = [];
  const merged = new Map<string, { number: number; url: string; oid: string }>();
  let n = 100;
  const gh = fakeGh((a, cwd) => {
    const repo = byPath.get(cwd);
    if (a[0] === "repo" && a[1] === "view") {
      if (!repo) return undefined;
      return JSON.stringify({ id: repo.repositoryId, nameWithOwner: `o/${repo.name}` });
    }
    if (a[0] !== "api" || a[1] !== "graphql" || !repo) return undefined;
    const g = parseGraphqlArgs(a);
    if (/createIssue/.test(g.query)) {
      n++;
      const node = {
        id: `I_${n}`,
        url: `https://github.com/o/${repo.name}/issues/${n}`,
        state: "OPEN",
        body: g.raw.body,
      };
      nodes.push(node);
      return JSON.stringify({ data: { createIssue: { issue: { id: node.id, url: node.url } } } });
    }
    if (/subIssues/.test(g.query)) {
      return JSON.stringify({ data: { node: { subIssues: { nodes } } } });
    }
    if (/pullRequests/.test(g.query)) {
      const found: Record<string, unknown> = {};
      for (let i = 0; g.raw[`h${i}`] !== undefined; i++) {
        const pr = merged.get(g.raw[`h${i}`]);
        found[`b${i}`] = {
          nodes: pr
            ? [{
              number: pr.number,
              url: pr.url,
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-09-30T00:00:00Z",
              mergeCommit: { oid: pr.oid },
            }]
            : [],
        };
      }
      return JSON.stringify({ data: { repository: found } });
    }
    return undefined;
  });

  const transitions: IntakeTransition[] = [];
  const watcher = createIntakeWatcher({
    db,
    trackerOf: constTrackerOf(ghTracker(gh.run)),
    prWatcher: ghPrWatcher(gh.run),
    baseSync: gitBaseSync,
    loadWorkflow: fakeWorkflowLoader(),
    onStateChanged: (t) => transitions.push(t),
    onUpdated: () => {},
  });

  const lap = async () => {
    await watcher.request(workspaceId);
    const health = watcher.health(workspaceId);
    assert.equal(health.consecutiveFailures, 0, health.lastError ?? undefined);
  };
  const subOf = async (id: string) =>
    (await listProcesses(db, "i1")).find((p) => p.process_id === id)!;
  const tasksOf = async (id: string) =>
    (await listTasks(db)).filter((t) => t.intake_process_id === id);
  const mergeTask = async (id: string, repo: Repo, file: string) => {
    const [task] = await tasksOf(id);
    const oid = await mergeOnOrigin(repo, file);
    merged.set((await getTask(db, task.id))!.branch, {
      number: 7,
      url: `https://github.com/o/${repo.name}/pull/7`,
      oid,
    });
    return oid;
  };
  const createCalls = () =>
    gh.calls.filter((c) => /createIssue/.test(parseGraphqlArgs(c.args).query));

  // 最初の周: sub-issue が 3 リポジトリに作られ、上流の terraform だけが投入される
  await lap();
  const creates = createCalls().map((c) => ({ cwd: c.cwd, g: parseGraphqlArgs(c.args) }));
  assert.deepEqual(
    creates.map((c) => [c.cwd, c.g.raw.repositoryId]),
    [
      [terraform.path, "R_terraform"],
      [tp.path, "R_tp"],
      [kubernetes.path, "R_kubernetes"],
    ],
  );
  assert.deepEqual(creates.map((c) => c.g.raw.parentIssueId), ["I_1", "I_1", "I_1"]);
  assert.ok((await subOf("1")).sub_issue_url?.startsWith("https://github.com/o/terraform/issues/"));
  assert.ok((await subOf("2")).sub_issue_url?.startsWith("https://github.com/o/tp/issues/"));
  assert.ok(
    (await subOf("3")).sub_issue_url?.startsWith("https://github.com/o/kubernetes/issues/"),
  );
  const first = await listTasks(db);
  assert.equal(first.length, 1);
  assert.equal(first[0].intake_process_id, "1");
  assert.equal(first[0].project_id, projectIds.get("terraform"));
  assert.equal(first[0].issue_url, (await subOf("1")).sub_issue_url);
  assert.equal(first[0].parent_issue_url, "https://github.com/o/tp/issues/1");

  // terraform がマージされる: tp が投入され、kubernetes はまだ
  const c1 = await mergeTask("1", terraform, "network.txt");
  await lap();
  assert.equal(await containsCommit(terraform.path, originRef("main"), c1), true);
  const tpTasks = await tasksOf("2");
  assert.equal(tpTasks.length, 1);
  assert.equal(tpTasks[0].project_id, projectIds.get("tp"));
  assert.equal((await tasksOf("3")).length, 0);
  assert.equal((await getIntake(db, "i1"))!.state, "active");

  // tp がマージされる: kubernetes が投入される
  const c2 = await mergeTask("2", tp, "service.txt");
  await lap();
  assert.equal(await containsCommit(tp.path, originRef("main"), c2), true);
  const kTasks = await tasksOf("3");
  assert.equal(kTasks.length, 1);
  assert.equal(kTasks[0].project_id, projectIds.get("kubernetes"));
  assert.equal((await getIntake(db, "i1"))!.state, "active");

  // kubernetes がマージされる: Intake が完了する
  await mergeTask("3", kubernetes, "deploy.txt");
  await lap();
  const done = (await getIntake(db, "i1"))!;
  assert.equal(done.state, "completed");
  assert.notEqual(done.ended_at, null);
  assert.deepEqual(transitions.map((t) => [t.from, t.to]), [["active", "completed"]]);
  const all = await listTasks(db);
  assert.deepEqual(all.map((t) => t.intake_process_id).toSorted(), ["1", "2", "3"]);
  assert.equal(createCalls().length, 3);
  assert.equal(gh.calls.some((c) => /closeIssue/.test(parseGraphqlArgs(c.args).query)), false);
});
