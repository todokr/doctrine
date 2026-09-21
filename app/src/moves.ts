// hunk の行のうち、移動として畳める範囲を求める。描画時のグルーピングだけで、行番号付けは変えない
import type { DiffLine } from "./model";
import type { MovedBlock } from "./types";

/** 畳む範囲。start / end は diffLines の結果の添字（end を含む） */
export type MoveGroup = {
  start: number;
  end: number;
  move: MovedBlock;
  /** この hunk に出ているのが移動元（削除側）か移動先（追加側）か */
  side: "from" | "to";
};

/**
 * この hunk の行のうち、移動の run にちょうど重なる連続範囲を返す（出現順・重複なし）。
 * 添字で返すのは、DiffFileBlock が行とハイライトを添字で対応づけているため。
 * run が hunk の途中で切れていれば、重なっている部分だけを返す。
 */
export function moveGroups(lines: DiffLine[], path: string, moves: MovedBlock[]): MoveGroup[] {
  const groups: MoveGroup[] = [];
  for (const move of moves) {
    for (const run of move.runs) {
      if (move.from.path === path) {
        collect(groups, lines, move, "from", run.fromStart, run.lineCount);
      }
      if (move.to.path === path) {
        collect(groups, lines, move, "to", run.toStart, run.lineCount);
      }
    }
  }
  return groups.sort((a, b) => a.start - b.start);
}

function collect(
  out: MoveGroup[],
  lines: DiffLine[],
  move: MovedBlock,
  side: "from" | "to",
  first: number,
  count: number,
) {
  // 移動元は削除行を旧い行番号で、移動先は追加行を新しい行番号で突き合わせる
  const kind = side === "from" ? "d" : "a";
  let current: MoveGroup | null = null;
  lines.forEach((l, index) => {
    const no = side === "from" ? l.old : l.new;
    const hit = l.kind === kind && no !== null && no >= first && no < first + count;
    if (!hit) {
      current = null;
      return;
    }
    // 間に別の行が挟まっていたら別の範囲にする。挟まった行を畳みの中に隠さないため
    if (current) current.end = index;
    else {
      current = { start: index, end: index, move, side };
      out.push(current);
    }
  });
}
