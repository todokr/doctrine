import { describe, expect, it } from "vitest";
import type { StepRun, StepView } from "../../shared/protocol.ts";
import { WORKFLOW_DEFAULT } from "./fixtures";
import { buildDefinitionRail, buildRail, GAP, NODE_W } from "./rail";

// .doctrine/workflows/default.yaml と同じ並び。app から core / YAML を読まないので、ここに手書きする。
const cmd = (id: string): StepView => ({ id, type: "command" });
const agent = (id: string): StepView => ({ id, type: "agent" });
const DEFAULT_STEPS: StepView[] = [
  cmd("setup"),
  agent("plan"),
  agent("plan-review"),
  cmd("plan-gate"),
  agent("implement"),
  cmd("verify"),
  agent("agent-review"),
  cmd("review-gate"),
  { id: "review", type: "approval", title: "レビュー" },
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

const nodeOf = (nodes: NonNullable<ReturnType<typeof buildRail>>, id: string) =>
  nodes.find((n) => n.id === id)!;

describe("ノードの状態", () => {
  it("status はその step_id の最後の run から取る", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "implement", attempt: 1, status: "bounced" }),
      stepRun({ id: 2, step_id: "implement", attempt: 2, status: "success" }),
    ], at("verify"))!;
    expect(nodeOf(nodes, "implement").status).toBe("success");
  });

  it("差し戻された直後のステップは bounced", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "verify", status: "bounced" }),
    ], at("implement"))!;
    expect(nodeOf(nodes, "verify").status).toBe("bounced");
  });

  it("run が 1 件も無いステップは pending", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "plan" }),
    ], at("plan-review"))!;
    expect(nodeOf(nodes, "agent-review").status).toBe("pending");
    expect(nodeOf(nodes, "review").status).toBe("pending");
  });

  it("現在のステップだけに current が立つ", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at("implement"))!;
    expect(nodes.filter((n) => n.current).map((n) => n.id)).toEqual([
      "implement",
    ]);
  });

  it("type と approval の title を引き継ぐ", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodeOf(nodes, "review")).toMatchObject({
      type: "approval",
      title: "レビュー",
      unknown: false,
    });
    expect(nodeOf(nodes, "plan")).toMatchObject({
      type: "agent",
      unknown: false,
    });
    expect(nodeOf(nodes, "plan").title).toBeUndefined();
  });

  it("steps の並びのまま返す", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodes.map((n) => n.id)).toEqual(DEFAULT_STEPS.map((s) => s.id));
  });
});

describe("steps に無い step_id", () => {
  it("run の step_id が steps に無ければ、末尾の unknown ノードになる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "gone", status: "failed" }),
    ], at("plan"))!;
    expect(nodes).toHaveLength(10);
    expect(nodes[9]).toMatchObject({
      id: "gone",
      unknown: true,
      type: null,
      status: "failed",
    });
  });

  it("current_step_id が steps に無ければ、末尾の unknown ノードになる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at("vanished"))!;
    expect(nodes[9]).toMatchObject({
      id: "vanished",
      unknown: true,
      current: true,
      status: "pending",
    });
  });

  it("同じ step_id は重複させず、出てきた順に並べる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "gone-a" }),
      stepRun({ id: 2, step_id: "gone-b" }),
      stepRun({ id: 3, step_id: "gone-a", attempt: 2 }),
    ], at("gone-b"))!;
    expect(nodes.slice(9).map((n) => n.id)).toEqual(["gone-a", "gone-b"]);
    expect(nodeOf(nodes, "gone-b").current).toBe(true);
  });
});

describe("steps が null", () => {
  it("帯を描かない", () => {
    expect(buildRail(null, [stepRun({ step_id: "plan" })], at("plan")))
      .toBeNull();
  });
});

/**
 * 2 本の戻り矢印が交差するか。区間 [min, max] で 3 通りに分ける。
 * - 離れている（端点だけの共有を含む）: 交差しない
 * - 入れ子（端を共有する場合を含む）: 内側の lane が外側より小さければ交差しない
 * - 部分的に重なる: 交差する
 */
