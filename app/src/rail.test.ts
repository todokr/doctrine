import { describe, expect, it } from "vitest";
import type { StepRun, StepView } from "../../shared/protocol.ts";
import { WORKFLOW_DEFAULT } from "./fixtures";
import { buildDefinitionRail, buildRail } from "./rail";

// .doctrine/workflows/default.yaml と同じ形（9 ステップ・後戻り 4 本）。
// app から core / YAML を読まないので、ここに手書きする。
const cmd = (id: string, branch?: StepView["branch"]): StepView => ({
  id,
  type: "command",
  ...(branch && { branch }),
});
const agent = (id: string, branch?: StepView["branch"]): StepView => ({
  id,
  type: "agent",
  ...(branch && { branch }),
});
const DEFAULT_STEPS: StepView[] = [
  cmd("setup"),
  agent("plan"),
  agent("plan-review"),
  cmd("plan-gate", { goto: "plan", maxAttempts: 3 }),
  agent("implement"),
  cmd("verify", { goto: "implement", maxAttempts: 3 }),
  agent("agent-review"),
  cmd("review-gate", { goto: "implement", maxAttempts: 3 }),
  {
    id: "review",
    type: "approval",
    title: "レビュー",
    branch: { goto: "implement", maxAttempts: 5 },
  },
];

const stepRun = (o: Partial<StepRun> = {}): StepRun => ({
  id: 1,
  step_id: "implement",
  attempt: 1,
  status: "success",
  exit_code: 0,
  started_at: "2026-09-18T00:00:00.000Z",
  ended_at: "2026-09-18T00:01:00.000Z",
  permission_denials: null,
  ...o,
});

const at = (current: string | null) => ({ current_step_id: current });

const nodeOf = (rail: NonNullable<ReturnType<typeof buildRail>>, id: string) =>
  rail.nodes.find((n) => n.id === id)!;
const arcOf = (rail: NonNullable<ReturnType<typeof buildRail>>, from: string) =>
  rail.arcs.find((a) => a.from === from)!;

/**
 * 2 本の戻り矢印が交差するか。区間 [min, max] で 3 通りに分ける。
 * - 離れている（端点だけの共有を含む）: 交差しない
 * - 入れ子（端を共有する場合を含む）: 内側の lane が外側より小さければ交差しない
 * - 部分的に重なる: 交差する
 */
function crosses(a: { fromIndex: number; toIndex: number; lane: number }, b: { fromIndex: number; toIndex: number; lane: number }): boolean {
  const [a0, a1] = [Math.min(a.fromIndex, a.toIndex), Math.max(a.fromIndex, a.toIndex)];
  const [b0, b1] = [Math.min(b.fromIndex, b.toIndex), Math.max(b.fromIndex, b.toIndex)];
  if (a1 <= b0 || b1 <= a0) return false;
  if (b0 >= a0 && b1 <= a1) return b.lane >= a.lane;
  if (a0 >= b0 && a1 <= b1) return a.lane >= b.lane;
  return true;
}

describe("戻り矢印のレーン", () => {
  it("default.yaml と同じ形で、またぐ数の昇順に内側から割り当てられ、交差しない", () => {
    const rail = buildRail(DEFAULT_STEPS, [], at("setup"))!;

    expect(rail.arcs).toHaveLength(4);
    expect(arcOf(rail, "verify")).toMatchObject({ to: "implement", fromIndex: 5, toIndex: 4, lane: 0 });
    expect(arcOf(rail, "plan-gate")).toMatchObject({ to: "plan", fromIndex: 3, toIndex: 1, lane: 1 });
    expect(arcOf(rail, "review-gate")).toMatchObject({ to: "implement", fromIndex: 7, toIndex: 4, lane: 2 });
    expect(arcOf(rail, "review")).toMatchObject({ to: "implement", fromIndex: 8, toIndex: 4, lane: 3 });

    for (let i = 0; i < rail.arcs.length; i++) {
      for (let j = i + 1; j < rail.arcs.length; j++) {
        expect(crosses(rail.arcs[i], rail.arcs[j]), `${rail.arcs[i].from} と ${rail.arcs[j].from}`)
          .toBe(false);
      }
    }
  });

  it("またぐ数が同じなら fromIndex の昇順で内側に置く", () => {
    const steps = [cmd("a"), cmd("b", { goto: "a", maxAttempts: 2 }), cmd("c", { goto: "b", maxAttempts: 2 })];
    const rail = buildRail(steps, [], at(null))!;
    expect(arcOf(rail, "b").lane).toBe(0);
    expect(arcOf(rail, "c").lane).toBe(1);
  });

  it("goto 先が steps に無い矢印は作らない", () => {
    const rail = buildRail([cmd("a", { goto: "nowhere", maxAttempts: 2 })], [], at(null))!;
    expect(rail.arcs).toEqual([]);
  });

  it("矢印が無ければレーン分の高さを足さない", () => {
    const flat = buildRail([cmd("a"), cmd("b")], [], at(null))!;
    const withArc = buildRail([cmd("a"), cmd("b", { goto: "a", maxAttempts: 2 })], [], at(null))!;
    expect(withArc.height).toBeGreaterThan(flat.height);
  });

  it("ノードの座標は添字で決まる", () => {
    const rail = buildRail(DEFAULT_STEPS, [], at(null))!;
    const xs = rail.nodes.map((n) => n.x);
    expect(xs[0]).toBe(0);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
    expect(rail.width).toBeGreaterThan(xs[xs.length - 1]);
  });
});

