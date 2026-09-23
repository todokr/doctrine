import { z } from "zod/v4";
import { pfdSchema } from "./pfd.ts";
import {
  type Assumption,
  assumptionSetSchema,
  type Question,
  questionSetSchema,
} from "./question.ts";
import type { Pfd } from "./pfd.ts";

export const commentReplySchema = z.strictObject({
  commentId: z.number().int().describe(
    "返答する差し戻しのコメントの番号（文面で 1 から振られている）",
  ),
  reply: z.string().describe("そのコメントへの返答。どう直したか、または直さない理由"),
});

/**
 * --json-schema に渡す形と、デーモンが読む形を 1 つにする。トップレベルは 1 つのオブジェクトで、
 * kind と中身の対応はデーモンが確かめる（spec 7 章）。
 */
export const decomposerOutputSchema = z.strictObject({
  kind: z
    .enum(["questions", "pfd"])
    .describe("質問と仮定を返すなら questions、PFD を返すなら pfd"),
  questions: questionSetSchema
    .nullable()
    .describe(
      "kind が questions のときの、人の判断が要る論点の質問。無ければ空配列。pfd のときは null",
    ),
  assumptions: assumptionSetSchema
    .nullable()
    .describe(
      "kind が questions のときの、Issue・コード・慣習から導いた論点の仮定。崩れたときの影響が大きい順に並べる。無ければ空配列。pfd のときは null",
    ),
  pfd: pfdSchema.nullable().describe("kind が pfd のときの PFD。questions のときは null"),
  replies: z
    .array(commentReplySchema)
    .nullable()
    .describe(
      "kind が pfd のときの、差し戻しのコメントへの返答。差し戻しが無ければ空配列。questions のときは null",
    ),
});

export type CommentReply = z.infer<typeof commentReplySchema>;

export type DecomposerOutput =
  | { kind: "questions"; questions: Question[]; assumptions: Assumption[] }
  | { kind: "pfd"; pfd: Pfd; replies: CommentReply[] };

/** spec 5 章。intakes.attention_reason に JSON で入る。 */
export type AttentionReason =
  | { kind: "agent_failed"; runId: number; message: string }
  | { kind: "invalid_output"; runId: number; issues: string[] }
  | { kind: "wrote_repository"; runId: number; paths: string[] };

/** claude -p --json-schema に渡せる JSON Schema（draft-07）を返す。 */
export function decomposerJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(decomposerOutputSchema, { target: "draft-7" });
}
