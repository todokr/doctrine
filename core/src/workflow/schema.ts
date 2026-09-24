import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type Branch = {
  goto: string;
  maxAttempts: number;
  feed?: string;
  /** maxAttempts を使い切ったとき。suspend なら failed にせず人の承認を待つ（省略時 fail）。 */
  onExhausted?: "fail" | "suspend";
};
export type CommandStep = { id: string; type: "command"; run: string; onFailure?: Branch };
export type AgentStep = {
  id: string;
  type: "agent";
  prompt: string;
  session?: string;
  permissionMode?: string;
  model?: string;
  allowedTools?: string[];
  onFailure?: Branch;
};
/** approval ステップが「これを見て判断してください」と宣言するもの。 */
export type ReviewDecl = { files: string[] };
export type ApprovalStep = {
  id: string;
  type: "approval";
  title: string;
  onReject?: Branch;
  review?: ReviewDecl;
};
/**
 * Review Guide を作るステップ。プロンプトは doctrine が持つので prompt は書けない。
 * session は必須で、暗黙の既定ロールは持たない。
 */
export type GuideStep = {
  id: string;
  type: "guide";
  session: string;
  permissionMode?: string;
  model?: string;
  allowedTools?: string[];
  onFailure?: Branch;
};
/**
 * 判定コマンドを interval ごとに実行して待つステップ。終了コードの意味は
 * 0 済み / 75 まだ / 2 諦める（canceled）/ それ以外は失敗。
 */
export type PollStep = {
  id: string;
  type: "poll";
  run: string;
  interval: string;
  onFailure?: Branch;
};
export type Step = CommandStep | AgentStep | ApprovalStep | GuideStep | PollStep;
export type Workflow = { name: string; steps: Step[] };

export const RESERVED_STEP_IDS = ["setup"] as const;

export const DEFAULT_POLL_INTERVAL = "1m";
export const MIN_POLL_INTERVAL_MS = 30_000;
const INTERVAL_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** "30s" / "5m" / "2h" をミリ秒にする。書式が違うか下限を割れば投げる。 */
export function intervalMs(interval: string): number {
  const m = /^(\d+)([smh])$/.exec(interval);
  if (!m) throw new Error(`interval は 30s / 5m / 2h のように書いてください: ${interval}`);
  const ms = Number(m[1]) * INTERVAL_UNITS[m[2]];
  if (ms < MIN_POLL_INTERVAL_MS) throw new Error(`interval は 30s 以上にしてください: ${interval}`);
  return ms;
}

/** 再実行で二重に効く代表的なコマンド。完全には防げないが、黙って壊れるよりよい。 */
const NON_IDEMPOTENT = [
  /\bgh\s+pr\s+create\b/,
  /\bgh\s+pr\s+comment\b/,
  /\bgh\s+release\s+create\b/,
  /\bgit\s+push\b/,
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
];

