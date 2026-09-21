import {
  answerQuestionSet,
  findOpenIntakeByIssue,
  getIntake,
  insertApproval,
  insertComments,
  insertIntake,
  insertProcesses,
  latestDraft,
  listQuestionSets,
  type NewIntakeComment,
  updateIntake,
} from "../db/intakes.ts";
import type { Db, IntakeRow, IntakeState } from "../db/schema.ts";
import { assertIntakeTransition } from "../domain/intakeStates.ts";
import { killStaleChild, type ProcessProbe } from "../domain/recovery.ts";
import type { Tracker } from "../github/tracker.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { Question } from "../../../shared/intake/question.ts";
import { validateAnswers } from "../../../shared/intake/validateQuestion.ts";
import { enqueueIntakeRun } from "./runner.ts";

/** 状態を変えた操作が返す。ハンドラがイベントにして配る。 */
export type IntakeTransition = {
  intakeId: string;
  from: IntakeState;
  to: IntakeState;
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
  tracker: Pick<Tracker, "readIssue">,
  o: { projectId: number; projectPath: string; issueUrl: string; logRoot: string },
): Promise<{ intake: IntakeRow; alreadyActive: boolean }> {
  // gh が使えなくても、進行中の Intake は開けるように、gh を呼ぶ前にも引く。
  const opened = await findOpenIntakeByIssue(db, o.issueUrl);
  if (opened) return { intake: opened, alreadyActive: true };

  const issue = await tracker.readIssue(o.projectPath, o.issueUrl);
  const canonical = await findOpenIntakeByIssue(db, issue.url);
  if (canonical) return { intake: canonical, alreadyActive: true };

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
    return { intake, alreadyActive: false };
  } catch (e) {
    // 競合で同じ Issue の Intake が先に入った。部分 unique index が最後の砦になる。
    if (!(e as Error).message.includes("UNIQUE constraint failed")) throw e;
    const winner = await findOpenIntakeByIssue(db, issue.url);
    if (!winner) throw e;
    return { intake: winner, alreadyActive: true };
  }
}

export async function answerIntake(
  db: Db,
  o: { intakeId: string; questionSetId: number; answers: unknown; logRoot: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  if (intake.state !== "answering") {
    throw new Error(`回答を受け付ける状態ではありません: ${intake.state}`);
  }
  const revising = intake.revising === 1;
  assertIntakeTransition("answering", "decomposing", revising);

  const set = (await listQuestionSets(db, intake.id)).find((q) => q.id === o.questionSetId);
  if (!set) throw new Error("質問のまとまりがありません");
  if (set.answers !== null) throw new Error("すでに回答されています");
  const validated = validateAnswers(JSON.parse(set.questions) as Question[], o.answers);
  if (!validated.ok) throw new Error(validated.issues.join("\n"));

  await db.transaction().execute(async (trx) => {
    if (!await answerQuestionSet(trx, set.id, JSON.stringify(validated.answers))) {
      throw new Error("すでに回答されています");
    }
    await updateIntake(trx, intake.id, { state: "decomposing" }, { requireState: "answering" });
    await enqueueIntakeRun(trx, intake.id, "decompose", { logRoot: o.logRoot, resume: false });
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
    await insertComments(trx, intake.id, latest.id, comments);
    await updateIntake(trx, intake.id, { state: "decomposing" }, { requireState: "reviewing" });
    await enqueueIntakeRun(trx, intake.id, "decompose", { logRoot: o.logRoot, resume: false });
  });
  return { intakeId: intake.id, from: "reviewing", to: "decomposing", revising };
}

/**
 * 承認は人だけが行う。runner にも dctl にもこの経路は無い（spec 6 章 R-9）。
 * 判定の正本は、トランザクションの中で読み直した最新の案と hash の照合である。
 */
export async function approveIntake(
  db: Db,
  o: { intakeId: string; draftId: number; hash: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  const revising = intake.revising === 1;
  assertIntakeTransition(intake.state, "active", revising);
  if (intake.state !== "reviewing") {
    throw new Error(`承認できる状態ではありません: ${intake.state}`);
  }

  await db.transaction().execute(async (trx) => {
    const latest = await latestDraft(trx, intake.id);
    if (!latest || latest.id !== o.draftId) throw new Error(STALE_DRAFT);
    if (latest.hash !== o.hash) throw new Error("表示している案の内容が保存された案と異なります");
    await updateIntake(trx, intake.id, { state: "active" }, { requireState: "reviewing" });
    await insertApproval(trx, { intake_id: intake.id, draft_id: latest.id, hash: latest.hash });
    const pfd = JSON.parse(latest.pfd) as Pfd;
    await insertProcesses(trx, intake.id, pfd.processes.map((p) => p.id));
  });
  return { intakeId: intake.id, from: "reviewing", to: "active", revising };
}

/**
 * 走っている実行は止めない（runner が settle で状態の食い違いを見て interrupted で閉じる）。
 * 立ったまま拾われない queued の行は、記録を正直に保つためここで閉じる。
 */
export async function cancelIntake(
  db: Db,
  probe: ProcessProbe,
  o: { intakeId: string },
): Promise<IntakeTransition> {
  const intake = await requireIntake(db, o.intakeId);
  const revising = intake.revising === 1;
  assertIntakeTransition(intake.state, "canceled", revising);
  await killStaleChild(intake, probe, "SIGTERM");

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
  return { intakeId: intake.id, from: intake.state, to: "canceled", revising };
}
