import { describe, expect, it } from "vitest";
import type { StepRun, StepView } from "../../shared/protocol.ts";
import { buildRail } from "./rail";

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

const nodeOf = (nodes: NonNullable<ReturnType<typeof buildRail>>, id: string) => nodes.find((n) => n.id === id)!;

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
    const nodes = buildRail(DEFAULT_STEPS, [stepRun({ id: 1, step_id: "plan" })], at("plan-review"))!;
    expect(nodeOf(nodes, "agent-review").status).toBe("pending");
    expect(nodeOf(nodes, "review").status).toBe("pending");
  });

  it("現在のステップだけに current が立つ", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at("implement"))!;
    expect(nodes.filter((n) => n.current).map((n) => n.id)).toEqual(["implement"]);
  });

  it("type と approval の title を引き継ぐ", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodeOf(nodes, "review")).toMatchObject({ type: "approval", title: "レビュー", unknown: false });
    expect(nodeOf(nodes, "plan")).toMatchObject({ type: "agent", unknown: false });
    expect(nodeOf(nodes, "plan").title).toBeUndefined();
  });

  it("steps の並びのまま返す", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodes.map((n) => n.id)).toEqual(DEFAULT_STEPS.map((s) => s.id));
  });
});

describe("steps に無い step_id", () => {
  it("run の step_id が steps に無ければ、末尾の unknown ノードになる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [stepRun({ id: 1, step_id: "gone", status: "failed" })], at("plan"))!;
    expect(nodes).toHaveLength(10);
    expect(nodes[9]).toMatchObject({ id: "gone", unknown: true, type: null, status: "failed" });
  });

  it("current_step_id が steps に無ければ、末尾の unknown ノードになる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at("vanished"))!;
    expect(nodes[9]).toMatchObject({ id: "vanished", unknown: true, current: true, status: "pending" });
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
    expect(buildRail(null, [stepRun({ step_id: "plan" })], at("plan"))).toBeNull();
  });
});