export class WorkflowValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`ワークフロー定義が不正です:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

const stepId = z.string().min(1).regex(
  /^[a-zA-Z0-9_-]+$/,
  "ステップidは英数字・ハイフン・アンダースコアのみ",
);
const branch = z.object({
  goto: z.string().min(1),
  maxAttempts: z.number().int().min(1),
  feed: z.string().optional(),
  onExhausted: z.enum(["fail", "suspend"]).optional(),
}).strict();

/**
 * review.files のパス。worktree からの相対に限る。
 * 指す先が worktree の外に出ていないかは、読み出し時に realpath で確かめる
 * （src/domain/reviewFiles.ts）。ここで見るのは書かれた文字列だけ。
 */
const reviewPath = z.string()
  .min(1, "ファイルのパスが空です")
  .refine(
    (p) => !p.startsWith("/"),
    "絶対パスは書けません（worktree からの相対パスを書いてください）",
  )
  .refine(
    (p) => !p.startsWith("~"),
    "~ は展開されません（worktree からの相対パスを書いてください）",
  )
  .refine(
    (p) => !p.split("/").includes(".."),
    ".. は書けません（worktree の外のファイルは宣言できません）",
  );

const review = z.object({
  files: z.array(reviewPath).min(1, "review.files は1つ以上必要です"),
}).strict();

const sessionRole = z.string().min(1).regex(
  /^[a-zA-Z0-9_-]+$/,
  "sessionは英数字・ハイフン・アンダースコアのみ",
);

const stepSchema = z.discriminatedUnion("type", [
  z.object({
    id: stepId,
    type: z.literal("command"),
    run: z.string().min(1),
    onFailure: branch.optional(),
  }).strict(),
  z.object({
    id: stepId,
    type: z.literal("agent"),
    prompt: z.string().min(1),
    session: sessionRole.optional(),
    permissionMode: z.string().optional(),
    model: z.string().optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    onFailure: branch.optional(),
  }).strict(),
  z.object({
    id: stepId,
    type: z.literal("approval"),
    title: z.string().min(1),
    onReject: branch.optional(),
    review: review.optional(),
  }).strict(),
  z.object({
    id: stepId,
    type: z.literal("guide"),
    session: sessionRole,
    permissionMode: z.string().optional(),
    model: z.string().optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    onFailure: branch.optional(),
  }).strict(),
  z.object({
    id: stepId,
    type: z.literal("poll"),
    run: z.string().min(1),
    interval: z.string().default(DEFAULT_POLL_INTERVAL).refine((v) => {
      try {
        intervalMs(v);
        return true;
      } catch {
        return false;
      }
    }, "interval は 30s 以上で、30s / 5m / 2h のように書いてください"),
    onFailure: branch.optional(),
  }).strict(),
]);

const workflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1, "steps は1つ以上必要です"),
}).strict();

/**
 * ステップの「失敗時の分岐」を型を問わず取り出す。
 * approval は onReject、それ以外（command / agent / guide / poll）は onFailure。
 * guide は onFailure を書かなければ、自分に戻って理由を feed する既定の分岐を持つ。
 * ワークフローエンジン（後続タスク）も同じアクセサを使う。
 */
export function branchOf(step: Step): Branch | undefined {
  if (step.type === "approval") return step.onReject;
  if (step.type === "guide" && step.onFailure === undefined) {
    return {
      goto: step.id,
      maxAttempts: DEFAULT_GUIDE_MAX_ATTEMPTS,
      feed: `{{ steps.${step.id}.last_stderr }}`,
    };
  }
  return step.onFailure;
}

/** guide ステップが既定で持つ「自分に戻ってやり直す」回数。 */
export const DEFAULT_GUIDE_MAX_ATTEMPTS = 3;

/** 既にスキーマ側でカスタムメッセージ（日本語）が設定されているかの簡易判定。 */
const containsJapanese = (s: string): boolean => /[぀-ヿ㐀-鿿]/.test(s);

function translateZodIssue(issue: z.ZodIssueOptionalMessage & { message?: string }): string {
  const message = (issue as z.ZodIssue).message;
  // すでに日本語のカスタムメッセージが設定されている場合はそのまま使う
  // （stepId の正規表現エラー、steps の min(1) など）。
  if (message && containsJapanese(message)) return message;

  switch (issue.code) {
    case z.ZodIssueCode.invalid_type: {
      if (issue.received === "undefined") {
        return `必須の項目が指定されていません（${issue.expected} が必要です）`;
      }
      return `型が不正です: ${issue.expected} が必要ですが ${issue.received} が指定されました`;
    }
    case z.ZodIssueCode.unrecognized_keys: {
      return `認識できないキーがあります: ${issue.keys.join(", ")}`;
    }
    case z.ZodIssueCode.too_small: {
      if (issue.type === "string") {
        return `文字列が短すぎます（${issue.minimum}文字以上必要です）`;
      }
      if (issue.type === "number") {
        const cmp = issue.inclusive ? "以上" : "より大きい値";
        return `数値が小さすぎます（${issue.minimum}${cmp}が必要です）`;
      }
      if (issue.type === "array") {
        return `要素数が足りません（${issue.minimum}件以上必要です）`;
      }
      return message ?? "値が小さすぎます";
    }
    case z.ZodIssueCode.too_big: {
      if (issue.type === "string") {
        return `文字列が長すぎます（${issue.maximum}文字以内にしてください）`;
      }
      if (issue.type === "number") {
        const cmp = issue.inclusive ? "以下" : "より小さい値";
        return `数値が大きすぎます（${issue.maximum}${cmp}が必要です）`;
      }
      if (issue.type === "array") {
        return `要素数が多すぎます（${issue.maximum}件以内にしてください）`;
      }
      return message ?? "値が大きすぎます";
    }
    case z.ZodIssueCode.invalid_string: {
      // regex等のカスタムメッセージが日本語でない場合のフォールバック
      return message ?? "文字列の形式が不正です";
    }
    case z.ZodIssueCode.invalid_union_discriminator: {
      return `次のいずれかである必要があります: ${issue.options.join(", ")}`;
    }
    case z.ZodIssueCode.invalid_enum_value: {
      return `値が不正です。次のいずれかである必要があります: ${issue.options.join(", ")}`;
    }
    default:
      // 未対応のコードは zod 自身のメッセージにフォールバックする
      return message ?? "不明な検証エラーです";
  }
}

/**
 * zod の ZodError を、ユーザーに見せてよい日本語メッセージの配列に変換する。
 * ワークフローYAMLは人間が手で書く設定ファイルなので、エラーメッセージの質が
 * 直接UXになる。zodの英語デフォルトメッセージをそのまま出さない。
 * project.yaml のバリデーション（後続タスク）もこの関数を再利用する。
 */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    `${issue.path.join(".") || "(root)"}: ${translateZodIssue(issue)}`
  );
}

export function parseWorkflow(yamlText: string): { workflow: Workflow; warnings: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowValidationError([`YAMLとして読めません: ${(e as Error).message}`]);
  }

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(formatZodIssues(parsed.error));
  }
  const workflow = parsed.data as Workflow;

  const issues: string[] = [];
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) issues.push(`ステップidが重複しています: ${step.id}`);
    seen.add(step.id);
    if ((RESERVED_STEP_IDS as readonly string[]).includes(step.id)) {
      issues.push(
        `ステップid "${step.id}" は予約語です（project.yaml の setup が自動挿入されます）`,
      );
    }
    // approval の却下は既に人が下した判断なので、上限に達したところでもう一度人を待たせる
    // 意味が無い（applyApproval は escalate を approval 側に実装していない）。
    if (step.type === "approval" && step.onReject?.onExhausted === "suspend") {
      issues.push(
        `ステップ "${step.id}" の onReject に onExhausted: suspend は書けません（approval の却下は既に人の判断なので、上限到達で再び人を待つ意味がありません）`,
      );
    }
  }
  for (const step of workflow.steps) {
    const b = branchOf(step);
    if (b && !seen.has(b.goto)) {
      issues.push(`ステップ "${step.id}" の goto が存在しないステップを指しています: ${b.goto}`);
    }
  }
  if (issues.length > 0) throw new WorkflowValidationError(issues);

  const warnings: string[] = [];
  for (const step of workflow.steps) {
    if (step.type !== "command" && step.type !== "poll") continue;
    if (NON_IDEMPOTENT.some((re) => re.test(step.run))) {
      warnings.push(
        `ステップ "${step.id}" のコマンドは再実行で二重に効く可能性があります: ${step.run}\n` +
          `  クラッシュ復帰時、command / poll ステップは頭から再実行されます。`,
      );
    }
  }
  return { workflow, warnings };
}
