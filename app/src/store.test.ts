import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { sendDecision } from "./decision";
import { useDecide } from "./store";

beforeEach(() => {
  invoke.mockClear();
});

describe("useDecide の一時停止・再開", () => {
  test("pause は task.pause を task_id 付きで送る", async () => {
    await useDecide().pause("t-7f3a");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("rpc", { method: "task.pause", params: { task_id: "t-7f3a" } });
  });

  test("resume は task.resume を task_id 付きで送る", async () => {
    await useDecide().resume("t-d5e6");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("rpc", { method: "task.resume", params: { task_id: "t-d5e6" } });
  });

  test("送れなかったら理由付きの失敗になる", async () => {
    invoke.mockRejectedValueOnce("再開できる状態ではありません: running");
    const r = await sendDecision(useDecide().resume("t-7f3a"), "再開を送れませんでした");
    expect(r).toEqual({ ok: false, message: "再開を送れませんでした: 再開できる状態ではありません: running" });
  });
});
