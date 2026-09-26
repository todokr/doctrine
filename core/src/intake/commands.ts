import {
  answerQuestionSet,
  findOpenIntakeByIssue,
  getIntake,
  insertApproval,
  insertComments,
  insertIntake,
  insertProcesses,
  latestDraft,
  listLiveIntakeTasks,
  listProcesses,
  type NewIntakeComment,
  recordHumanDone,
  retireProcesses,
  updateIntake,
} from "../db/intakes.ts";
import { advanceParentIssue } from "./issueStateSync.ts";
import { loadQuestionSets } from "./questionSet.ts";
import type { Db, IntakeRow, IntakeState } from "../db/schema.ts";
import { getProject, type TaskState } from "../db/tasks.ts";
import { cancelTask } from "../domain/cancelTask.ts";
import { assertIntakeTransition, isIntakeTerminal } from "../domain/intakeStates.ts";
import { killStaleChild, type ProcessProbe } from "../domain/recovery.ts";
import type { Tracker } from "../tracker/tracker.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import { validateAnswers } from "../../../shared/intake/validateQuestion.ts";
import { loadApprovedPlan } from "./dispatch.ts";
import { computeProcessStatuses } from "./pfd/status.ts";
import { loadRevisionConstraints, processRowChanges, revisionIssues } from "./revision.ts";
import { enqueueIntakeRun } from "./runner.ts";
import { closeSubIssuesOnCancel } from "./subIssueSync.ts";
import { processProgressOf } from "./view.ts";

/** 状態を変えた操作が返す。ハンドラがイベントにして配る。 */
export type IntakeTransition = {
  intakeId: string;
  from: IntakeState;
  to: IntakeState;
  /** 遷移の後の値。アプリはこの値で一覧の行を上書きする。 */
  revising: boolean;
};

const STALE_DRAFT = "表示している案は最新ではありません";

async function requireIntake(db: Db, intakeId: string): Promise<IntakeRow> {
  const intake = await getIntake(db, intakeId);
  if (!intake) throw new Error("Intake がありません");
  return intake;
}

/**
 * 同じ Issue の終わっていない Intake があれば、作らずにそれを返す。
 * 失敗応答は文字列しか運べず既存の id を返せないので、失敗にはしない（spec 13 章）。
 */
export async function startIntake(
  db: Db,
  tracker: Pick<Tracker, "readIssue" | "kind" | "advanceIssue">,
  o: { projectId: number; projectPath: string; issueUrl: string; logRoot: string },
): Promise<{ intake: IntakeRow; alreadyActive: boolean; problems: string[] }> {
  // gh が使えなくても、進行中の Intake は開けるように、gh を呼ぶ前にも引く。
  const opened = await findOpenIntakeByIssue(db, o.issueUrl);
  if (opened) return { intake: opened, alreadyActive: true, problems: [] };

  const issue = await tracker.readIssue(o.projectPath, o.issueUrl);
  const canonical = await findOpenIntakeByIssue(db, issue.url);
  if (canonical) return { intake: canonical, alreadyActive: true, problems: [] };

  const id = crypto.randomUUID();
  try {
    const intake = await db.transaction().execute(async (trx) => {
      const row = await insertIntake(trx, {
        id,
        project_id: o.projectId,
        issue_url: issue.url,
        issue_node_id: issue.nodeId,
        issue_title: issue.title,
      });
      await enqueueIntakeRun(trx, id, "investigate", { logRoot: o.logRoot, resume: false });
      return row;
    });
    // 失敗しても開始は成功させる。承認の後の見張りの周が issue_phase を見てやり直す
    const problems: string[] = [];
    try {
      await advanceParentIssue(db, tracker, { projectPath: o.projectPath, intake });
    } catch (e) {
      problems.push(
        `親 Issue の Linear の状態を進められませんでした: ${e instanceof Error ? e.message : e}`,
      );
    }
    return { intake, alreadyActive: false, problems };
  } catch (e) {
    // 競合で同じ Issue の Intake が先に入った。部分 unique index が最後の砦になる。
    if (!(e as Error).message.includes("UNIQUE constraint failed")) throw e;
    const winner = await findOpenIntakeByIssue(db, issue.url);
    if (!winner) throw e;
    return { intake: winner, alreadyActive: true, problems: [] };
  }
}

