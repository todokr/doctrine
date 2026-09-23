// 状態の色（トーン）の対応表。画面の状態の色はここからだけ引く（spec 2 章）
import type { IntakeState } from "../../shared/intake/state.ts";
import type { IntakeSummary } from "../../shared/protocol.ts";
import type { IntakeSection } from "./intake";
import type { Group } from "./model";
import type { PfdLook } from "./pfd";
import type { RailStatus } from "./rail";
import type { Task, TaskState } from "./types";

export type Tone = "ok" | "run" | "danger" | "human" | "idle";

export const toneClass = (tone: Tone) => `tone-${tone}`;

export const TASK_TONE: Record<TaskState, Tone> = {
  suspended: "human",
  running: "run",
  queued: "idle",
  paused: "idle",
  rate_limited: "idle",
  waiting: "idle",
  failed: "danger",
  completed: "ok",
  canceled: "idle",
  unknown: "danger",
};

/** interrupted はデーモンの再起動で閉じた実行で、ステップの失敗ではないので idle */
export const RUN_TONE: Record<RailStatus, Tone> = {
  running: "run",
  awaiting: "human",
  success: "ok",
  failed: "danger",
  bounced: "danger",
  interrupted: "idle",
  rate_limited: "idle",
  waiting: "idle",
  pending: "idle",
};

export const INTAKE_TONE: Record<IntakeState, Tone> = {
  investigating: "run",
  decomposing: "run",
  answering: "human",
  reviewing: "human",
  needs_attention: "danger",
  active: "run",
  completed: "ok",
  canceled: "idle",
};

/** pr_open はマージを人が決めるので human */
export const PROCESS_TONE: Record<PfdLook, { tone: Tone; dashed: boolean }> = {
  waiting: { tone: "idle", dashed: true },
  ready: { tone: "run", dashed: true },
  running: { tone: "run", dashed: false },
  pr_open: { tone: "human", dashed: false },
  merged: { tone: "ok", dashed: false },
  your_turn: { tone: "human", dashed: false },
  done: { tone: "ok", dashed: false },
  needs_attention: { tone: "danger", dashed: false },
};

/** 要確認の区分には削除を拒否した completed も入るので、状態ではなく区分から引く */
export function groupTone(g: Group, t: Task): Tone {
  switch (g) {
    case "review": return "human";
    case "check": return "danger";
    case "running": return "run";
    case "limited":
    case "waiting":
    case "queued":
    case "paused": return "idle";
    case "done": return t.state === "completed" ? "ok" : "idle";
  }
}

export function sectionTone(s: IntakeSection, i: IntakeSummary): Tone {
  switch (s) {
    case "attention": return i.state === "needs_attention" ? "danger" : "human";
    case "working": return "run";
    case "active": return "idle";
    case "closed": return i.state === "completed" ? "ok" : "idle";
  }
}
