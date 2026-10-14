import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { configRoot, stateRoot } from "../../src/util/home.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("stateRoot: DOCTRINE_STATE_DIR が空文字なら未設定として扱う", () => {
  // 設定し忘れ（`export DOCTRINE_STATE_DIR=` のように空文字を代入してしまう）で
  // 状態ディレクトリが相対パスになると、起動した場所で DB とソケットの位置が変わる
  const prev = process.env.DOCTRINE_STATE_DIR;
  process.env.DOCTRINE_STATE_DIR = "";
  try {
    assert.ok(stateRoot().endsWith("/.local/state/doctrine"));
  } finally {
    if (prev === undefined) delete process.env.DOCTRINE_STATE_DIR;
    else process.env.DOCTRINE_STATE_DIR = prev;
  }
});

test("configRoot: DOCTRINE_CONFIG_DIR があればそれを使う", () => {
  withEnv({ DOCTRINE_CONFIG_DIR: "/tmp/doctrine-config", XDG_CONFIG_HOME: "/tmp/xdg" }, () =>
    assert.equal(configRoot(), "/tmp/doctrine-config"),
  );
});

test("configRoot: DOCTRINE_CONFIG_DIR が無ければ $XDG_CONFIG_HOME/doctrine", () => {
  withEnv({ DOCTRINE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: "/tmp/xdg" }, () =>
    assert.equal(configRoot(), "/tmp/xdg/doctrine"),
  );
});

test("configRoot: どちらも無ければ ~/.config/doctrine", () => {
  withEnv({ DOCTRINE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined }, () =>
    assert.equal(configRoot(), join(process.env.HOME!, ".config", "doctrine")),
  );
});

test("configRoot: 空文字は未設定として扱う", () => {
  withEnv({ DOCTRINE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, () =>
    assert.ok(configRoot().endsWith("/.config/doctrine")),
  );
});

test("configRoot: 相対パスの XDG_CONFIG_HOME は無視する", () => {
  withEnv({ DOCTRINE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: "rel/xdg" }, () =>
    assert.ok(configRoot().endsWith("/.config/doctrine")),
  );
});

test("configRoot: DOCTRINE_STATE_DIR には引きずられない", () => {
  withEnv(
    {
      DOCTRINE_STATE_DIR: "/tmp/doctrine-state",
      DOCTRINE_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: undefined,
    },
    () => {
      const got = configRoot();
      assert.ok(got.endsWith("/.config/doctrine"));
      assert.ok(!got.startsWith("/tmp/doctrine-state"));
    },
  );
});