export async function answerIntake(
  db: Db,
  o: {
    intakeId: string;
    questionSetId: number;
    answers: unknown;
    assumptionResponses: unknown;
    logRoot: string;
  },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.state !== "answering") {
    throw new Error(`回答を受け付ける状態ではありません: ${intake.state}`);
  }
  const revising = intake.revising === 1;
  assertIntakeTransition("answering", "decomposing", revising);

  const set = (await loadQuestionSets(db, intake.id)).find((q) => q.id === o.questionSetId);
  if (!set) throw new Error("質問のまとまりがありません");
  if (set.reply !== null) throw new Error("すでに回答されています");
  const validated = validateAnswers(set, {
    answers: o.answers,
    assumptionResponses: o.assumptionResponses,
  });
  if (!validated.ok) throw new Error(validated.issues.join("\n"));

  await db.transaction().execute(async (trx) => {
    const reply = {
      answers: JSON.stringify(validated.answers),
      assumption_responses: JSON.stringify(validated.assumptionResponses),
    };
    if (!await answerQuestionSet(trx, set.id, reply)) {
      throw new Error("すでに回答されています");
    }
    await updateIntake(trx, intake.id, { state: "decomposing" }, { requireState: "answering" });
    await enqueueIntakeRun(trx, intake.id, revising ? "revise" : "decompose", {
      logRoot: o.logRoot,
      resume: false,
    });
  });
  return { intakeId: intake.id, from: "answering", to: "decomposing", revising };
}

const TARGET_KINDS: readonly string[] = ["artifact", "process", "whole"];

/** 差し戻しのコメントを確かめる。違反は何番目かを添えて失敗させる。 */
function checkComments(comments: unknown, pfd: Pfd): NewIntakeComment[] {
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error("コメントが 1 つ以上必要です");
  }
  return comments.map((c: Record<string, unknown> | null, i) => {
    const at = `コメント ${i + 1}`;
    const kind = c?.target_kind;
    const targetId = c?.target_id;
    const body = c?.body;
    if (typeof kind !== "string" || !TARGET_KINDS.includes(kind)) {
      throw new Error(`${at}: target_kind は artifact / process / whole のどれかです`);
    }
    if (kind === "whole") {
      if (targetId !== null) {
        throw new Error(`${at}: 計画全体へのコメントに target_id は付けられません`);
      }
    } else {
      const ids = (kind === "artifact" ? pfd.artifacts : pfd.processes).map((e) => e.id);
      if (typeof targetId !== "string" || !ids.includes(targetId)) {
        throw new Error(`${at}: 案に無い対象です: ${String(targetId)}`);
      }
    }
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error(`${at}: 本文が空です`);
    }
    return {
      target_kind: kind as NewIntakeComment["target_kind"],
      target_id: targetId as string | null,
      body,
    };
  });
}

export async function rejectIntake(
  db: Db,
  o: { intakeId: string; draftId: number; comments: unknown; logRoot: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.state !== "reviewing") {
    throw new Error(`差し戻せる状態ではありません: ${intake.state}`);
  }
  const revising = intake.revising === 1;
  assertIntakeTransition("reviewing", "decomposing", revising);

  const latest = await latestDraft(db, intake.id);
  if (!latest || latest.id !== o.draftId) throw new Error(STALE_DRAFT);
  const comments = checkComments(o.comments, JSON.parse(latest.pfd) as Pfd);

  await db.transaction().execute(async (trx) => {
    await insertComments(trx, intake.id, latest.id, comments, null);
    await updateIntake(trx, intake.id, { state: "decomposing" }, { requireState: "reviewing" });
    await enqueueIntakeRun(trx, intake.id, revising ? "revise" : "decompose", {
      logRoot: o.logRoot,
      resume: false,
    });
  });
  return { intakeId: intake.id, from: "reviewing", to: "decomposing", revising };
}

/**
 * 承認は人だけが行う。runner にも dctl にもこの経路は無い（spec 6 章 R-9）。
 * 判定の正本は、トランザクションの中で読み直した最新の案と hash の照合である。
 *
 * 改訂中の再承認は、固定された部分を変えていないかをもう一度確かめ、intake_processes の行を
 * 新しい案に揃える（増えた id を挿入し、消えた id に retired_at を入れる）。
 */
export async function approveIntake(
  db: Db,
  o: { intakeId: string; draftId: number; hash: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.state !== "reviewing") {
    throw new Error(`承認できる状態ではありません: ${intake.state}`);
  }
  assertIntakeTransition("reviewing", "active", intake.revising === 1);

  await db.transaction().execute(async (trx) => {
    const latest = await latestDraft(trx, intake.id);
    if (!latest || latest.id !== o.draftId) throw new Error(STALE_DRAFT);
    if (latest.hash !== o.hash) throw new Error("表示している案の内容が保存された案と異なります");
    const pfd = JSON.parse(latest.pfd) as Pfd;
    if (intake.revising === 1) {
      const issues = revisionIssues(pfd, await loadRevisionConstraints(trx, intake.id));
      if (issues.length > 0) throw new Error(issues.join("\n"));
    }
    await updateIntake(
      trx,
      intake.id,
      { state: "active", revising: 0, revision_run_id: null },
      { requireState: "reviewing" },
    );
    await insertApproval(trx, { intake_id: intake.id, draft_id: latest.id, hash: latest.hash });
    const changes = processRowChanges(await listProcesses(trx, intake.id), pfd);
    await insertProcesses(trx, intake.id, changes.insert);
    await retireProcesses(trx, intake.id, changes.retire, new Date().toISOString());
  });
  return { intakeId: intake.id, from: "reviewing", to: "active", revising: false };
}

