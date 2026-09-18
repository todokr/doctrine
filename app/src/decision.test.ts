import { describe, expect, test } from "vitest";
import { sendDecision } from "./decision";

describe("sendDecision", () => {
  test("送信が成功したら ok:true（呼び出し側はここで下書きを消してよい）", async () => {
    const r = await sendDecision(Promise.resolve({ id: "t-1" }), "承認を送れませんでした");
    expect(r).toEqual({ ok: true });
  });

  test("送信が失敗したら ok:false で日本語のエラーを持つ（下書きは呼び出し側で残す）", async () => {
    const r = await sendDecision(Promise.reject(new Error("dctld unreachable")), "差し戻しを送れませんでした");
    expect(r).toEqual({ ok: false, message: "差し戻しを送れませんでした: Error: dctld unreachable" });
  });

  test("拒否理由が Error でなくても文字列化する", async () => {
    const r = await sendDecision(Promise.reject("boom"), "中止を送れませんでした");
    expect(r).toEqual({ ok: false, message: "中止を送れませんでした: boom" });
  });
});
