import { describe, expect, test, vi } from "vitest";
import { settleListeners } from "./settleListeners";

describe("settleListeners", () => {
  test("両方成功すれば両方とも registered に入り、failedCount は 0", async () => {
    const offA = vi.fn();
    const offB = vi.fn();
    const { registered, failedCount } = await settleListeners([
      Promise.resolve(offA),
      Promise.resolve(offB),
    ]);
    expect(registered).toEqual([offA, offB]);
    expect(failedCount).toBe(0);
  });

  test("片方が reject しても、成功した方の unsubscribe は必ず拾われる", async () => {
    // 例: onConnection は成功、onDaemonEvent は失敗（listen() 自体が reject するケース）
    const offConnection = vi.fn();
    const { registered, failedCount } = await settleListeners([
      Promise.resolve(offConnection),
      Promise.reject(new Error("listen failed")),
    ]);
    expect(registered).toEqual([offConnection]);
    expect(failedCount).toBe(1);

    // store.tsx の cleanup は registered を単純に呼ぶだけなので、
    // 「登録できたものは後片付けの対象になる」ことをここで示す
    for (const off of registered) off();
    expect(offConnection).toHaveBeenCalledOnce();
  });

  test("両方失敗すれば registered は空、failedCount は2", async () => {
    const { registered, failedCount } = await settleListeners([
      Promise.reject(new Error("a")),
      Promise.reject(new Error("b")),
    ]);
    expect(registered).toEqual([]);
    expect(failedCount).toBe(2);
  });
});