describe("ノードの状態", () => {
  it("status はその step_id の最後の run から取る", () => {
    const rail = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "implement", attempt: 1, status: "bounced" }),
      stepRun({ id: 2, step_id: "implement", attempt: 2, status: "success" }),
    ], at("verify"))!;
    expect(nodeOf(rail, "implement")).toMatchObject({ status: "success", attempt: 2 });
  });

  it("run が 1 件も無いステップは pending で attempt は 0", () => {
    const rail = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "plan" }),
    ], at("plan-review"))!;
    expect(nodeOf(rail, "agent-review")).toMatchObject({ status: "pending", attempt: 0 });
    expect(nodeOf(rail, "review")).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("1 回しか走っていないステップの attempt は 1", () => {
    const rail = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "plan", attempt: 1 }),
    ], at("plan-review"))!;
    expect(nodeOf(rail, "plan").attempt).toBe(1);
  });

  it("現在のステップだけに current が立つ", () => {
    const rail = buildRail(DEFAULT_STEPS, [], at("implement"))!;
    expect(rail.nodes.filter((n) => n.current).map((n) => n.id)).toEqual(["implement"]);
  });

  it("type と approval の title を引き継ぐ", () => {
    const rail = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodeOf(rail, "review")).toMatchObject({ type: "approval", title: "レビュー", unknown: false });
    expect(nodeOf(rail, "plan")).toMatchObject({ type: "agent", unknown: false });
    expect(nodeOf(rail, "plan").title).toBeUndefined();
  });

  it("戻り矢印の使用回数は始点ステップの bounced の件数", () => {
    const rail = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "verify", attempt: 1, status: "bounced" }),
      stepRun({ id: 2, step_id: "verify", attempt: 2, status: "bounced" }),
      stepRun({ id: 3, step_id: "verify", attempt: 3, status: "success" }),
      // 行き先のステップの bounced は数えない
      stepRun({ id: 4, step_id: "implement", attempt: 1, status: "bounced" }),
    ], at("agent-review"))!;
    expect(arcOf(rail, "verify")).toMatchObject({ used: 2, maxAttempts: 3 });
    expect(arcOf(rail, "review-gate")).toMatchObject({ used: 0, maxAttempts: 3 });
  });
});

describe("steps に無い step_id", () => {
  it("run の step_id が steps に無ければ、末尾の破線ノードになる", () => {
    const rail = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "gone", status: "failed" }),
    ], at("plan"))!;
    expect(rail.nodes).toHaveLength(10);
    expect(rail.nodes.slice(0, 9).map((n) => n.id)).toEqual(DEFAULT_STEPS.map((s) => s.id));
    expect(rail.nodes[9]).toMatchObject({
      id: "gone",
      unknown: true,
      type: null,
      status: "failed",
      attempt: 1,
    });
  });

  it("current_step_id が steps に無ければ、末尾の破線ノードになる", () => {
    const rail = buildRail(DEFAULT_STEPS, [], at("vanished"))!;
    expect(rail.nodes).toHaveLength(10);
    expect(rail.nodes[9]).toMatchObject({
      id: "vanished",
      unknown: true,
      current: true,
      status: "pending",
    });
  });

  it("同じ step_id は重複させず、出てきた順に並べる", () => {
    const rail = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "gone-a" }),
      stepRun({ id: 2, step_id: "gone-b" }),
      stepRun({ id: 3, step_id: "gone-a", attempt: 2 }),
    ], at("gone-b"))!;
    expect(rail.nodes.slice(9).map((n) => n.id)).toEqual(["gone-a", "gone-b"]);
    expect(nodeOf(rail, "gone-a").attempt).toBe(2);
    expect(nodeOf(rail, "gone-b").current).toBe(true);
  });

  it("破線ノードも座標を持ち、幅に含まれる", () => {
    const rail = buildRail(DEFAULT_STEPS, [stepRun({ step_id: "gone" })], at(null))!;
    const last = rail.nodes[9];
    expect(last.x).toBeGreaterThan(rail.nodes[8].x);
    expect(rail.width).toBeGreaterThan(last.x);
  });
});

