import { listQuestionSets } from "../db/intakes.ts";
import type { Db, IntakeQuestionSetRow } from "../db/schema.ts";
import type {
  Answer,
  Assumption,
  AssumptionResponse,
  Question,
} from "../../../shared/intake/question.ts";
import type { IntakeQuestionSet } from "../../../shared/protocol.ts";

/** 保存された JSON を読む。書くときに検証を通しているので、ここでは確かめない。 */
export function parseQuestionSet(row: IntakeQuestionSetRow): IntakeQuestionSet {
  return {
    id: row.id,
    run_id: row.run_id,
    questions: JSON.parse(row.questions) as Question[],
    assumptions: JSON.parse(row.assumptions) as Assumption[],
    reply: row.answers === null ? null : {
      answers: JSON.parse(row.answers) as Answer[],
      assumptionResponses: JSON.parse(row.assumption_responses ?? "[]") as AssumptionResponse[],
    },
    created_at: row.created_at,
    answered_at: row.answered_at,
  };
}

export async function loadQuestionSets(db: Db, intakeId: string): Promise<IntakeQuestionSet[]> {
  return (await listQuestionSets(db, intakeId)).map(parseQuestionSet);
}

/** まとまりの質問と仮定の id。成果物の decision はどちらも指せる。 */
export function questionSetIds(set: IntakeQuestionSet): string[] {
  return [...set.questions.map((q) => q.id), ...set.assumptions.map((a) => a.id)];
}
