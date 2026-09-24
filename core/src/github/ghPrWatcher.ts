import { z } from "zod";
import type { PrFact } from "../../../shared/intake/processStatus.ts";
import { defaultGhRun, type GhRun, graphqlArgs, parseGhJson } from "./gh.ts";
import type { PrWatcher } from "../tracker/tracker.ts";

/** 1 クエリに並べる別名の上限（spec 11.2 章）。 */
export const PR_ALIASES_PER_QUERY = 50;

const PR_COLUMNS = "number url state baseRefName mergedAt mergeCommit { oid }";

const prNode = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  baseRefName: z.string(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});

const aliasResult = z.object({ nodes: z.array(prNode) });

function buildQuery(count: number): string {
  const idx = Array.from({ length: count }, (_, i) => i);
  const decls = idx.map((i) => `, $h${i}: String!`).join("");
  const aliases = idx
    .map((i) =>
      `b${i}: pullRequests(headRefName: $h${i}, states: [OPEN, MERGED, CLOSED], first: 20) { nodes { ${PR_COLUMNS} } }`
    )
    .join(" ");
  return `query($owner: String!, $name: String!${decls}) { repository(owner: $owner, name: $name) { ${aliases} } }`;
}

export function ghPrWatcher(run: GhRun = defaultGhRun): PrWatcher {
  return {
    async pullRequests(projectPath, branches) {
      const unique = [...new Set(branches)];
      const result = new Map<string, PrFact[]>();
      // 塊は順に呼ぶ。どれかが失敗したら、半分だけの Map を返さず投げる。
      for (let from = 0; from < unique.length; from += PR_ALIASES_PER_QUERY) {
        const chunk = unique.slice(from, from + PR_ALIASES_PER_QUERY);
        const vars: Record<string, string> = {};
        chunk.forEach((b, i) => vars[`h${i}`] = b);
        const args = graphqlArgs(buildQuery(chunk.length), vars, { repoVars: true });
        const schema = z.object({
          data: z.object({
            repository: z.object(
              Object.fromEntries(chunk.map((_, i) => [`b${i}`, aliasResult])),
            ),
          }),
        });
        const res = parseGhJson(
          schema,
          await run(args, projectPath),
          "gh api graphql pullRequests",
        );
        const repository = res.data.repository as Record<string, z.infer<typeof aliasResult>>;
        chunk.forEach((b, i) => {
          result.set(
            b,
            repository[`b${i}`].nodes.map((n): PrFact => ({
              number: n.number,
              url: n.url,
              state: n.state,
              baseRef: n.baseRefName,
              mergedAt: n.mergedAt,
              mergeCommit: n.mergeCommit?.oid ?? null,
            })),
          );
        });
      }
      return result;
    },
  };
}
