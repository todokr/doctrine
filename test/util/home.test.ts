import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { stateRoot } from "../../src/util/home.ts";

test("stateRoot: DOCTRINE_STATE_DIR が空文字なら未設定として扱う", () => {
  // 設定し忘れ（`export DOCTRINE_STATE_DIR=` のように空文字を代入してしまう）で
  // 状態ディレクトリが相対パスになると、起動した場所で DB とソケットの位置が変わる
  const prev = Deno.env.get("DOCTRINE_STATE_DIR");
  Deno.env.set("DOCTRINE_STATE_DIR", "");
  try {
    assert.ok(stateRoot().endsWith("/.local/state/doctrine"));
  } finally {
    if (prev === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
    else Deno.env.set("DOCTRINE_STATE_DIR", prev);
  }
});
