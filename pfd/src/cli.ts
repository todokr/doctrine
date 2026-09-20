import { join, resolve } from "@std/path";
import { dispatch } from "./dispatch.ts";
import { parsePfd, type Pfd } from "./model.ts";
import { type Ports, realPorts } from "./ports.ts";
import { toHtml, toMermaid } from "./render.ts";
import { computeStatus, gatherFacts, type ProcessStatus } from "./status.ts";
import { hashOf, pfdDir, readRecord, writeRecord } from "./store.ts";
import { validatePfd } from "./validate.ts";

export interface Deps {
  ports: Ports;
  out: (line: string) => void;
  err: (line: string) => void;
  isTerminal: () => boolean;
  ask: (question: string) => Promise<string>;
  open: (path: string) => Promise<void>;
  now: () => string;
}

const USAGE = `使い方: pfd <command> <project> <issue> [options]

  path     <project> <issue>              pfd.yaml の場所を表示する（無ければディレクトリを作る）
  validate <project> <issue>              PFD の構造を検証する
  render   <project> <issue> [--no-open]  図を生成してブラウザで開く
  approve  <project> <issue>              PFD を承認する（端末から人が実行する）
  dispatch <project> <issue>              入力が揃った未投入のプロセスを doctrine のタスクにする
  status   <project> <issue>              各プロセスの状態を表示する
  done     <project> <issue> <process-id> (--note <text> | --note-file <path>)
                                          人が行うプロセスを完了にする

<project> は対象リポジトリのルート（dctl project-add に渡したのと同じパス）。`;

const BOOLEAN = new Set(["no-open"]);

function splitArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN.has(key)) {
      flags[key] = true;
      continue;
    }
    i += 1;
    if (argv[i] === undefined) throw new Error(`--${key} には値が要ります`);
    flags[key] = argv[i];
  }
  return { flags, positional };
}

interface Target {
  issue: number;
  projectPath: string;
  dir: string;
  file: string;
}

async function target(project: string | undefined, issueArg: string | undefined): Promise<Target> {
  if (!project || !issueArg) throw new Error(USAGE);
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`issue 番号が正しくありません: ${issueArg}`);
  }
  const projectPath = resolve(project);
  const dir = await pfdDir(projectPath, issue);
  return { issue, projectPath, dir, file: join(dir, "pfd.yaml") };
}

