import { describe, expect, test } from "vitest";
import type { Pfd } from "../../shared/intake/pfd.ts";
import type { ProcessStatus } from "../../shared/intake/processStatus.ts";
import { PFD_SAMPLE, PFD_STATUSES_A, PFD_STATUSES_B } from "./fixtures";
import { buildPfdView, LOOK, pfdKey, processStages, type PfdView } from "./pfd";

/** 成果物 id の配列と、[id, 入力, 出力] の配列から PFD を作る。given は goal に無く、どのプロセスの出力でもない成果物 */
const pfd = (artifacts: string[], processes: [string, string[], string[]][], goal: string[]): Pfd => {
  const made = new Set(processes.flatMap(([, , outputs]) => outputs));
  return {
    title: "t",
    goal,
    artifacts: artifacts.map((id) => ({ id, name: id, given: !made.has(id) })),
    processes: processes.map(([id, inputs, outputs]) => ({ id, name: id, actor: "agent", inputs, outputs })),
  };
};

const node = (view: PfdView, key: string) => {
  const n = view.nodes.find((x) => x.key === key);
  if (!n) throw new Error(`${key} が図に無い`);
  return n;
};

const serial = () => pfd(["a0", "a1", "a2"], [["p1", ["a0"], ["a1"]], ["p2", ["a1"], ["a2"]]], ["a2"]);

