import {
  type Artifact,
  canonicalJson,
  type Pfd,
  type Process,
} from "../../../../shared/intake/pfd.ts";

export type PfdRule =
  | "duplicate_artifact"
  | "duplicate_process"
  | "no_input"
  | "no_output"
  | "undefined_artifact"
  | "multiple_producers"
  | "given_has_producer"
  | "no_producer"
  | "unused_artifact"
  | "no_verify"
  | "missing_definition"
  | "cycle"
  | "goal_unreachable"
  | "decision_not_given"
  | "unknown_decision"
  | "frozen_changed";

export type Violation = { rule: PfdRule; id: string; message: string };

/** 改訂で変えてはならない部分（spec 6 章「改訂の固定」）。 */
export type FrozenPart = { artifacts: Artifact[]; processes: Process[] };

export type ValidateContext = {
  /** 答えのある質問の id。decision はこの中を指さなければならない。 */
  answeredQuestionIds: ReadonlySet<string>;
  /** 改訂でないときは null。 */
  frozen: FrozenPart | null;
};

/**
 * 承認済みの案から、固定するプロセスと、その入出力に出てくる成果物を集める。
 * frozenProcessIds に案に無い id があっても無視する。
 */
export function frozenPart(approved: Pfd, frozenProcessIds: ReadonlySet<string>): FrozenPart {
  const processes = approved.processes.filter((p) => frozenProcessIds.has(p.id));
  const used = new Set(processes.flatMap((p) => [...p.inputs, ...p.outputs]));
  return { processes, artifacts: approved.artifacts.filter((a) => used.has(a.id)) };
}

export function validatePfd(pfd: Pfd, ctx: ValidateContext): Violation[] {
  const out: Violation[] = [];
  const add = (rule: PfdRule, id: string, message: string) => out.push({ rule, id, message });

  const artifactIds = new Set<string>();
  for (const a of pfd.artifacts) {
    if (artifactIds.has(a.id)) {
      add("duplicate_artifact", a.id, `成果物の id が重複しています: ${a.id}`);
    }
    artifactIds.add(a.id);
  }
  const processIds = new Set<string>();
  for (const p of pfd.processes) {
    if (processIds.has(p.id)) {
      add("duplicate_process", p.id, `プロセスの id が重複しています: ${p.id}`);
    }
    processIds.add(p.id);
  }

  const producers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) =>
    m.set(k, [...(m.get(k) ?? []), v]);

  for (const p of pfd.processes) {
    if (p.inputs.length === 0) add("no_input", p.id, `プロセス ${p.id} に入力の成果物がありません`);
    if (p.outputs.length === 0) {
      add("no_output", p.id, `プロセス ${p.id} に出力の成果物がありません`);
    }
    for (const ref of [...p.inputs, ...p.outputs]) {
      if (!artifactIds.has(ref)) {
        add(
          "undefined_artifact",
          ref,
          `プロセス ${p.id} が、定義されていない成果物 ${ref} を参照しています`,
        );
      }
    }
    for (const ref of p.inputs) push(consumers, ref, p.id);
    for (const ref of p.outputs) push(producers, ref, p.id);
  }
  for (const g of pfd.goal) {
    if (!artifactIds.has(g)) {
      add("undefined_artifact", g, `goal が、定義されていない成果物 ${g} を指しています`);
    }
  }

  for (const a of pfd.artifacts) {
    const by = producers.get(a.id) ?? [];
    if (by.length > 1) {
      add(
        "multiple_producers",
        a.id,
        `成果物 ${a.id} を複数のプロセスが出力しています: ${by.join(", ")}`,
      );
    }
    if (a.given && by.length > 0) {
      add(
        "given_has_producer",
        a.id,
        `成果物 ${a.id} は given なのに、プロセス ${by.join(", ")} が出力しています`,
      );
    }
    if (!a.given && by.length === 0) {
      add(
        "no_producer",
        a.id,
        `成果物 ${a.id} を出力するプロセスがありません（最初からあるものなら given: true）`,
      );
    }
    if (!pfd.goal.includes(a.id) && (consumers.get(a.id) ?? []).length === 0) {
      add("unused_artifact", a.id, `成果物 ${a.id} は、どのプロセスの入力にもなっていません`);
    }
    if (!a.given && !a.verify) {
      add("no_verify", a.id, `成果物 ${a.id} に verify（確かめ方）がありません`);
    }
  }

  for (const p of pfd.processes) {
    if (p.actor !== "agent") continue;
    const missing = (["purpose", "steps", "done_when"] as const).filter((k) => !p[k]);
    if (missing.length > 0) {
      add("missing_definition", p.id, `プロセス ${p.id} に ${missing.join(", ")} がありません`);
    }
  }

  // プロセス A の出力をプロセス B が入力に取るとき、A → B の辺を張る
  const next = new Map<string, string[]>();
  for (const p of pfd.processes) {
    next.set(p.id, p.outputs.flatMap((o) => consumers.get(o) ?? []));
  }
  const color = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    if (color.get(id) === "visiting") return true;
    if (color.get(id) === "done") return false;
    color.set(id, "visiting");
    const found = (next.get(id) ?? []).some(visit);
    color.set(id, "done");
    return found;
  };
  for (const p of pfd.processes) {
    if (color.has(p.id)) continue;
    if (visit(p.id)) add("cycle", p.id, `プロセス ${p.id} を含む循環があります`);
  }

  // given から始めて、入力がすべて手に入るプロセスの出力を足していく
  const available = new Set(pfd.artifacts.filter((a) => a.given).map((a) => a.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pfd.processes) {
      if (p.inputs.length === 0 || !p.inputs.every((i) => available.has(i))) continue;
      for (const o of p.outputs) {
        if (!available.has(o)) {
          available.add(o);
          grew = true;
        }
      }
    }
  }
  for (const g of pfd.goal) {
    if (artifactIds.has(g) && !available.has(g)) {
      add("goal_unreachable", g, `goal の成果物 ${g} に、given の成果物から辿り着けません`);
    }
  }

  for (const a of pfd.artifacts) {
    if (a.decision === undefined) continue;
    if (!a.given) {
      add(
        "decision_not_given",
        a.id,
        `成果物 ${a.id} は decision（質問 ${a.decision} の回答）を持つので given: true でなければなりません`,
      );
    }
    if (!ctx.answeredQuestionIds.has(a.decision)) {
      add(
        "unknown_decision",
        a.id,
        `成果物 ${a.id} の decision が、答えのある質問を指していません: ${a.decision}`,
      );
    }
  }

  if (ctx.frozen) {
    const sameProcess = new Map(pfd.processes.map((p) => [p.id, canonicalJson(p)]));
    for (const p of ctx.frozen.processes) {
      if (sameProcess.get(p.id) !== canonicalJson(p)) {
        add("frozen_changed", p.id, `プロセス ${p.id} は投入済みか完了済みなので変えられません`);
      }
    }
    const sameArtifact = new Map(pfd.artifacts.map((a) => [a.id, canonicalJson(a)]));
    for (const a of ctx.frozen.artifacts) {
      if (sameArtifact.get(a.id) !== canonicalJson(a)) {
        add(
          "frozen_changed",
          a.id,
          `成果物 ${a.id} は固定されたプロセスの入出力なので変えられません`,
        );
      }
    }
  }

  return out;
}
