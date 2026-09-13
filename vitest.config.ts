import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 各テストファイルが別プロセスで走る。
    // process.env を書き換えるテスト（DOCTRINE_STATE_DIR）と、
    // 子プロセス・Unixソケットを掴むテストが互いに干渉しない。
    pool: "forks",
    testTimeout: 15_000,
  },
});
