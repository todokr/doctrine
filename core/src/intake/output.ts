import { z } from "zod/v4";
import type { IntakeRunPurpose } from "../db/schema.ts";
import {
  type DecomposerOutput,
  decomposerOutputSchema,
} from "../../../shared/intake/decomposer.ts";
import { validateQuestions } from "../../../shared/intake/validateQuestion.ts";
import { validatePfd } from "./pfd/validate.ts";
import { type RevisionConstraints, revisionIssues } from "./revision.ts";

export type OutputCheck =
  | { ok: true; output: DecomposerOutput }
  | { ok: false; issues: string[] };

// 誤りの理由は zod 同梱の日本語ロケールに任せる。z.config() はアプリ側のメッセージまで変えるので使わない
const parseOptions = { error: z.locales.ja().localeError };

/**
 * 構造化出力を、形・kind と中身の対応・purpose との対応・質問・PFD の順に確かめる。
 * 前が落ちたら後は見ない（stepRunner.ts の checkOutput と同じ）。
 */
export function checkDecomposerOutput(
  raw: Record<string, unknown> | null,
  ctx: {
    purpose: IntakeRunPurpose;
    /** これまでのまとまりにある質問と仮定の id。新しい質問と仮定の id と重なってはならない。 */
    askedIds: ReadonlySet<string>;
    /** 答えのある質問と応答のある仮定の id（validatePfd の decisionIds）。 */
    decisionIds: ReadonlySet<string>;
    /**
     * 最新の案（latestDraft）に draft_id で付いているコメントの数。案が無ければ 0。
     * 「直前に送った文面が差し戻しか」では決めない。差し戻し → 検証落ち → やり直し、
     * 差し戻し → 質問 → 回答 → PFD のどちらでも、エージェントが付けてくる replies を弾かないため。
     */
    feedbackCount: number;
    /** purpose が revise のときだけ runner が入れる。それ以外は null。 */
    revision: RevisionConstraints | null;
  },
): OutputCheck {
  if (raw === null) {
    return {
      ok: false,
      issues: [
        "構造化出力が返りませんでした。最終応答に、スキーマに沿った JSON を返してください。",
      ],
    };
  }

  const parsed = decomposerOutputSchema.safeParse(raw, parseOptions);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const out = parsed.data;

  if (out.kind === "questions") {
    if (
      out.questions === null || out.assumptions === null || out.pfd !== null ||
      out.replies !== null
    ) {
      return {
        ok: false,
        issues: [
          'kind が "questions" のときは、questions と assumptions を入れ、pfd と replies は null にしてください。',
        ],
      };
    }
    return checkQuestions({ questions: out.questions, assumptions: out.assumptions }, ctx);
  }

  if (
    out.pfd === null || out.replies === null || out.questions !== null ||
    out.assumptions !== null
  ) {
    return {
      ok: false,
      issues: [
        'kind が "pfd" のときは、pfd と replies を入れ、questions と assumptions は null にしてください。',
      ],
    };
  }
  if (ctx.purpose === "investigate") {
    return {
      ok: false,
      issues: ["調査の実行は質問と仮定だけを返します。PFD は返さないでください。"],
    };
  }

  const issues: string[] = [];
  for (
    const v of validatePfd(out.pfd, { decisionIds: ctx.decisionIds, frozen: null })
  ) {
    issues.push(`${v.rule} ${v.id}: ${v.message}`);
  }
  if (ctx.revision) issues.push(...revisionIssues(out.pfd, ctx.revision));
  const seen = new Set<number>();
  out.replies.forEach((r, i) => {
    if (!Number.isInteger(r.commentId) || r.commentId < 1 || r.commentId > ctx.feedbackCount) {
      issues.push(
        `replies.${i}.commentId: コメントの番号は 1〜${ctx.feedbackCount} の範囲で指定してください: ${r.commentId}`,
      );
    } else if (seen.has(r.commentId)) {
      issues.push(`replies.${i}.commentId: コメントの番号が重複しています: ${r.commentId}`);
    }
    seen.add(r.commentId);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, output: { kind: "pfd", pfd: out.pfd, replies: out.replies } };
}

function checkQuestions(
  raw: { questions: unknown[]; assumptions: unknown[] },
  ctx: { purpose: IntakeRunPurpose; askedIds: ReadonlySet<string> },
): OutputCheck {
  if (raw.questions.length === 0 && raw.assumptions.length === 0 && ctx.purpose !== "investigate") {
    return {
      ok: false,
      issues: [
        "分解の実行では、質問も仮定も無ければ PFD を返します。空のまとまりは返さないでください。",
      ],
    };
  }
  const validation = validateQuestions(raw);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const issues: string[] = [];
  validation.questions.forEach((q, i) => {
    if (ctx.askedIds.has(q.id)) {
      issues.push(`questions.${i}.id: 前に出した質問か仮定と id が重複しています: ${q.id}`);
    }
  });
  validation.assumptions.forEach((a, i) => {
    if (ctx.askedIds.has(a.id)) {
      issues.push(`assumptions.${i}.id: 前に出した質問か仮定と id が重複しています: ${a.id}`);
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    output: {
      kind: "questions",
      questions: validation.questions,
      assumptions: validation.assumptions,
    },
  };
}