describe("buildPfdView", () => {
  test("成果物とプロセスが交互の層に並ぶ", () => {
    const view = buildPfdView(serial());
    const x = (key: string) => node(view, key).x;
    expect(x("a:a0")).toBeLessThan(x("p:p1"));
    expect(x("p:p1")).toBeLessThan(x("a:a1"));
    expect(x("a:a1")).toBeLessThan(x("p:p2"));
    expect(x("p:p2")).toBeLessThan(x("a:a2"));
  });

  test("すべての辺が描け、ノードが重ならない", () => {
    const view = buildPfdView(PFD_SAMPLE);
    const edgeCount = PFD_SAMPLE.processes.reduce((n, p) => n + p.inputs.length + p.outputs.length, 0);
    expect(view.edges).toHaveLength(edgeCount);
    expect(view.nodes).toHaveLength(PFD_SAMPLE.artifacts.length + PFD_SAMPLE.processes.length);
    for (const a of view.nodes) {
      for (const b of view.nodes) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  test("辺は key でノードを指す", () => {
    const view = buildPfdView(PFD_SAMPLE);
    const keys = new Set(view.nodes.map((n) => n.key));
    for (const e of view.edges) {
      expect(keys.has(e.from)).toBe(true);
      expect(keys.has(e.to)).toBe(true);
    }
  });

  test("同じ PFD は同じ配置になる", () => {
    expect(buildPfdView(PFD_SAMPLE)).toEqual(buildPfdView(PFD_SAMPLE));
    const plain = buildPfdView(PFD_SAMPLE);
    for (const statuses of [PFD_STATUSES_A, PFD_STATUSES_B]) {
      const painted = buildPfdView(PFD_SAMPLE, { statuses });
      expect(painted.width).toBe(plain.width);
      expect(painted.height).toBe(plain.height);
      for (const n of plain.nodes) {
        const m = node(painted, n.key);
        expect([m.x, m.y, m.w]).toEqual([n.x, n.y, n.w]);
      }
    }
  });

  test("成果物とプロセスの id が重なっても別のノードになる", () => {
    const view = buildPfdView(pfd(["a0", "x"], [["x", ["a0"], ["x"]]], ["x"]));
    expect(node(view, "a:x").kind).toBe("artifact");
    expect(node(view, "p:x").kind).toBe("process");
    expect(view.nodes).toHaveLength(3);
    const commented = buildPfdView(pfd(["a0", "x"], [["x", ["a0"], ["x"]]], ["x"]), { comments: { "p:x": 1 } });
    expect(node(commented, "p:x").comments).toBe(1);
    expect(node(commented, "a:x").comments).toBe(0);
  });

  test("承認前は塗らない", () => {
    for (const n of buildPfdView(PFD_SAMPLE).nodes) {
      expect(n.look).toBeNull();
      expect(n.available).toBe(false);
    }
  });

  test("ProcessStatus を LOOK に写す", () => {
    const seen = new Set<string>();
    for (const statuses of [PFD_STATUSES_A, PFD_STATUSES_B]) {
      const view = buildPfdView(PFD_SAMPLE, { statuses });
      for (const [id, s] of Object.entries(statuses)) {
        expect(node(view, pfdKey("process", id)).look).toBe(s.state);
        seen.add(s.state);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(LOOK).sort());
    expect(Object.fromEntries(Object.entries(LOOK).map(([k, v]) => [k, v.word]))).toEqual({
      waiting: "入力待ち",
      ready: "着手可能",
      running: "実行中",
      pr_open: "PR レビュー中",
      merged: "マージ済み",
      your_turn: "あなたの番",
      done: "完了（人）",
      needs_attention: "要確認",
    });
    for (const [state, look] of Object.entries(LOOK)) expect(look.cls).toBe(`pfd-${state}`);
  });

  test("成果物の look は常に null", () => {
    const view = buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A });
    for (const n of view.nodes.filter((x) => x.kind === "artifact")) expect(n.look).toBeNull();
  });

  test("状態を渡されなかったプロセスは塗らない", () => {
    const view = buildPfdView(PFD_SAMPLE, { statuses: { design: PFD_STATUSES_A.design } });
    expect(node(view, "p:design").look).toBe("merged");
    expect(node(view, "p:ship").look).toBeNull();
  });

  test("揃っている成果物", () => {
    const statuses: Record<string, ProcessStatus> = { design: PFD_STATUSES_A.design };
    for (const p of PFD_SAMPLE.processes.slice(1)) statuses[p.id] = { state: "waiting", missing: [] };
    const view = buildPfdView(PFD_SAMPLE, { statuses });
    expect(node(view, "a:issue").available).toBe(true);
    expect(node(view, "a:policy").available).toBe(true);
    expect(node(view, "a:schema").available).toBe(true);
    expect(node(view, "a:api").available).toBe(false);
  });

  test("人のプロセスが done なら出力が揃う", () => {
    const view = buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A });
    expect(node(view, "a:review").available).toBe(true);
    expect(node(buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_B }), "a:review").available).toBe(false);
  });

  test("given・goal・human・decision の見分け", () => {
    const view = buildPfdView(PFD_SAMPLE);
    expect(node(view, "a:issue").given).toBe(true);
    expect(node(view, "a:policy").decision).toBe(true);
    expect(node(view, "a:release").goal).toBe(true);
    expect(node(view, "p:approve").human).toBe(true);
    const plain = node(view, "a:schema");
    expect([plain.given, plain.goal, plain.decision, plain.human]).toEqual([false, false, false, false]);
    expect(node(view, "p:design").human).toBe(false);
  });

  test("コメントの件数", () => {
    const view = buildPfdView(PFD_SAMPLE, { comments: { "p:design": 2 } });
    expect(node(view, "p:design").comments).toBe(2);
    for (const n of view.nodes.filter((x) => x.key !== "p:design")) expect(n.comments).toBe(0);
  });

  test("固定の印", () => {
    const view = buildPfdView(PFD_SAMPLE, { frozen: new Set(["p:design", "a:schema"]) });
    expect(view.nodes.filter((n) => n.frozen).map((n) => n.key).sort()).toEqual(["a:schema", "p:design"]);
  });

  test("プロセスの段", () => {
    const view = buildPfdView(serial());
    expect(node(view, "p:p1").stage).toBe(1);
    expect(node(view, "p:p2").stage).toBe(2);
    expect(node(view, "a:a0").stage).toBeNull();
  });

  test("変化はまだ持たない", () => {
    const view = buildPfdView(PFD_SAMPLE);
    for (const n of view.nodes) expect(n.change).toBeNull();
    expect(view.removed).toEqual([]);
  });

  test("入出力に存在しない成果物があっても例外を投げず、その辺を描かない", () => {
    const view = buildPfdView(pfd(["a0", "a1"], [["p1", ["a0", "ghost"], ["a1"]]], ["a1"]));
    expect(view.edges).toHaveLength(2);
  });
});

describe("processStages", () => {
  test("並列に走れる組", () => {
    const p = pfd(["g", "x", "y", "z"], [["a", ["g"], ["x"]], ["b", ["g"], ["y"]], ["c", ["x", "y"], ["z"]]], ["z"]);
    expect(processStages(p)).toEqual([["a", "b"], ["c"]]);
  });

  test("標本の段", () => {
    expect(processStages(PFD_SAMPLE)).toEqual([["design"], ["build-api", "build-ui"], ["approve"], ["ship"]]);
  });

  test("閉路があっても止まる", () => {
    const p = pfd(["x", "y"], [["a", ["y"], ["x"]], ["b", ["x"], ["y"]]], ["y"]);
    expect(processStages(p).flat().sort()).toEqual(["a", "b"]);
  });
});

describe("pfdKey", () => {
  test("種類で接頭辞を付ける", () => {
    expect(pfdKey("artifact", "x")).toBe("a:x");
    expect(pfdKey("process", "x")).toBe("p:x");
  });
});
