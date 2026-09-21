import { z } from "zod/v4";

const prose = "GFM のうち、生の HTML・画像・見出しを除いた記法で書く。";

const changeSchema = z
  .enum(["added", "changed", "removed"])
  .describe("この要素がこの変更で加わった（added）・変わった（changed）・除かれた（removed）もの");

const locationSchema = z.strictObject({
  path: z.string().describe("リポジトリのルートからのファイルパス"),
  hunk: z
    .string()
    .optional()
    .describe("doctrine が振った hunk の id。省くとファイル全体を指す"),
});

const refsSchema = z.strictObject({
  decisions: z.array(z.string()).describe("関連する decisions の id。無ければ空配列"),
  risks: z.array(z.string()).describe("関連する risks の id。無ければ空配列"),
  tests: z.array(z.string()).describe("関連する tests の id。無ければ空配列"),
  diagrams: z.array(z.string()).describe("関連する diagrams の id。無ければ空配列"),
});

const riskSchema = z.strictObject({
  id: z.string().describe("risks の中で一意な id"),
  kind: z
    .enum(["breaks", "assumption", "unknown", "considered"])
    .describe(
      "breaks: 壊れるもの / assumption: 置いた前提 / unknown: 確かめられていないこと / considered: 検討して問題ないと判断したこと",
    ),
  impact: z
    .enum(["high", "medium", "low"])
    .describe(
      "この項目が悪い方に転んだとき（壊れた・前提が崩れた・分からないことが悪い側だった・問題ないという判断が外れた）に起きることの大きさ。high: データの消失・破損や権限・秘密の露出、またはコードを戻すだけでは元に戻らない / medium: 既存の動作が変わるか誤った結果を返すが、コードを戻せば元に戻る / low: 利用者から見える動作は変わらない",
    ),
  body: z
    .string()
    .describe(
      `事実として書いた文章。悪い方に転んだとき何が起きるかを含め、impact の根拠が読めるようにする。推測や評価は混ぜない。${prose}`,
    ),
  locations: z.array(locationSchema).describe("関係する箇所。無ければ空配列"),
});

const sequenceSchema = z.strictObject({
  shape: z.literal("sequence"),
  actors: z.array(z.string()).describe("登場する主体を左から並べた名前"),
  messages: z
    .array(
      z.strictObject({
        from: z.string().describe("送り手の actors 上の名前"),
        to: z.string().describe("受け手の actors 上の名前"),
        label: z.string().describe("やり取りの内容"),
        change: changeSchema.optional(),
      }),
    )
    .describe("時系列順のやり取り"),
});

const graphSchema = z.strictObject({
  shape: z.literal("graph"),
  kind: z
    .enum(["relation", "dependency", "state"])
    .describe("relation: 関係 / dependency: 依存 / state: 状態遷移"),
  nodes: z.array(
    z.strictObject({
      id: z.string().describe("この図の中で一意なノードの id"),
      label: z.string().describe("ノードの表示名"),
      change: changeSchema.optional(),
    }),
  ),
  edges: z.array(
    z.strictObject({
      from: z.string().describe("始点のノードの id"),
      to: z.string().describe("終点のノードの id"),
      label: z.string().describe("辺の表示名。無ければ空文字"),
      change: changeSchema.optional(),
    }),
  ),
});

export const diagramSchema = z.strictObject({
  id: z.string().describe("diagrams の中で一意な id"),
  title: z.string().describe("図のタイトル"),
  body: z.discriminatedUnion("shape", [sequenceSchema, graphSchema]),
});

/**
 * Review Guide。ガイドを作るエージェントと、それを表示する画面の約束。
 * 各フィールドの describe は、そのまま書き手への指示になる。
 */
export const guideSchema = z.strictObject({
  version: z.literal(1).describe("この形式の版"),
  why: z.string().describe(`この変更の目的。${prose}`),
  what: z
    .array(
      z.strictObject({
        name: z.string().describe("概念の名前"),
        summary: z.string().describe(`その概念について何が変わったか。${prose}`),
        paths: z.array(z.string()).describe("この概念に属するファイルのパス。複数の概念に出てよい"),
      }),
    )
    .describe("変更を概念の単位に分けたもの"),
  how: z
    .array(
      z.strictObject({
        body: z.string().describe(`実現方法の説明。${prose}`),
        diagram: z.string().optional().describe("この説明に添える diagrams の id"),
      }),
    )
    .describe("実現方法を説明文と図の並びで示したもの"),
  readingOrder: z
    .array(
      z.strictObject({
        title: z.string().describe("グループのタイトル"),
        body: z.string().describe(`このグループで何を読み取るか。${prose}`),
        locations: z.array(locationSchema).describe("読む箇所を読む順に並べたもの"),
        refs: refsSchema,
      }),
    )
    .describe("diff を読む順に並べたグループ"),
  decisions: z
    .array(
      z.strictObject({
        id: z.string().describe("decisions の中で一意な id"),
        decision: z.string().describe("下した判断"),
        reason: z.string().describe(`その理由。${prose}`),
        source: z
          .strictObject({
            kind: z.enum(["step", "file"]).describe(
              "step: ワークフローのステップ id / file: worktree 内のファイルパス",
            ),
            value: z.string().describe("kind に応じたステップ id かファイルパス"),
          })
          .optional()
          .describe("判断の出典"),
      }),
    )
    .describe("設計上の判断"),
  risks: z.array(riskSchema).describe("リスク。事実を書き、読み手への指示は書かない"),
  tests: z
    .array(
      z.strictObject({
        id: z.string().describe("tests の中で一意な id"),
        behavior: z.string().describe("そのテストが確かめる振る舞い"),
        path: z.string().describe("テストのファイルパス"),
        name: z.string().describe("テスト名"),
      }),
    )
    .describe("変更を確かめるテスト"),
  diagrams: z.array(diagramSchema).describe("図。形はシーケンスとグラフの 2 つだけ"),
});

export type Guide = z.infer<typeof guideSchema>;
export type GuideLocation = z.infer<typeof locationSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type Diagram = z.infer<typeof diagramSchema>;
