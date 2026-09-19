import { describe, expect, test } from "vitest";
import { createRefreshGate } from "./refreshGate";

describe("createRefreshGate", () => {
  test("最後に始めた1本だけが isLatest になる", () => {
    const gate = createRefreshGate();
    const a = gate.begin();
    const b = gate.begin();
    expect(gate.isLatest(a)).toBe(false);
    expect(gate.isLatest(b)).toBe(true);
  });

  test("古い応答が後から届いても勝てない（本来のバグの再現）", () => {
    const gate = createRefreshGate();
    // イベントで1本目、その直後に15秒タイマーで2本目が始まったとする
    const first = gate.begin();
    const second = gate.begin();
    // ネットワークの都合で2本目の応答が先に届く
    expect(gate.isLatest(second)).toBe(true);
    // その後、遅れて1本目の応答が届く。これは新しい状態を上書きしてはいけない
    expect(gate.isLatest(first)).toBe(false);
  });

  test("1本しか走っていなければ勝てる", () => {
    const gate = createRefreshGate();
    const only = gate.begin();
    expect(gate.isLatest(only)).toBe(true);
  });

  test("3本以上でも最後の1本だけが勝つ", () => {
    const gate = createRefreshGate();
    const tokens = [gate.begin(), gate.begin(), gate.begin(), gate.begin()];
    tokens.forEach((t, i) => {
      expect(gate.isLatest(t)).toBe(i === tokens.length - 1);
    });
  });
});