/**
 * 進行中の Intake を改訂に入れる（C-1・C-2）。走っているタスクには触らない。
 * 投入は revising = 1 で止まる（dispatchIntake と status.ts の blockedBy）。
 * 改訂の会話は新しく始める（claude_session_id を捨てる）。
 */
export async function reviseIntake(
  db: Db,
  o: { intakeId: string; comments: unknown; logRoot: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.state !== "active") {
    throw new Error(`改訂に入れる状態ではありません: ${intake.state}`);
  }
  assertIntakeTransition("active", "decomposing", false);
  const approved = await loadApprovedPlan(db, intake.id);
  if (!approved) throw new Error("承認された計画がありません");
  const comments = checkComments(o.comments, approved.pfd);

  await db.transaction().execute(async (trx) => {
    // intake_comments.run_id と intakes.revision_run_id が実行の行を参照するので、実行を先に立てる
    const runId = await enqueueIntakeRun(trx, intake.id, "revise", {
      logRoot: o.logRoot,
      resume: false,
    });
    await insertComments(trx, intake.id, approved.draftId, comments, runId);
    await updateIntake(trx, intake.id, {
      state: "decomposing",
      revising: 1,
      revision_run_id: runId,
      claude_session_id: null,
      attention_reason: null,
      rate_limited_until: null,
    }, { requireState: "active" });
  });
  return { intakeId: intake.id, from: "active", to: "decomposing", revising: true };
}

/**
 * 改訂をやめて承認済みの計画に戻る（C-5）。承認と intake_processes には触らないので、
 * 最新の承認の案がそのまま計画になる。走っている実行は cancelIntake と同じく子を止め、
 * 実行の行は runner の settle が状態の食い違いを見て interrupted で閉じる。
 */
export async function abandonRevision(
  db: Db,
  deps: { probe: ProcessProbe },
  o: { intakeId: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.revising !== 1 || isIntakeTerminal(intake.state)) {
    throw new Error("改訂中ではありません");
  }
  assertIntakeTransition(intake.state, "active", true);
  await killStaleChild(intake, deps.probe, "SIGTERM");

  await db.transaction().execute(async (trx) => {
    await updateIntake(trx, intake.id, {
      state: "active",
      revising: 0,
      revision_run_id: null,
      claude_session_id: null,
      attention_reason: null,
      rate_limited_until: null,
      child_pid: null,
      child_started_at: null,
    }, { requireState: intake.state });
    await trx.updateTable("intake_runs")
      .set({ status: "interrupted", ended_at: new Date().toISOString() })
      .where("intake_id", "=", intake.id)
      .where("status", "=", "queued")
      .execute();
  });
  return { intakeId: intake.id, from: intake.state, to: "active", revising: false };
}

export type CancelOutcome = IntakeTransition & {
  /** stop で止めたタスク。ハンドラが task.stateChanged を配る。 */
  stoppedTasks: { taskId: string; from: TaskState }[];
  /** stop の後始末の失敗。Intake はもう canceled なので、見張りはやり直さない。ハンドラが警告に積む。 */
  problems: string[];
};

/**
 * 走っている実行は止めない（runner が settle で状態の食い違いを見て interrupted で閉じる）。
 * 立ったまま拾われない queued の行は、記録を正直に保つためここで閉じる。
 *
 * stop は、状態を canceled にした後で（以後の投入を先に止めるため）、その Intake のタスクを止め、
 * 開いている sub-issue を閉じる。後始末の失敗は中止を失敗にせず problems に入れる。
 */
