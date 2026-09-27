import { basename, isAbsolute, join } from "@std/path";
import type { Db, ProjectRow } from "../db/schema.ts";
import { getProjectByPath, insertProject } from "../db/tasks.ts";
import {
  getWorkspace,
  getWorkspaceByPath,
  insertWorkspace,
  listProjectsOf,
} from "../db/workspaces.ts";
import { parseProjectConfig, type ProjectConfig, type TrackerConfig } from "../workflow/project.ts";
import {
  ensureProjectScaffold,
  ensureWorkspaceScaffold,
  requireNotSubdirectory,
} from "../workflow/scaffold.ts";
import {
  parseWorkspaceConfig,
  WORKSPACE_YAML,
  type WorkspaceConfig,
} from "../workflow/workspace.ts";
import type { WorkspaceSummary } from "../../../shared/protocol.ts";

type ResolvedProject = { name: string; path: string };

/** 動いているタスクの状態。これがあるプロジェクトは workspace から外せない。 */
const ACTIVE_TASK_STATES = ["queued", "running", "suspended", "paused", "rate_limited", "waiting"];

export async function addWorkspace(
  db: Db,
  rootPath: string,
  init?: { projects: Record<string, string>; tracker?: TrackerConfig },
): Promise<{ workspaceId: number; created: string[]; alreadyRegistered: boolean }> {
  const root = await resolveRoot(rootPath);
  const existing = await getWorkspaceByPath(db, root);
  if (existing) return { workspaceId: existing.id, created: [], alreadyRegistered: true };

  const scaffold = await ensureWorkspaceScaffold(root, init);
  const created = scaffold.created;
  const yamlPath = join(root, WORKSPACE_YAML);

  let cfg: WorkspaceConfig;
  let projects: ResolvedProject[];
  let claims: Map<string, ProjectRow>;
  try {
    // init から書いた workspace.yaml の名前・パスが不正（名前の形が違う、指す先が無い、
    // git リポジトリでないなど）なら、書いたファイルを残さない。既にあった workspace.yaml は
    // ここで消さない（scaffold.created に入らない）。DB の衝突（checkClaim）もファイルを
    // 書く前の検証なので、ここに含める。resolveProjects が全 projects を検証してから
    // 下の ensureProjectScaffold のループに入るので、1件でも不正なら1件もスキャフォルドしない。
    cfg = await readConfig(root);
    projects = await resolveProjects(root, cfg);
    claims = new Map<string, ProjectRow>();
    for (const p of projects) {
      const claimed = await checkClaim(db, null, p);
      if (claimed) claims.set(p.path, claimed);
    }
  } catch (e) {
    if (scaffold.created.includes(yamlPath)) await Deno.remove(yamlPath);
    throw e;
  }

  const configs = new Map<string, ProjectConfig>();
  for (const p of projects) {
    created.push(...(await ensureProjectScaffold(p.path)).created);
    configs.set(p.path, await readProjectConfig(p.path));
  }

  const workspaceId = await db.transaction().execute(async (trx) => {
    const id = await insertWorkspace(trx, { path: root, name: cfg.name });
    for (const p of projects) {
      await placeProject(trx, id, p, configs.get(p.path)!, claims.get(p.path) ?? null);
    }
    return id;
  });
  return { workspaceId, created, alreadyRegistered: false };
}

