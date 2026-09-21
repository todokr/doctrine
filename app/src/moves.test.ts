import { describe, expect, test } from "vitest";
import { moveGroups } from "./moves";
import { diffLines } from "./model";
import type { MovedBlock } from "./types";

const block = (
  from: { path: string; startLine: number; endLine: number },
  to: { path: string; startLine: number; endLine: number },
  runs: MovedBlock["runs"],
): MovedBlock => ({ id: "mv_1", from, to, runs, edited: false, indentOnly: false });

const hunk = (o: number, n: number, ...body: string[]) => diffLines({ old: o, new: n, body: body.join("\n") });

describe("moveGroups", () => {
  test("移動に含まれる連続した追加行を1つの group にする", () => {
    const lines = hunk(9, 9, " ctx", "+l1", "+l2", "+l3", "+l4", "+l5", " ctx");
    const m = block(
      { path: "a.ts", startLine: 1, endLine: 5 },
      { path: "b.ts", startLine: 10, endLine: 14 },
      [{ fromStart: 1, toStart: 10, lineCount: 5 }],
    );
    expect(moveGroups(lines, "b.ts", [m])).toEqual([{ start: 1, end: 5, move: m, side: "to" }]);
  });

  test("移動に含まれない行は group に入らない", () => {
    const lines = hunk(9, 9, " ctx", "+x", "+m1", "+m2", "+m3", "+y");
    const m = block(
      { path: "a.ts", startLine: 1, endLine: 3 },
      { path: "b.ts", startLine: 11, endLine: 13 },
      [{ fromStart: 1, toStart: 11, lineCount: 3 }],
    );
    const groups = moveGroups(lines, "b.ts", [m]);
    expect(groups.map((g) => [g.start, g.end])).toEqual([[2, 4]]);
  });

  test("移動元と移動先が同じファイルにあるときは両方の group を返す", () => {
    const lines = hunk(1, 1, " c1", "-m1", "-m2", "-m3", " c2", "+m1", "+m2", "+m3");
    const m = block(
      { path: "a.ts", startLine: 2, endLine: 4 },
      { path: "a.ts", startLine: 3, endLine: 5 },
      [{ fromStart: 2, toStart: 3, lineCount: 3 }],
    );
    const groups = moveGroups(lines, "a.ts", [m]);
    expect(groups.map((g) => [g.side, g.start, g.end])).toEqual([["from", 1, 3], ["to", 5, 7]]);
  });

  test("run が hunk の途中で切れていたら重なる範囲だけ返す", () => {
    const lines = hunk(9, 9, " ctx", "+l1", "+l2", "+l3");
    const m = block(
      { path: "a.ts", startLine: 1, endLine: 5 },
      { path: "b.ts", startLine: 10, endLine: 14 },
      [{ fromStart: 1, toStart: 10, lineCount: 5 }],
    );
    const groups = moveGroups(lines, "b.ts", [m]);
    expect(groups.map((g) => [g.start, g.end])).toEqual([[1, 3]]);
  });

  test("別の種類の行を挟む範囲は1つにしない", () => {
    // 追加行の間に削除行が挟まっていたら、その削除行を畳みの中に巻き込まない
    const lines = hunk(1, 1, "+m1", "-x", "+m2");
    const m = block(
      { path: "a.ts", startLine: 1, endLine: 2 },
      { path: "b.ts", startLine: 1, endLine: 2 },
      [{ fromStart: 1, toStart: 1, lineCount: 2 }],
    );
    const groups = moveGroups(lines, "b.ts", [m]);
    expect(groups.map((g) => [g.start, g.end])).toEqual([[0, 0], [2, 2]]);
  });

  test("移動が無ければ空配列", () => {
    expect(moveGroups(hunk(1, 1, "+a"), "b.ts", [])).toEqual([]);
  });
});