function crosses(
  a: { fromIndex: number; toIndex: number; lane: number },
  b: { fromIndex: number; toIndex: number; lane: number },
): boolean {
  const [a0, a1] = [
    Math.min(a.fromIndex, a.toIndex),
    Math.max(a.fromIndex, a.toIndex),
  ];
  const [b0, b1] = [
    Math.min(b.fromIndex, b.toIndex),
    Math.max(b.fromIndex, b.toIndex),
  ];
  if (a1 <= b0 || b1 <= a0) return false;
  if (b0 >= a0 && b1 <= a1) return b.lane >= a.lane;
  if (a0 >= b0 && a1 <= b1) return a.lane >= b.lane;
  return true;
}

describe("buildDefinitionRail", () => {
  const arcOf = (rail: ReturnType<typeof buildDefinitionRail>, from: string) =>
    rail.arcs.find((a) => a.from === from)!;

  it("全ステップを steps の順にノードにし、種類と approval の title を引き継ぐ", () => {
    const rail = buildDefinitionRail(WORKFLOW_DEFAULT.steps);
    expect(rail.nodes.map((n) => n.id)).toEqual(
      WORKFLOW_DEFAULT.steps.map((s) => s.id),
    );
    expect(rail.nodes.find((n) => n.id === "review")).toMatchObject({
      type: "approval",
      title: "変更を確認してください",
    });
    expect(rail.nodes.find((n) => n.id === "guide")).toMatchObject({
      type: "guide",
    });
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
    expect(arcOf(rail, "guide")).toMatchObject({
      to: "guide",
      fromIndex: 7,
      toIndex: 7,
      lane: 0,
      maxAttempts: 3,
      implicit: true,
    });
    expect(arcOf(rail, "verify")).toMatchObject({
      to: "implement",
      fromIndex: 4,
      toIndex: 3,
      lane: 1,
      maxAttempts: 3,
      implicit: false,
    });
    expect(arcOf(rail, "plan-gate")).toMatchObject({
      to: "plan",
      fromIndex: 2,
      toIndex: 0,
      lane: 2,
      maxAttempts: 3,
      implicit: false,
    });
    expect(arcOf(rail, "review-gate")).toMatchObject({
      to: "implement",
      fromIndex: 6,
      toIndex: 3,
      lane: 3,
      maxAttempts: 3,
      implicit: false,
    });
    expect(arcOf(rail, "review")).toMatchObject({
      to: "implement",
      fromIndex: 8,
      toIndex: 3,
      lane: 4,
      maxAttempts: 5,
      implicit: false,
    });

    for (let i = 0; i < rail.arcs.length; i++) {
      for (let j = i + 1; j < rail.arcs.length; j++) {
        expect(
          crosses(rail.arcs[i], rail.arcs[j]),
          `${rail.arcs[i].from} と ${rail.arcs[j].from}`,
        ).toBe(false);
      }
    }
  });

  it("goto 先が steps に無い弧は作らない", () => {
    const rail = buildDefinitionRail([
      {
        id: "a",
        type: "command",
        run: "true",
        branch: {
          goto: "nowhere",
          maxAttempts: 2,
          feed: null,
          implicit: false,
        },
      },
    ]);
    expect(rail.arcs).toEqual([]);
  });

  it("ノードの座標は添字で決まり、弧が無ければレーン分の高さを足さない", () => {
    const rail = buildDefinitionRail(WORKFLOW_DEFAULT.steps);
    expect(rail.nodes.map((n) => n.x)).toEqual(
      rail.nodes.map((_, i) => i * (NODE_W + GAP)),
    );
    expect(rail.width).toBe(rail.nodes[rail.nodes.length - 1].x + NODE_W);

    const flat = buildDefinitionRail([
      { id: "a", type: "command", run: "true", branch: null },
      { id: "b", type: "command", run: "true", branch: null },
    ]);
    expect(flat.arcs).toEqual([]);
    expect(flat.height).toBeLessThan(rail.height);
  });
});
