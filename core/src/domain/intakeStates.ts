import type { IntakeRunPurpose, IntakeState } from "../db/intakes.ts";

/**
 * 2026-09-21-intake-core-design.md 5 章の遷移表のうち、`revising` に関係しない辺。
 * 各行の上に、辺を引き起こす出来事を書く。
 */
const INTAKE_TRANSITIONS: Record<IntakeState, readonly IntakeState[]> = {
  /**
   * answering: 調査の実行が質問を返した。decomposing: 調査の実行が空の質問を返した。
   * needs_attention: エージェントの失敗・検証落ち 3 回・書き換えの検出。canceled: intake.cancel。
   */
  investigating: ["answering", "decomposing", "needs_attention", "canceled"],
  /** decomposing: intake.answer。 */
  answering: ["decomposing", "canceled"],
  /**
   * answering: 分解の実行が質問を返した。reviewing: 検証を通った案を保存した。
   * needs_attention: investigating と同じ。
   */
  decomposing: ["answering", "reviewing", "needs_attention", "canceled"],
  /** decomposing: intake.reject。active: intake.approve。 */
  reviewing: ["decomposing", "active", "canceled"],
  /**
   * decomposing: intake.revise（revising を立てる）。completed: goal の成果物が揃った。
   * needs_attention へは移らない。進行中の失敗は Intake の状態を変えず、見張りのエラーと
   * プロセスの状態で見せる（1 つのプロセスの失敗で他のプロセスの投入まで止めないため）。
   */
  active: ["decomposing", "completed", "canceled"],
  /**
   * investigating: intake.retry で、失敗した実行の purpose が investigate のとき。
   * PRD 8 章の図に無く spec が足した辺で、調査で落ちたものを decomposing で再開すると
   * 質問を一度も出さないまま分解に入ってしまうために要る。
   * decomposing: intake.retry で、失敗した実行の purpose が decompose / revise のとき。
   */
  needs_attention: ["investigating", "decomposing", "canceled"],
  completed: [],
  canceled: [],
};

/**
 * `revising` のときだけ active へ移れる状態。intake.abandonRevision（C-5）で、承認済みの計画に戻る。
 * 改訂中でなければ、これらの状態には承認済みの計画が無いので active へ移る理由が無い。
 * reviewing → active は承認の辺として表にあるので、ここには含めない。
 */
const REVISION_EXITS: readonly IntakeState[] = ["answering", "decomposing", "needs_attention"];

export class InvalidIntakeTransitionError extends Error {
  constructor(from: IntakeState, to: IntakeState, revising: boolean) {
    super(`不正な状態遷移です: ${from} -> ${to}${revising ? "（改訂中）" : ""}`);
    this.name = "InvalidIntakeTransitionError";
  }
}

export function canIntakeTransition(
  from: IntakeState,
  to: IntakeState,
  revising: boolean,
): boolean {
  if (INTAKE_TRANSITIONS[from].includes(to)) return true;
  return revising && to === "active" && REVISION_EXITS.includes(from);
}

export function assertIntakeTransition(
  from: IntakeState,
  to: IntakeState,
  revising: boolean,
): void {
  if (!canIntakeTransition(from, to, revising)) {
    throw new InvalidIntakeTransitionError(from, to, revising);
  }
}

export function isIntakeTerminal(s: IntakeState): boolean {
  return s === "completed" || s === "canceled";
}

/** intake.retry のやり直し先。失敗した実行の purpose で決まる。 */
export function retryStateFor(purpose: IntakeRunPurpose): "investigating" | "decomposing" {
  return purpose === "investigate" ? "investigating" : "decomposing";
}
