import { basename, join } from "@std/path";
import type { Db } from "../db/schema.ts";
import { getWorkspaceByPath, projectNameFrom } from "../db/workspaces.ts";
import { parseWorkspaceConfig, WORKSPACE_YAML } from "../workflow/workspace.ts";
import { gitTopLevel } from "../workflow/scaffold.ts";
import { resolveRoot } from "./workspaceRegistry.ts";
import type { WorkspaceDetection } from "../../../shared/protocol.ts";

/**
 * ウィザードの「このディレクトリを選ぶ」ボタンが呼ぶ。ファイルは書かない。
 *
 * root がリポジトリのサブディレクトリなら、ensureWorkspaceScaffold と同じ文言で投げる
 * （ここでルートを選び直させる）。isRepoRoot なら repositories は空（root 自身を束ねる）。
 * そうでなければ直下の git リポジトリのルートを名前順に返す。
 */
export async function detectWorkspace(db: Db, path: string): Promise<WorkspaceDetection> {
  const root = await resolveRoot(path);

  const top = await gitTopLevel(root);
  if (top !== null && top !== root) {
    throw new Error(
      `リポジトリのルートを指定してください: ${top}（${root} はそのサブディレクトリです）`,
    );
  }
  const isRepoRoot = top === root;

  const repositories = isRepoRoot ? [] : await listSubRepositories(root);

  const yamlPath = join(root, WORKSPACE_YAML);
  const text = await Deno.readTextFile(yamlPath).catch((e) => {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  });
  let existing: WorkspaceDetection["existing"] = null;
  if (text !== null) {
    const cfg = parseWorkspaceConfig(text, basename(root));
    existing = {
      name: cfg.name,
      projects: Object.fromEntries(cfg.projects.map((p) => [p.name, p.path])),
      tracker: cfg.tracker,
    };
  }

  const alreadyRegistered = (await getWorkspaceByPath(db, root)) !== undefined;

  return { isRepoRoot, repositories, existing, alreadyRegistered };
}

/**
 * root 直下の git リポジトリのルートを名前順に返す。`.` で始まるディレクトリは見ない。
 * シンボリックリンクも辿る（realPath で束ねたい先を確かめる）。
 */
async function listSubRepositories(
  root: string,
): Promise<{ dir: string; suggestedName: string }[]> {
  const found: { name: string; dir: string; suggestedName: string }[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory) continue;
    const real = await Deno.realPath(dir);
    if (await gitTopLevel(dir) === real) {
      found.push({ name: entry.name, dir: real, suggestedName: projectNameFrom(entry.name) });
    }
  }
  found.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return found.map(({ dir, suggestedName }) => ({ dir, suggestedName }));
}
