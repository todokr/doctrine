import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type CommandStep, parseWorkflow } from "../../src/workflow/schema.ts";
import { expand, type TemplateContext } from "../../src/workflow/template.ts";

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

type Outcome = { code: number; args: string[]; body: string | null };

/** git を何もしないものに、gh を引数と標準入力を記録するものに差し替えて open-pr を実行する。 */
async function runOpenPr(
  issue: TemplateContext["issue"],
  prExists = false,
): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), "doctrine-open-pr-"));
  try {
    await mkdir(join(dir, ".doctrine-out"));
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, ".doctrine-out", "implement-notes.md"), NOTES);
    await writeFile(join(dir, "bin", "git"), "#!/bin/sh\nexit 0\n");
    const gh = prExists
      ? `#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then echo https://github.com/o/r/pull/9; exit 0; fi\ncat > "$GH_BODY"\n`
      : `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then exit 1; fi
for a in "$@"; do printf '%s\\n' "$a"; done > "$GH_ARGS"
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
    const exists = await stat(bodyPath).then(() => true, () => false);
    return {
      code,
      args: exists && !prExists ? (await readFile(argsPath, "utf8")).split("\n") : [],
      body: exists ? await readFile(bodyPath, "utf8") : null,
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
