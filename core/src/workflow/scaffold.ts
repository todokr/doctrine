import { join } from "@std/path";
import { runCommand } from "../util/exec.ts";
import { parseProjectConfig } from "./project.ts";

/** project-add が雛形を作るときのワークフロー名 */
export const DEFAULT_WORKFLOW_NAME = "default";

/**
 * project-add は最初に叩くコマンドなので、足りない `.doctrine/` の雛形をここで作る。
 *
 * - 既存のファイルは決して上書きしない。ユーザーが書いた設定を黙って消さないため
 * - project.yaml が既にあるなら、それが指すワークフローを勝手に作らない。
 *   無ければ分かる形で失敗させる（ユーザーが書いていない手順を実行させない）
 * - git リポジトリのルートでなければ何も作らない。doctrine はタスクごとに
 *   git worktree を切るので、関係ないディレクトリに .doctrine をばら撒かない
 *
 * 作ったファイルのパスを返す。ユーザーのリポジトリに未追跡ファイルが増えるので、
 * 呼び出し側はそれを伝えること。コミットはしない — 何をコミットするかはユーザーが決める。
 */
export async function ensureProjectScaffold(path: string): Promise<{ created: string[] }> {
  await assertRepoRoot(path);

  const dir = join(path, ".doctrine");
  const projectYaml = join(dir, "project.yaml");
  const created: string[] = [];

  if (await exists(projectYaml)) {
    const cfg = parseProjectConfig(await Deno.readTextFile(projectYaml));
    const workflow = join(dir, "workflows", `${cfg.defaultWorkflow}.yaml`);
    if (!(await exists(workflow))) {
      throw new Error(
        `project.yaml の defaultWorkflow が指すワークフローがありません: ${workflow}` +
          `（.doctrine/workflows/${cfg.defaultWorkflow}.yaml を作成するか、defaultWorkflow を直してください）`,
      );
    }
    return { created };
  }

  await Deno.mkdir(join(dir, "workflows"), { recursive: true });
  const workflowYaml = join(dir, "workflows", `${DEFAULT_WORKFLOW_NAME}.yaml`);
  if (!(await exists(workflowYaml))) {
    await Deno.writeTextFile(workflowYaml, DEFAULT_WORKFLOW_YAML, { createNew: true });
    created.push(workflowYaml);
  }
  await Deno.writeTextFile(projectYaml, projectYamlFor(await detectBaseBranch(path)), {
    createNew: true,
  });
  created.push(projectYaml);
  return { created };
}

async function assertRepoRoot(path: string): Promise<void> {
  let top: string;
  try {
    top = (await runCommand("git", ["-C", path, "rev-parse", "--show-toplevel"])).stdout.trim();
  } catch {
    throw new Error(
      `git リポジトリではありません: ${path}` +
        `（doctrine はタスクごとに git worktree を作るため、git リポジトリのルートを指定してください）`,
    );
  }
  // git はシンボリックリンク解決後の実パスを返すので、こちらも揃えてから比べる
  if (await Deno.realPath(path) !== top) {
    throw new Error(
      `リポジトリのルートを指定してください: ${top}（${path} はそのサブディレクトリです）`,
    );
  }
}

/**
 * main 決め打ちにしない。master / develop を使うリポジトリで最初から間違えないように、
 * リモートの既定ブランチ → 現在のブランチの順に見る。どちらも取れなければ（detached HEAD など）
 * undefined を返し、project.yaml には書かずに既定値へ任せる。
 */
async function detectBaseBranch(root: string): Promise<string | undefined> {
  try {
    const ref =
      (await runCommand("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
        .stdout.trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // origin が無い、または origin/HEAD が設定されていない
  }
  try {
    const current = (await runCommand("git", ["-C", root, "branch", "--show-current"])).stdout
      .trim();
    if (current) return current;
  } catch {
    // 取れなければ既定値に任せる
  }
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** setup は書かない — doctrine はパッケージマネージャを強制しない（spec 3章） */
function projectYamlFor(baseBranch: string | undefined): string {
  const lines = [
    "# doctrine のプロジェクト設定（dctl project-add が雛形として作成）",
    "#",
    "# setup: 新しい worktree で最初に走らせるコマンド。例: pnpm install --frozen-lockfile",
    "#   doctrine はパッケージマネージャを決めないので、必要なら自分で書く。",
    `defaultWorkflow: ${DEFAULT_WORKFLOW_NAME}`,
    "maxConcurrent: 1",
  ];
  if (baseBranch) lines.push(`baseBranch: ${baseBranch}`);
  return lines.join("\n") + "\n";
}

/**
 * agent と approval だけ。テストや lint の command ステップはプロジェクトごとに違ううえ、
 * 再実行しても安全かどうかをここでは判断できないので入れない。approval を残すのは、
 * 人の判断が要るところまで進めて止まる、というのが doctrine の中心の約束だから。
 */
const DEFAULT_WORKFLOW_YAML = `# doctrine の既定ワークフロー（dctl project-add が雛形として作成）
#
# テストや lint などの command ステップは、プロジェクトに合わせて自分で足す。
# command ステップはクラッシュ復帰時に頭から再実行されるので、
# 再実行しても安全なコマンドにすること（pnpm test は安全、gh pr create は危険）。
name: ${DEFAULT_WORKFLOW_NAME}
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    permissionMode: acceptEdits
    # acceptEdits では Bash はすべて拒否される。使わせたいコマンドがあれば個別に許可する。
    # allowedTools:
    #   - "Bash(git diff:*)"
    #   - "Bash(grep:*)"

  - id: review
    type: approval
    title: "変更を確認してください"
`;