async function load(t: Target): Promise<{ text: string; pfd: Pfd }> {
  let text: string;
  try {
    text = await Deno.readTextFile(t.file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw new Error(`PFD がありません: ${t.file}`);
    throw err;
  }
  const pfd = parsePfd(text);
  if (pfd.issue !== t.issue) {
    throw new Error(
      `pfd.yaml の issue（${pfd.issue}）が、指定された issue（${t.issue}）と違います`,
    );
  }
  return { text, pfd };
}

function describe(s: ProcessStatus): string {
  switch (s.state) {
    case "done":
      return "完了";
    case "your_turn":
      return "あなたの番";
    case "merged":
      return "マージ済み";
    case "pr_open":
      return "PR レビュー待ち";
    case "no_pr":
      return `PR がありません（ブランチ ${s.branch}）`;
    case "task_stopped":
      return `タスクが止まっています（${s.task_id}）`;
    case "lost":
      return `記録にあるタスクが見当たりません（${s.task_id}）`;
    case "running":
      return `実行中（${s.task_id}）`;
    case "ready":
      return "着手可能（pfd dispatch で投入）";
    case "waiting":
      return `入力待ち: ${s.waiting_for.join(", ")}`;
  }
}

/** 違反を err に出し、違反が無ければ true を返す。 */
function reportViolations(pfd: Pfd, deps: Deps): boolean {
  const violations = validatePfd(pfd);
  for (const v of violations) deps.err(`${v.rule}: ${v.message}`);
  return violations.length === 0;
}

async function run(argv: string[], deps: Deps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    throw new Error(USAGE);
  }
  const { flags, positional } = splitArgs(rest);

  switch (cmd) {
    case "path": {
      const t = await target(positional[0], positional[1]);
      await Deno.mkdir(t.dir, { recursive: true });
      deps.out(t.file);
      return 0;
    }

    case "validate": {
      const { pfd } = await load(await target(positional[0], positional[1]));
      if (!reportViolations(pfd, deps)) return 1;
      deps.out("違反はありません");
      return 0;
    }

    case "render": {
      const t = await target(positional[0], positional[1]);
      const { pfd } = await load(t);
      const record = await readRecord(t.dir);
      // 未承認の間はタスクが 1 つも無い。デーモンが起動していなくても図を見られるようにする
      const statuses = record.approved
        ? computeStatus(pfd, record, await gatherFacts(pfd, t.projectPath, deps.ports))
        : undefined;
      const file = join(t.dir, "pfd.html");
      await Deno.writeTextFile(
        file,
        toHtml(`#${pfd.issue} ${pfd.title}`, toMermaid(pfd, statuses)),
      );
      deps.out(file);
      if (!flags["no-open"]) await deps.open(file);
      return 0;
    }

    case "approve": {
      if (!deps.isTerminal()) {
        throw new Error(
          "pfd approve は、人が端末から実行してください（標準入力が端末ではありません）",
        );
      }
      const t = await target(positional[0], positional[1]);
      const { text, pfd } = await load(t);
      if (!reportViolations(pfd, deps)) return 1;
      deps.out(`#${pfd.issue} ${pfd.title}`);
      for (const p of pfd.processes) {
        deps.out(`  ${p.id} ${p.name}（${p.actor === "human" ? "人" : "エージェント"}）`);
      }
      const answer = await deps.ask("この PFD を承認しますか? [y/N] ");
      if (answer.trim().toLowerCase() !== "y") {
        deps.err("承認しませんでした");
        return 1;
      }
      const record = await readRecord(t.dir);
      record.approved = { hash: await hashOf(text), at: deps.now() };
      await writeRecord(t.dir, record);
      deps.out("承認しました");
      return 0;
    }

    case "dispatch": {
      const t = await target(positional[0], positional[1]);
      const { text, pfd } = await load(t);
      const result = await dispatch({
        pfd,
        text,
        dir: t.dir,
        projectPath: t.projectPath,
        ports: deps.ports,
        now: deps.now,
      });
      const nameOf = (id: string) => `${id} ${pfd.processes.find((p) => p.id === id)?.name ?? ""}`;
      for (const a of result.adopted) {
        deps.out(`既にあるタスクを記録しました: ${nameOf(a.process_id)}（${a.task_id}）`);
      }
      for (const c of result.created) {
        deps.out(`投入しました: ${nameOf(c.process_id)}（${c.task_id}）`);
      }
      if (result.created.length === 0 && result.adopted.length === 0) {
        deps.out("投入できるプロセスはありません");
      }
      return 0;
    }

    case "status": {
      const t = await target(positional[0], positional[1]);
      const { pfd } = await load(t);
      const record = await readRecord(t.dir);
      const facts = await gatherFacts(pfd, t.projectPath, deps.ports);
      deps.out(`#${pfd.issue} ${pfd.title}（${record.approved ? "承認済み" : "未承認"}）`);
      for (const s of computeStatus(pfd, record, facts)) {
        deps.out(`  ${s.id} ${s.name}  ${describe(s)}`);
      }
      return 0;
    }

    case "done": {
      const t = await target(positional[0], positional[1]);
      const processId = positional[2];
      if (!processId) throw new Error(USAGE);
      const { pfd } = await load(t);
      const process = pfd.processes.find((p) => p.id === processId);
      if (!process) throw new Error(`プロセス ${processId} は、この PFD にありません`);
      if (process.actor !== "human") {
        throw new Error(
          `プロセス ${processId} は actor: human ではありません（エージェントのプロセスは PR のマージで完了します）`,
        );
      }
      const note = typeof flags["note-file"] === "string"
        ? (await Deno.readTextFile(flags["note-file"])).trim()
        : typeof flags["note"] === "string"
        ? flags["note"].trim()
        : "";
      if (!note) {
        throw new Error(
          "--note <テキスト> または --note-file <パス> で、決めた内容を渡してください",
        );
      }
      const record = await readRecord(t.dir);
      record.done[processId] = { note, at: deps.now() };
      await writeRecord(t.dir, record);
      deps.out(`完了にしました: ${process.id} ${process.name}`);
      return 0;
    }

    default:
      throw new Error(`未知のコマンドです: ${cmd}\n\n${USAGE}`);
  }
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (e) {
    deps.err((e as Error).message);
    return 1;
  }
}

async function openInBrowser(path: string): Promise<void> {
  const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
  await new Deno.Command(cmd, { args: [path], stdin: "null", stdout: "null", stderr: "null" })
    .output();
}

if (import.meta.main) {
  Deno.exitCode = await main(Deno.args, {
    ports: realPorts(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    isTerminal: () => Deno.stdin.isTerminal(),
    ask: (q) => Promise.resolve(prompt(q) ?? ""),
    open: openInBrowser,
    now: () => new Date().toISOString(),
  });
}