export async function updateWorkspace(db: Db, rootPath: string): Promise<{ workspaceId: number }> {
  const root = await resolveRoot(rootPath);
  const workspace = await getWorkspaceByPath(db, root);
  if (!workspace) throw new Error(`未登録の workspace です: ${root}`);

  const cfg = await readConfig(root);
  const projects = await resolveProjects(root, cfg);
  const current = await listProjectsOf(db, workspace.id);

  const currentByPath = new Map(current.map((r) => [r.path, r]));
  const wantedPaths = new Set(projects.map((p) => p.path));
  const adding = projects.filter((p) => !currentByPath.has(p.path));
  const keeping = projects.filter((p) => currentByPath.has(p.path));
  const removing = current.filter((r) => !wantedPaths.has(r.path));

  const claims = new Map<string, ProjectRow>();
  for (const p of adding) {
    const claimed = await checkClaim(db, workspace.id, p);
    if (claimed) claims.set(p.path, claimed);
  }
  for (const r of removing) await checkRemovable(db, r);

  const configs = new Map<string, ProjectConfig>();
  for (const p of adding) await ensureProjectScaffold(p.path);
  for (const p of [...adding, ...keeping]) configs.set(p.path, await readProjectConfig(p.path));

  await db.transaction().execute(async (trx) => {
    await trx.updateTable("workspaces").set({ name: cfg.name }).where("id", "=", workspace.id)
      .execute();
    // UNIQUE(workspace_id, name): 外す → 残す → 足す の順なら、外した名前を別のプロジェクトが使える
    for (const r of removing) await trx.deleteFrom("projects").where("id", "=", r.id).execute();
    for (const p of keeping) {
      const row = currentByPath.get(p.path)!;
      await trx.updateTable("projects").set({ name: p.name }).where("id", "=", row.id).execute();
      await syncProjectRow(trx, row.id, configs.get(p.path)!);
    }
    for (const p of adding) {
      await placeProject(trx, workspace.id, p, configs.get(p.path)!, claims.get(p.path) ?? null);
    }
  });
  return { workspaceId: workspace.id };
}

export async function toWorkspaceSummary(db: Db, workspaceId: number): Promise<WorkspaceSummary> {
  const w = await getWorkspace(db, workspaceId);
  if (!w) throw new Error(`workspace がありません: ${workspaceId}`);
  return { id: w.id, path: w.path, name: w.name, projects: await listProjectsOf(db, w.id) };
}

/** project.yaml から読んだ設定を projects の行へ写す。 */
export async function syncProjectRow(
  db: Db,
  projectId: number,
  cfg: ProjectConfig,
): Promise<void> {
  await db.updateTable("projects")
    .set({
      default_workflow: cfg.defaultWorkflow,
      max_concurrent: cfg.maxConcurrent,
      base_branch: cfg.baseBranch,
      setup: cfg.setup ?? null,
    })
    .where("id", "=", projectId)
    .execute();
}

/** 相対パス・末尾の /・シンボリックリンク・/var と /private/var の違いは、ここで実パスに揃う。 */
export async function resolveRoot(rootPath: string): Promise<string> {
  // デーモンの cwd で解決されて黙って別の場所を指すのを防ぐ
  if (!isAbsolute(rootPath)) throw new Error(`絶対パスを指定してください: ${rootPath}`);
  try {
    return await Deno.realPath(rootPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw new Error(`パスがありません: ${rootPath}`);
    throw e;
  }
}

async function readConfig(root: string): Promise<WorkspaceConfig> {
  const yamlPath = join(root, WORKSPACE_YAML);
  let text: string;
  try {
    text = await Deno.readTextFile(yamlPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`workspace.yaml がありません: ${yamlPath}`);
    }
    throw e;
  }
  return parseWorkspaceConfig(text, basename(root));
}

/**
 * projects の各エントリを実パスに解決し、git リポジトリのルートであることまで確かめる。
 * ここで全件を検証してから呼び出し側が ensureProjectScaffold に進むので、1件でも
 * 不正なら（存在しない・リポジトリでない・重複）1件もスキャフォルドしない。
 */
