import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../../src/adapter/types.ts";
import { insertIntake } from "../../src/db/intakes.ts";
import { openDb } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/schema.ts";
import { insertProject } from "../../src/db/tasks.ts";
import { claimIntakeRun, type IntakeRunnerDeps, runIntakeRun } from "../../src/intake/runner.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { Question } from "../../../shared/intake/question.ts";
import { fakeTracker } from "../helpers/tracker.ts";
import { makeRepo } from "../helpers/repo.ts";

export type Fixture = {
  root: string;
  repo: string;
  db: Db;
  projectId: number;
  logRoot: string;
  originalStateDir: string | undefined;
};

/** 実の git リポジトリ・状態ディレクトリ・DB・Intake（id i1）を用意する。 */
export async function createFixture(): Promise<Fixture> {
  const originalStateDir = Deno.env.get("DOCTRINE_STATE_DIR");
  const root = await mkdtemp(join(tmpdir(), "doctrine-intake-"));
  Deno.env.set("DOCTRINE_STATE_DIR", join(root, "state"));
  const repo = await makeRepo(root, { "README.md": "x\n" });
  const db = await openDb(":memory:");
  const projectId = await insertProject(db, {
    path: repo,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertIntake(db, {
    id: "i1",
    project_id: projectId,
    issue_url: "https://github.com/o/r/issues/1",
    issue_node_id: "N1",
    issue_title: "T",
  });
  return { root, repo, db, projectId, logRoot: join(root, "logs"), originalStateDir };
}

export async function destroyFixture(f: Fixture): Promise<void> {
  if (f.originalStateDir === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
  else Deno.env.set("DOCTRINE_STATE_DIR", f.originalStateDir);
  await rm(f.root, { recursive: true, force: true });
}

export function depsOf(f: Fixture, adapter: AgentAdapter): IntakeRunnerDeps {
  return {
    db: f.db,
    adapter,
    tracker: fakeTracker({ title: "T", body: "Issue の本文" }),
    logRoot: f.logRoot,
  };
}

/** queued の行を id 順に 1 つ取り、claim して走らせる。queued が無くなるまで繰り返す。 */
export async function drive(db: Db, deps: IntakeRunnerDeps): Promise<void> {
  for (;;) {
    const next = await db.selectFrom("intake_runs").selectAll()
      .where("status", "=", "queued").orderBy("id").executeTakeFirst();
    if (next === undefined) return;
    if (!await claimIntakeRun(db, next.id)) throw new Error("claim できませんでした");
    await runIntakeRun(db, next.id, deps);
  }
}

export const question = (id: string): Question => ({
  id,
  prompt: "どうするか",
  kind: "single",
  options: [
    { id: "a", label: "案A", description: "d" },
    { id: "b", label: "案B", description: "d" },
  ],
  recommendation: null,
  materials: [],
});

export const questionsOut = (questions: Question[]) => ({
  structuredOutput: { kind: "questions", questions, pfd: null, replies: null } as Record<
    string,
    unknown
  >,
});

export const pfdOut = (pfd: Pfd, replies: { commentId: number; reply: string }[] = []) => ({
  structuredOutput: { kind: "pfd", questions: null, pfd, replies } as Record<string, unknown>,
});
