import { describe, expect, test } from "vitest";
import example from "../../shared/guide/examples/step-artifacts.guide.json";
import { validateGuide } from "../../shared/guide/validate.ts";
import { layoutGraph, motionStep } from "./diagram";
import type { Diagram } from "./types";

const validated = validateGuide(example);
if (!validated.ok) throw new Error(validated.issues.join("\n"));

type GraphBody = Extract<Diagram["body"], { shape: "graph" }>;

const deps = (): GraphBody => {
  const body = validated.guide.diagrams.find((d) => d.id === "d-deps")!.body;
  if (body.shape !== "graph") throw new Error("d-deps は graph のはず");
  return body;
};

const graph = (ids: string[], edges: [string, string][], kind: GraphBody["kind"] = "state"): GraphBody => ({
  shape: "graph",
  kind,
  nodes: ids.map((id) => ({ id, label: id })),
  edges: edges.map(([from, to]) => ({ from, to, label: "" })),
});

describe("layoutGraph", () => {
  test("すべてのノードに座標が付き、重ならない", () => {
    const { nodes } = layoutGraph(deps());
    expect(nodes).toHaveLength(5);
    for (const n of nodes) for (const v of [n.x, n.y, n.w, n.h]) expect(Number.isFinite(v)).toBe(true);
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  test("依存の辺は層を右へ進む", () => {
    const { nodes } = layoutGraph(deps());
    const x = (id: string) => nodes.find((n) => n.id === id)!.x;
    expect(x("runTask")).toBeLessThan(x("getSessionId"));
    expect(x("getSessionId")).toBeLessThan(x("task_sessions"));
  });

  test("状態遷移の閉路でも止まり、戻る辺は back になる", () => {
    const { edges } = layoutGraph(graph(["a", "b"], [["a", "b"], ["b", "a"]]));
    expect(edges).toHaveLength(2);
    expect(edges.filter((e) => e.back)).toHaveLength(1);
  });

  test("自分へ戻る辺は self になる", () => {
    const { edges } = layoutGraph(graph(["a"], [["a", "a"]]));
    expect(edges[0].self).toBe(true);
  });

  test("図に無いノードを指す辺は描かず、数える", () => {
    const res = layoutGraph(graph(["a"], [["a", "zz"]]));
    expect(res.edges).toHaveLength(0);
    expect(res.dropped).toBe(1);
  });

  test("ノードが無くても大きさが決まる", () => {
    const res = layoutGraph(graph([], []));
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
  });

  test("辺の座標は有限で、ノードのどれかに向かって引かれる", () => {
    const { edges } = layoutGraph(deps());
    expect(edges).toHaveLength(4);
    for (const e of edges) {
      expect(e.d).not.toMatch(/NaN|undefined/);
      expect(Number.isFinite(e.labelX) && Number.isFinite(e.labelY)).toBe(true);
    }
  });
});

describe("motionStep", () => {
  test("加わったものは、変わっていないものより後に現れる", () => {
    expect(motionStep("node", "added")).toBeGreaterThan(motionStep("node", undefined));
    expect(motionStep("edge", "added")).toBeGreaterThan(motionStep("edge", undefined));
    expect(motionStep("node", "removed")).toBe(motionStep("node", undefined));
  });
});
