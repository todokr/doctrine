import { describe, expect, test } from "vitest";
import { createGhCache, ghCacheKey, memoryStore, revalidate, type Cached, type CacheStore } from "./ghCache";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ghCacheKey", () => {
  test("一覧のキーはプロジェクト・担当・検索語で分かれる", () => {
    const keys = new Set([
      ghCacheKey.issues("/a", "me", ""),
      ghCacheKey.issues("/a", "any", ""),
      ghCacheKey.issues("/a", "me", "x"),
      ghCacheKey.issues("/b", "me", ""),
    ]);
    expect(keys.size).toBe(4);
  });

  test("状態・一覧・本文のキーは重ならない", () => {
    expect(ghCacheKey.status("/a")).not.toBe(ghCacheKey.issues("/a", "me", ""));
    expect(ghCacheKey.issue("/a", "u")).not.toBe(ghCacheKey.status("/a"));
  });
});

describe("createGhCache", () => {
  test("保存したものはその場で peek できる", async () => {
    const cache = createGhCache(memoryStore());
    expect(cache.peek("k")).toBeUndefined();
    await cache.save("k", 1);
    expect(cache.peek("k")).toBe(1);
  });

  test("peek に無くても、裏の保存先にあれば load で取れ、以後は peek できる", async () => {
    const store = memoryStore();
    await store.set("k", "v");
    const cache = createGhCache(store);
    expect(cache.peek("k")).toBeUndefined();
    expect(await cache.load("k")).toBe("v");
    expect(cache.peek("k")).toBe("v");
  });

  test("裏の保存先が失敗しても、無いものとして扱う", async () => {
    const broken: CacheStore = {
      get: () => Promise.reject(new Error("x")),
      set: () => Promise.reject(new Error("x")),
    };
    const cache = createGhCache(broken);
    expect(await cache.load("k")).toBeUndefined();
    await cache.save("k", 1);
    expect(cache.peek("k")).toBe(1);
  });
});

describe("revalidate", () => {
  function run<T>(cache: ReturnType<typeof createGhCache>, fetch: () => Promise<T>) {
    const seen: Cached<T>[] = [];
    const cancel = revalidate(cache, "k", fetch, (c) => seen.push(c));
    return { seen, cancel };
  }

  test("手元に無ければ読み込み中から始め、取れたら出して保存する", async () => {
    const cache = createGhCache(memoryStore());
    const { seen } = run(cache, () => Promise.resolve(["a"]));
    expect(seen[0]).toEqual({ loaded: { kind: "loading" }, refreshing: true, refreshError: null });
    await flush();
    expect(seen.at(-1)).toEqual({ loaded: { kind: "ok", value: ["a"] }, refreshing: false, refreshError: null });
    expect(cache.peek("k")).toEqual(["a"]);
  });

  test("手元にあれば最初からそれを出し、取り直したもので置き換える", async () => {
    const cache = createGhCache(memoryStore());
    await cache.save("k", ["old"]);
    const { seen } = run(cache, () => Promise.resolve(["new"]));
    expect(seen[0]).toEqual({ loaded: { kind: "ok", value: ["old"] }, refreshing: true, refreshError: null });
    await flush();
    expect(seen.at(-1)?.loaded).toEqual({ kind: "ok", value: ["new"] });
    expect(cache.peek("k")).toEqual(["new"]);
  });

  test("裏の保存先から読めたら、取り直しを待たずに出す", async () => {
    const store = memoryStore();
    await store.set("k", ["stored"]);
    const cache = createGhCache(store);
    const fresh = deferred<string[]>();
    const { seen } = run(cache, () => fresh.promise);
    expect(seen[0].loaded).toEqual({ kind: "loading" });
    await flush();
    expect(seen.at(-1)).toEqual({ loaded: { kind: "ok", value: ["stored"] }, refreshing: true, refreshError: null });
    fresh.resolve(["new"]);
    await flush();
    expect(seen.at(-1)?.loaded).toEqual({ kind: "ok", value: ["new"] });
  });

  test("取り直しが先に届いたら、遅れて読めた保存先の値で巻き戻さない", async () => {
    const stored = deferred<unknown>();
    const store: CacheStore = { get: () => stored.promise, set: () => Promise.resolve() };
    const cache = createGhCache(store);
    const { seen } = run(cache, () => Promise.resolve(["new"]));
    await flush();
    stored.resolve(["stored"]);
    await flush();
    expect(seen.at(-1)?.loaded).toEqual({ kind: "ok", value: ["new"] });
  });

  test("取り直しに失敗しても、手元の値は出したままにして失敗を添える", async () => {
    const cache = createGhCache(memoryStore());
    await cache.save("k", ["old"]);
    const { seen } = run(cache, () => Promise.reject(new Error("gh が落ちた")));
    await flush();
    expect(seen.at(-1)).toEqual({
      loaded: { kind: "ok", value: ["old"] },
      refreshing: false,
      refreshError: "gh が落ちた",
    });
  });

  test("手元に無いまま失敗したら error にする", async () => {
    const cache = createGhCache(memoryStore());
    const { seen } = run(cache, () => Promise.reject(new Error("gh が落ちた")));
    await flush();
    expect(seen.at(-1)).toEqual({ loaded: { kind: "error", message: "gh が落ちた" }, refreshing: false, refreshError: null });
  });

  test("取り消したあとは何も出さないが、取れた値は保存する", async () => {
    const cache = createGhCache(memoryStore());
    const fresh = deferred<string[]>();
    const { seen, cancel } = run(cache, () => fresh.promise);
    const before = seen.length;
    cancel();
    fresh.resolve(["new"]);
    await flush();
    expect(seen.length).toBe(before);
    expect(cache.peek("k")).toEqual(["new"]);
  });
});
