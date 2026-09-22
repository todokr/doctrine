import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type CommandStep, parseWorkflow, type PollStep } from "../../src/workflow/schema.ts";
import { expand, type TemplateContext } from "../../src/workflow/template.ts";
import process from "node:process";

const exec = promisify(execFile);

const NOTES = "## 今回やったこと\n- x\n";

async function openPrRun(): Promise<string> {
  const yaml = await readFile(
    new URL("../../../.doctrine/workflows/default.yaml", import.meta.url),
    "utf8",
  );
  const step = parseWorkflow(yaml).workflow.steps.find((s) => s.id === "open-pr");
  assert.ok(step && step.type === "command", "open-pr は command ステップ");
  return (step as CommandStep).run;
}

type Outcome = { code: number; args: string[]; body: string | null; syncNotesLeft: boolean };

/** git を何もしないものに、gh を引数と標準入力を記録するものに差し替えて open-pr を実行する。 */
async function runOpenPr(
  issue: TemplateContext["issue"],
  prExists = false,
  syncNotes?: string,
): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), "doctrine-open-pr-"));
  try {
    await mkdir(join(dir, ".doctrine-out"));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, ".doctrine-out", "implement-notes.md"), NOTES);
    if (syncNotes !== undefined) {
      await writeFile(join(dir, ".doctrine-out", "sync-notes.md"), syncNotes);
    }
    await writeFile(join(dir, "bin", "git"), "#!/bin/sh\nexit 0\n");
    // gh は open-pr の中で複数回呼ばれることがある（PR 作成 → sync-notes.md のコメント）。
    // 呼び出しごとに上書きすると先の呼び出しの引数が消えるので、区切り線を挟んで追記する。
    const gh = prExists
      ? `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then echo https://github.com/o/r/pull/9; exit 0; fi
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo "---"; } >> "$GH_ARGS"
if [ "$1 $2" = "pr comment" ]; then exit 0; fi
cat > "$GH_BODY"
`
      : `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then exit 1; fi
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo "---"; } >> "$GH_ARGS"
if [ "$1 $2" = "pr comment" ]; then exit 0; fi
cat > "$GH_BODY"
`;
    await writeFile(join(dir, "bin", "gh"), gh);
    await chmod(join(dir, "bin", "git"), 0o755);
    await chmod(join(dir, "bin", "gh"), 0o755);

    const ctx: TemplateContext = {
      task: { id: "t", title: "タイトル", prompt: "P", branch: "b" },
      issue,
      worktree: { path: dir },
      project: { path: dir },
      steps: {},
    };
    const command = expand(await openPrRun(), ctx);
    const argsPath = join(dir, "gh-args");
    const bodyPath = join(dir, "gh-body");
    let code = 0;
    try {
      await exec("sh", ["-c", command], {
        cwd: dir,
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          GH_ARGS: argsPath,
          GH_BODY: bodyPath,
        },
      });
    } catch (e) {
      code = (e as { code: number }).code;
    }
    const argsExists = await stat(argsPath).then(() => true, () => false);
    const bodyExists = await stat(bodyPath).then(() => true, () => false);
    const syncNotesLeft = await stat(join(dir, ".doctrine-out", "sync-notes.md")).then(
      () => true,
      () => false,
    );
    return {
      code,
      args: argsExists ? (await readFile(argsPath, "utf8")).split("\n") : [],
      body: bodyExists ? await readFile(bodyPath, "utf8") : null,
      syncNotesLeft,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("紐づけの無いタスクでは open-pr の PR 本文が implement-notes.md のままになる", async () => {
  const r = await runOpenPr({ url: null, parent_url: null });
  assert.equal(r.code, 0);
  assert.equal(r.body, NOTES);
  for (const a of ["--base", "develop", "--title", "タイトル", "--body-file", "-"]) {
    assert.ok(r.args.includes(a), `gh pr create の引数に ${a} がある`);
  }
});

test("Intake 由来のタスクでは open-pr の PR 本文の末尾で sub-issue を閉じる", async () => {
  const r = await runOpenPr({
    url: "https://github.com/o/r/issues/2",
    parent_url: "https://github.com/o/r/issues/1",
  });
  assert.equal(r.code, 0);
  assert.equal(r.body, `${NOTES}\nCloses https://github.com/o/r/issues/2\n`);
});

test("PR が既にあれば open-pr は作り直さない", async () => {
  const r = await runOpenPr({
    url: "https://github.com/o/r/issues/2",
    parent_url: "https://github.com/o/r/issues/1",
  }, true);
  assert.equal(r.code, 0);
  assert.equal(r.body, null);
});

test("open-pr: sync の記録があれば PR にコメントし、ファイルを消す", async () => {
  const r = await runOpenPr({ url: null, parent_url: null }, true, "## develop を取り込んだ\n- a.ts\n");
  assert.equal(r.code, 0);
  assert.match(r.args.join(" "), /pr comment --body-file/);
  assert.equal(r.syncNotesLeft, false);
});

test("open-pr: sync の記録が無ければコメントしない", async () => {
  const r = await runOpenPr({ url: null, parent_url: null }, true);
  assert.equal(r.args.some((a) => a === "comment"), false);
});

test("open-pr: PR がまだ無く sync の記録があれば、PR を作ってからコメントし、ファイルを消す", async () => {
  const r = await runOpenPr({ url: null, parent_url: null }, false, "## develop を取り込んだ\n- a.ts\n");
  assert.equal(r.code, 0);
  assert.match(r.args.join(" "), /pr create/);
  assert.match(r.args.join(" "), /pr comment --body-file/);
  assert.equal(r.body, NOTES);
  assert.equal(r.syncNotesLeft, false);
});

async function waitMergeRun(): Promise<string> {
  const yaml = await readFile(
    new URL("../../../.doctrine/workflows/default.yaml", import.meta.url),
    "utf8",
  );
  const step = parseWorkflow(yaml).workflow.steps.find((s) => s.id === "wait-merge");
  assert.ok(step && step.type === "poll", "wait-merge は poll ステップ");
  return (step as PollStep).run;
}

/** 偽の gh スクリプト（本文）を使って wait-merge を実行する。 */
async function runWaitMergeWithGh(ghScript: string): Promise<{ code: number; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), "doctrine-wait-merge-"));
  try {
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "gh"), ghScript);
    await chmod(join(dir, "bin", "gh"), 0o755);
    const ctx: TemplateContext = {
      task: { id: "t", title: "T", prompt: "P", branch: "b" },
      issue: { url: null, parent_url: null },
      worktree: { path: dir },
      project: { path: dir },
      steps: {},
    };
    try {
      const { stdout } = await exec("sh", ["-c", expand(await waitMergeRun(), ctx)], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { code: number; stdout: string };
      return { code: err.code, stdout: err.stdout };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** gh pr view の --jq の結果として `state mergeable` を返す偽の gh で wait-merge を実行する。 */
function runWaitMerge(stateAndMergeable: string): Promise<{ code: number; stdout: string }> {
  return runWaitMergeWithGh(`#!/bin/sh\necho '${stateAndMergeable}'\n`);
}

test("wait-merge: マージされたら 0", async () => {
  assert.equal((await runWaitMerge("MERGED UNKNOWN")).code, 0);
});

test("wait-merge: conflict なら 1 で理由を出す", async () => {
  const r = await runWaitMerge("OPEN CONFLICTING");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /conflict/);
});

test("wait-merge: 閉じられたら 2", async () => {
  assert.equal((await runWaitMerge("CLOSED MERGEABLE")).code, 2);
});

test("wait-merge: マージ可能・判定中はまだ（75）", async () => {
  assert.equal((await runWaitMerge("OPEN MERGEABLE")).code, 75);
  assert.equal((await runWaitMerge("OPEN UNKNOWN")).code, 75);
});

test("wait-merge: gh 自体が失敗したら、まだ（75）にせず onFailure へ行く（1）", async () => {
  const r = await runWaitMergeWithGh("#!/bin/sh\nexit 1\n");
  assert.equal(r.code, 1);
});