describe("steps が null", () => {
  it("帯を描かない", () => {
    expect(buildRail(null, [stepRun({ step_id: "plan" })], at("plan"))).toBeNull();
  });
});

describe("buildDefinitionRail", () => {
  const arcOf = (rail: ReturnType<typeof buildDefinitionRail>, from: string) =>
    rail.arcs.find((a) => a.from === from)!;

  it("全ステップを steps の順にノードにし、種類と approval の title を引き継ぐ", () => {
    const rail = buildDefinitionRail(WORKFLOW_DEFAULT.steps);
    expect(rail.nodes.map((n) => n.id)).toEqual(WORKFLOW_DEFAULT.steps.map((s) => s.id));
    expect(rail.nodes.find((n) => n.id === "review")).toMatchObject({ type: "approval", title: "変更を確認してください" });
    expect(rail.nodes.find((n) => n.id === "guide")).toMatchObject({ type: "guide" });
    expect(rail.nodes.find((n) => n.id === "plan")!.title).toBeUndefined();
  });

  it("実行の状態を持たない", () => {
    for (const n of buildDefinitionRail(WORKFLOW_DEFAULT.steps).nodes) {
      expect(n).not.toHaveProperty("status");
      expect(n).not.toHaveProperty("attempt");
      expect(n).not.toHaveProperty("current");
      expect(n).not.toHaveProperty("unknown");
    }
    for (const a of buildDefinitionRail(WORKFLOW_DEFAULT.steps).arcs) {
      expect(a).not.toHaveProperty("used");
    }
  });

  it("goto の戻りの弧と maxAttempts", () => {
    const rail = buildDefinitionRail(WORKFLOW_DEFAULT.steps);
    expect(rail.arcs).toHaveLength(5);
    expect(arcOf(rail, "guide")).toMatchObject({ to: "guide", fromIndex: 7, toIndex: 7, lane: 0, maxAttempts: 3, implicit: true });
    expect(arcOf(rail, "verify")).toMatchObject({ to: "implement", fromIndex: 4, toIndex: 3, lane: 1, maxAttempts: 3, implicit: false });
    expect(arcOf(rail, "plan-gate")).toMatchObject({ to: "plan", fromIndex: 2, toIndex: 0, lane: 2, maxAttempts: 3, implicit: false });
    expect(arcOf(rail, "review-gate")).toMatchObject({ to: "implement", fromIndex: 6, toIndex: 3, lane: 3, maxAttempts: 3, implicit: false });
    expect(arcOf(rail, "review")).toMatchObject({ to: "implement", fromIndex: 8, toIndex: 3, lane: 4, maxAttempts: 5, implicit: false });

    for (let i = 0; i < rail.arcs.length; i++) {
      for (let j = i + 1; j < rail.arcs.length; j++) {
        expect(crosses(rail.arcs[i], rail.arcs[j]), `${rail.arcs[i].from} と ${rail.arcs[j].from}`).toBe(false);
      }
    }
  });

  it("goto 先が steps に無い弧は作らない", () => {
    const rail = buildDefinitionRail([
      { id: "a", type: "command", run: "true", branch: { goto: "nowhere", maxAttempts: 2, feed: null, implicit: false } },
    ]);
    expect(rail.arcs).toEqual([]);
  });

  it("座標と大きさは buildRail と同じ規則", () => {
    const views: StepView[] = WORKFLOW_DEFAULT.steps.map((s) => ({
      id: s.id,
      type: s.type,
      ...(s.type === "approval" && { title: s.title }),
      ...(s.branch && { branch: { goto: s.branch.goto, maxAttempts: s.branch.maxAttempts } }),
    }));
    const defRail = buildDefinitionRail(WORKFLOW_DEFAULT.steps);
    const rail = buildRail(views, [], { current_step_id: null })!;

    expect(defRail.nodes.map((n) => n.x)).toEqual(rail.nodes.map((n) => n.x));
    expect(defRail.width).toBe(rail.width);
    expect(defRail.height).toBe(rail.height);
    const laneOf = (arcs: { from: string; lane: number }[], from: string) => arcs.find((a) => a.from === from)!.lane;
    for (const a of defRail.arcs) {
      expect(a.lane).toBe(laneOf(rail.arcs, a.from));
    }
  });
});
