import type { Loaded } from "./model";

/** 裏の保存先。IndexedDB と、テスト用のメモリ */
export type CacheStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export function memoryStore(): CacheStore {
  const map = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

const DB_NAME = "doctrine-gh-cache";
const STORE = "entries";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 初めて使うときに開く。開けない環境（テストの node など）では、いつも空で書き込みは捨てる */
export function indexedDbStore(): CacheStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("indexedDB が無い"));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return db;
  };
  return {
    get: async (key) => request((await open()).transaction(STORE).objectStore(STORE).get(key)),
    set: async (key, value) => {
      await request((await open()).transaction(STORE, "readwrite").objectStore(STORE).put(value, key));
    },
  };
}

export type GhCache = ReturnType<typeof createGhCache>;

/** 裏の保存先の前にメモリを置く。同じ起動の中で開き直したときは、peek でその場で出せる */
export function createGhCache(store: CacheStore) {
  const mem = new Map<string, unknown>();
  return {
    peek(key: string): unknown {
      return mem.get(key);
    },
    async load(key: string): Promise<unknown> {
      if (mem.has(key)) return mem.get(key);
      const value = await store.get(key).catch(() => undefined);
      if (value !== undefined && !mem.has(key)) mem.set(key, value);
      return mem.get(key);
    },
    async save(key: string, value: unknown): Promise<void> {
      mem.set(key, value);
      await store.set(key, value).catch(() => undefined);
    },
  };
}

export const ghCacheKey = {
  status: (project: string) => JSON.stringify(["status", project]),
  issues: (project: string, assignee: "me" | "any", search: string) =>
    JSON.stringify(["issues", project, assignee, search]),
  issue: (project: string, url: string) => JSON.stringify(["issue", project, url]),
};

/** refreshing は gh から取り直している最中。refreshError は、手元の値を出したまま取り直しに失敗したときの理由 */
export type Cached<T> = { loaded: Loaded<T>; refreshing: boolean; refreshError: string | null };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 手元にある値をすぐ出し、gh から取り直して置き換える。emit は最初の 1 回をその場で呼ぶ。
 * 戻り値で取り消すと、以後は emit しない（取れた値の保存はする）。
 */
export function revalidate<T>(
  cache: GhCache,
  key: string,
  fetch: () => Promise<T>,
  emit: (c: Cached<T>) => void,
): () => void {
  let alive = true;
  let fetched = false;
  let value = cache.peek(key) as T | undefined;
  const send = (c: Cached<T>) => alive && emit(c);

  send({ loaded: value === undefined ? { kind: "loading" } : { kind: "ok", value }, refreshing: true, refreshError: null });
  if (value === undefined) {
    void cache.load(key).then((stored) => {
      if (fetched || stored === undefined) return;
      value = stored as T;
      send({ loaded: { kind: "ok", value: value }, refreshing: true, refreshError: null });
    });
  }
  fetch().then(
    (fresh) => {
      fetched = true;
      value = fresh;
      void cache.save(key, fresh);
      send({ loaded: { kind: "ok", value: fresh }, refreshing: false, refreshError: null });
    },
    (e) => {
      fetched = true;
      send(
        value === undefined
          ? { loaded: { kind: "error", message: errorMessage(e) }, refreshing: false, refreshError: null }
          : { loaded: { kind: "ok", value }, refreshing: false, refreshError: errorMessage(e) },
      );
    },
  );
  return () => {
    alive = false;
  };
}

export const ghCache = createGhCache(indexedDbStore());
