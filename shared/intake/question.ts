import { z } from "zod/v4";
import { diagramSchema } from "../guide/schema.ts";

const prose = "GFM のうち、生の HTML・画像・見出しを除いた記法で書く。";

const optionSchema = z.strictObject({
  id: z.string().describe("この質問の中で一意な選択肢の id"),
  label: z.string().describe("選択肢の表示名"),
  description: z.string().describe(`この選択肢を選ぶと何が起きるか。${prose}`),
});

const recommendationSchema = z.strictObject({
  optionIds: z
    .array(z.string())
    .describe(
      "推す選択肢の id。single は 1 つ、multiple は 1 つ以上、free は空配列",
    ),
  text: z
    .string()
    .nullable()
    .describe(`free の質問で推す答え。それ以外は null でもよい。${prose}`),
  reason: z.string().describe(`推す理由。${prose}`),
});

export const materialSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    body: z.string().describe(`判断の助けになる文章。${prose}`),
  }),
  z.strictObject({
    kind: z.literal("table"),
    caption: z.string().describe("表の見出し"),
    columns: z.array(z.string()).describe("列の名前"),
    rows: z
      .array(z.array(z.string()))
      .describe("行。各行の列数は columns と同じにする"),
  }),
  z.strictObject({
    kind: z.literal("code"),
    caption: z.string().describe("コードの見出し"),
    language: z.string().describe("コードの言語名"),
    path: z
      .string()
      .nullable()
      .describe("リポジトリのルートからのファイルパス。ファイルに由来しなければ null"),
    code: z.string().describe("コード"),
  }),
  z.strictObject({
    kind: z.literal("diagram"),
    caption: z.string().describe("図の見出し"),
    diagram: diagramSchema.describe("図。形はシーケンスとグラフの 2 つだけ"),
  }),
]);

/**
 * 分解エージェントが出す質問と、人の回答の形。
 * 各フィールドの describe は、そのまま書き手への指示になる。
 */
export const questionSchema = z.strictObject({
  id: z.string().describe("質問のまとまりの中で一意な id"),
  prompt: z.string().describe(`人に尋ねる問い。${prose}`),
  kind: z
    .enum(["single", "multiple", "free"])
    .describe("single: 1 つ選ぶ / multiple: 1 つ以上選ぶ / free: 選択肢を持たず文章で答える"),
  options: z.array(optionSchema).describe("選択肢。free では空配列"),
  recommendation: recommendationSchema
    .nullable()
    .describe("推奨とその理由。推奨が無ければ null"),
  materials: z.array(materialSchema).describe("判断の材料。無ければ空配列"),
});

/** 一度に届く質問のまとまり。空配列は「質問は無い」の意味で正しい。 */
export const questionSetSchema = z.array(questionSchema);

export const answerSchema = z.strictObject({
  questionId: z.string().describe("答える質問の id"),
  optionIds: z.array(z.string()).describe("選んだ選択肢の id。選ばなければ空配列"),
  other: z.string().nullable().describe("選択肢以外の答え。無ければ null"),
  note: z.string().nullable().describe("答えへの補足。無ければ null"),
});

export const answerSetSchema = z.array(answerSchema);

export type Question = z.infer<typeof questionSchema>;
export type QuestionOption = z.infer<typeof optionSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type Material = z.infer<typeof materialSchema>;
export type Answer = z.infer<typeof answerSchema>;