async function resolveProjects(root: string, cfg: WorkspaceConfig): Promise<ResolvedProject[]> {
  const resolved: ResolvedProject[] = [];
  const seen = new Map<string, string>();
  for (const entry of cfg.projects) {
    const abs = join(root, entry.path);
    let real: string;
    try {
      real = await Deno.realPath(abs);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error(`projects の ${entry.name} が指すパスがありません: ${abs}`);
      }
      throw e;
    }
    // parseWorkspaceConfig は文字列で比べるので、シンボリックリンク経由の重複はここで拾う
    const other = seen.get(real);
    if (other !== undefined) {
      throw new Error(
        `projects の ${other} と ${entry.name} が同じリポジトリ ${real} を指しています`,
      );
    }
    // ensureProjectScaffold（assertRepoRoot）が同じことを確かめるが、それは1件ずつ
    // スキャフォルドしながら呼ぶので手遅れ。ここで先に全件を確かめる。
    if (await requireNotSubdirectory(real) === null) {
      throw new Error(`projects の ${entry.name} が指すパスは git リポジトリではありません: ${real}`);
    }
    seen.set(real, entry.name);
    resolved.push({ name: entry.name, path: real });
  }
  return resolved;
}

/**
 * 足すプロジェクトが既に別の workspace にあるとき、吸収してよければその行を返す。
 * 吸収してよいのは、その workspace がそのプロジェクト 1 つだけで、終わっていない
 * （completed・canceled 以外の）Intake を持たないとき。
 */
async function checkClaim(
  db: Db,
  workspaceId: number | null,
  p: ResolvedProject,
): Promise<ProjectRow | null> {
  const row = await getProjectByPath(db, p.path);
  if (!row || row.workspace_id === workspaceId) return null;

  const siblings = await listProjectsOf(db, row.workspace_id);
  const openIntake = await db.selectFrom("intakes").select("id")
    .where("workspace_id", "=", row.workspace_id)
    .where("state", "not in", ["completed", "canceled"])
    .limit(1).executeTakeFirst();
  if (siblings.length === 1 && !openIntake) return row;

  const other = await getWorkspace(db, row.workspace_id);
  throw new Error(
    `このリポジトリは workspace ${other?.name}（${other?.path}）に登録済みです: ${row.path}`,
  );
}

/** projects.retired_at を足すまでは、タスクの記録があるプロジェクトを消せない（外部キー）。 */
async function checkRemovable(db: Db, project: ProjectRow): Promise<void> {
  const active = await db.selectFrom("tasks").select("id")
    .where("project_id", "=", project.id)
    .where("state", "in", ACTIVE_TASK_STATES as never[])
    .limit(1).executeTakeFirst();
  if (active) throw new Error(`${project.name} には動いているタスクがあるので外せません`);

  const task = await db.selectFrom("tasks").select("id").where("project_id", "=", project.id)
    .limit(1).executeTakeFirst();
  if (task) throw new Error(`${project.name} にはタスクの記録があるので外せません`);
}

/** 吸収する行があれば、プロジェクトと Intake を付け替えて元の workspace を消し、無ければ INSERT する。 */
async function placeProject(
  trx: Db,
  workspaceId: number,
  p: ResolvedProject,
  cfg: ProjectConfig,
  claimed: ProjectRow | null,
): Promise<void> {
  if (claimed) {
    await trx.updateTable("projects").set({ workspace_id: workspaceId, name: p.name })
      .where("id", "=", claimed.id).execute();
    await syncProjectRow(trx, claimed.id, cfg);
    await trx.updateTable("intakes").set({ workspace_id: workspaceId })
      .where("workspace_id", "=", claimed.workspace_id).execute();
    await trx.deleteFrom("workspaces").where("id", "=", claimed.workspace_id).execute();
    return;
  }
  await insertProject(trx, {
    workspace_id: workspaceId,
    name: p.name,
    path: p.path,
    default_workflow: cfg.defaultWorkflow,
    max_concurrent: cfg.maxConcurrent,
    base_branch: cfg.baseBranch,
    setup: cfg.setup ?? null,
  });
}

async function readProjectConfig(path: string): Promise<ProjectConfig> {
  return parseProjectConfig(await Deno.readTextFile(join(path, ".doctrine", "project.yaml")));
}
