import { z } from "zod/v4";
import type { AgentAdapter } from "../adapter/types.ts";
import { slugify } from "./worktree.ts";

/** slug（doctrine/ を付ける前の部分）を返す。決められなかったら null。投げない。 */
export type BranchNamer = (o: { title: string; prompt: string }) => Promise<string | null>;

const PROMPT_LIMIT = 4000;

const branchSlugSchema = z.strictObject({
  slug: z.string().describe("英小文字・数字・ハイフンだけで、作業内容を表す 2〜5 語程度の英語"),
});

export function branchSlugJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(branchSlugSchema, { target: "draft-7" });
}

export function buildBranchNamePrompt(o: { title: string; prompt: string }): string {
  return [
    "次のタスクの題と本文から、git のブランチ名に使う slug を 1 つ決めてください。",
    "- 作業内容を表す英語の短い slug にする（例: ping-clamd-healthz）",
    "- `doctrine/` は付けない",
    "- 英小文字・数字・ハイフンだけを使い、40 文字以内にする",
    "- ツールは使わず、下に渡した文章だけで決める",
    "",
    `題: ${o.title}`,
    "",
    "本文:",
    o.prompt.slice(0, PROMPT_LIMIT),
  ].join("\n");
}

export function slugFromOutput(output: Record<string, unknown> | null): string | null {
  const raw = output?.slug;
  if (typeof raw !== "string") return null;
  const slug = slugify(raw.replace(/^doctrine\//, ""));
  return slug === "" ? null : slug;
}

export function createClaudeBranchNamer(
  adapter: AgentAdapter,
  o: { cwd: string; timeoutMs?: number; model?: string },
): BranchNamer {
  return async (task) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = adapter.start(buildBranchNamePrompt(task), {
        cwd: o.cwd,
        sessionId: crypto.randomUUID(),
        model: o.model ?? "haiku",
        allowedTools: [],
        jsonSchema: branchSlugJsonSchema(),
      });
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), o.timeoutMs ?? 30_000);
      });
      const result = await Promise.race([run.result, timedOut]);
      if (result === "timeout") {
        // 打ち切った後に reject されても unhandled rejection にしない
        run.result.catch(() => {});
        run.kill();
        return null;
      }
      return result.ok ? slugFromOutput(result.structuredOutput) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