export async function cancelIntake(
  db: Db,
  deps: {
    probe: ProcessProbe;
    trackerOf: (
      projectPath: string,
    ) => Promise<Pick<Tracker, "closeIssue" | "closesViaPullRequest">>;
  },
  o: { intakeId: string; mode: "leave" | "stop"; projectPath: string },
): Promise<CancelOutcome> {
  const intake = await requireIntake(db, o.intakeId);
  const revising = intake.revising === 1;
  assertIntakeTransition(intake.state, "canceled", revising);
  await killStaleChild(intake, deps.probe, "SIGTERM");

  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    await updateIntake(trx, intake.id, {
      state: "canceled",
      ended_at: now,
      child_pid: null,
      child_started_at: null,
      rate_limited_until: null,
    }, { requireState: intake.state });
    await trx.updateTable("intake_runs")
      .set({ status: "interrupted", ended_at: now })
      .where("intake_id", "=", intake.id)
      .where("status", "=", "queued")
      .execute();
  });
  const outcome: CancelOutcome = {
    intakeId: intake.id,
    from: intake.state,
    to: "canceled",
    revising,
    stoppedTasks: [],
    problems: [],
  };
  if (o.mode === "leave") return outcome;

  for (const task of await listLiveIntakeTasks(db, intake.id)) {
    try {
      const { from } = await cancelTask(db, task, deps.probe);
      outcome.stoppedTasks.push({ taskId: task.id, from });
    } catch (e) {
      outcome.problems.push(`タスク ${task.id} を止められませんでした: ${describe(e)}`);
    }
  }
  try {
    const project = (await getProject(db, intake.project_id))!;
    const tracker = await deps.trackerOf(o.projectPath);
    const closed = await closeSubIssuesOnCancel(db, tracker, {
      projectPath: o.projectPath,
      intakeId: intake.id,
      baseBranch: project.base_branch,
    });
    for (const f of closed.failures) {
      outcome.problems.push(
        `プロセス ${f.processId} の sub-issue を閉じられませんでした: ${f.message}`,
      );
    }
  } catch (e) {
    outcome.problems.push(`sub-issue を閉じられませんでした: ${describe(e)}`);
  }
  return outcome;
}

const describe = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * 人のプロセスの完了を記録する（H-2）。経路は RPC だけで、runner にも dctl にも無い（H-4）。
 * sub-issue を閉じるのと下流の投入は見張りの周が行う。
 */
export async function completeHumanProcess(
  db: Db,
  o: { intakeId: string; processId: string; note: unknown },
): Promise<void> {
  const { note } = o;
  if (typeof note !== "string" || note.trim() === "") throw new Error("完了の内容は必須です");
  const intake = await requireIntake(db, o.intakeId);
  // 改訂中は state が active でなく、固定集合が計算中なので、ここで拒む
  if (intake.state !== "active") {
    throw new Error(`完了を記録できる状態ではありません: ${intake.state}`);
  }
  const plan = await loadApprovedPlan(db, intake.id);
  const process = plan?.pfd.processes.find((p) => p.id === o.processId);
  if (!plan || !process || process.actor !== "human") {
    throw new Error(`人のプロセスではありません: ${o.processId}`);
  }
  const project = (await getProject(db, intake.project_id))!;
  const status = computeProcessStatuses({
    pfd: plan.pfd,
    baseBranch: project.base_branch,
    revising: false,
    dispatchPaused: intake.dispatch_paused === 1,
    progress: await processProgressOf(db, intake.id),
  }).find((s) => s.id === o.processId);
  if (status?.state === "done") throw new Error("すでに完了が記録されています");
  if (status?.state === "waiting") {
    throw new Error(`入力が揃っていません: ${status.missing.join(", ")}`);
  }
  if (status?.state !== "your_turn") {
    throw new Error(`完了を記録できるプロセスではありません: ${o.processId}`);
  }

  await db.transaction().execute(async (trx) => {
    await updateIntake(trx, intake.id, {}, { requireState: "active" });
    const recorded = await recordHumanDone(trx, intake.id, o.processId, {
      note,
      at: new Date().toISOString(),
    });
    if (!recorded) throw new Error("すでに完了が記録されています");
  });
}

/** 自動 dispatch の一時停止と再開（W-10）。承認済みの計画があり、終わっていない Intake だけ。 */
export async function setDispatchPaused(
  db: Db,
  o: { intakeId: string; paused: boolean },
): Promise<IntakeRow> {
  const intake = await requireIntake(db, o.intakeId);
  const revising = intake.revising === 1 && !isIntakeTerminal(intake.state);
  if (intake.state !== "active" && !revising) {
    throw new Error(`自動 dispatch を切り替えられる状態ではありません: ${intake.state}`);
  }
  await updateIntake(db, intake.id, { dispatch_paused: o.paused ? 1 : 0 }, {
    requireState: intake.state,
  });
  return await requireIntake(db, intake.id);
}

/** completed の Intake の親 Issue を completed で閉じる（W-11）。DB には何も書かない。 */
export async function closeParentIssue(
  db: Db,
  tracker: Pick<Tracker, "closeIssue">,
  o: { intakeId: string; projectPath: string },
): Promise<IntakeRow> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.state !== "completed") {
    throw new Error(`完了した Intake だけ親 Issue を閉じられます: ${intake.state}`);
  }
  await tracker.closeIssue(
    o.projectPath,
    { url: intake.issue_url, nodeId: intake.issue_node_id },
    "completed",
  );
  return intake;
}
