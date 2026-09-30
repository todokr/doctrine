import { canonicalJson, type Pfd } from "../../../shared/intake/pfd.ts";
import {
  insertApproval,
  insertDraft,
  insertIntake,
  insertIntakeRun,
  insertProcesses,
  updateIntake,
} from "../../src/db/intakes.ts";
import { openDb } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/schema.ts";
import { insertProject } from "../../src/db/tasks.ts";
import { seedProject } from "../helpers/project.ts";
import { pfdHash } from "../../src/intake/pfd/hash.ts";
import { example } from "./pfd/fixture.ts";

export const PARENT_URL = "https://github.com/o/r/issues/1";

/** api という名前のプロジェクトを同じ workspace に足す。 */
export async function addApi(db: Db, workspaceId: number): Promise<number> {
  return await insertProject(db, {
    workspace_id: workspaceId,
    name: "api",
    path: "/api",
    default_workflow: "api-flow",
    max_concurrent: 1,
    base_branch: "develop",
    setup: null,
  });
}

/** 承認まで済み、state が active の Intake（id は i1）を 1 つ持つ DB。 */
export async function seedActive(
  pfd: Pfd = example(),
): Promise<{ db: Db; projectId: number; workspaceId: number; runId: number }> {
  const db = await openDb(":memory:");
  const p = await seedProject(db, { path: "/repo", default_workflow: "feature" });
  const projectId = p.id;
  const workspaceId = p.workspace_id;
  await insertIntake(db, {
    id: "i1",
    workspace_id: workspaceId,
    issue_url: PARENT_URL,
    issue_node_id: "I_1",
    issue_title: "親",
  });
  const runId = await insertIntakeRun(db, {
    intake_id: "i1",
    purpose: "decompose",
    attempt: 1,
    status: "success",
    started_at: null,
    log_path: "/dev/null",
  });
  const draft = await insertDraft(db, {
    intake_id: "i1",
    run_id: runId,
    pfd: canonicalJson(pfd),
    hash: await pfdHash(pfd),
    replies: "[]",
  });
  await insertApproval(db, { intake_id: "i1", draft_id: draft.id, hash: draft.hash });
  await insertProcesses(db, "i1", pfd.processes.map((p) => p.id));
  await updateIntake(db, "i1", { state: "active" });
  return { db, projectId, workspaceId, runId };
}
