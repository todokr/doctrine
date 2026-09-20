import { describe, expect, it } from "vitest";
import { isAtBottom } from "./tailStick";

describe("isAtBottom", () => {
  it("末尾まで見ていれば貼り付く", () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it("1行ぶんのズレは末尾とみなす", () => {
    expect(isAtBottom({ scrollTop: 780, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it("遡っていれば貼り付かない", () => {
    expect(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });

  it("スクロールが要らないほど短いログは末尾扱い", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 400 })).toBe(true);
  });
});
