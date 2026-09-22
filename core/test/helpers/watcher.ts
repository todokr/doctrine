import { type BaseSync, INITIAL_WATCH_HEALTH, type IntakeWatcher } from "../../src/intake/watch.ts";

/** 何もしない見張り。見張りを使わない試験の DaemonContext に置く。 */
export function noopWatcher(): IntakeWatcher {
  return {
    cycle: () => Promise.resolve(),
    request: () => Promise.resolve(),
    health: () => INITIAL_WATCH_HEALTH,
    idle: () => true,
  };
}

/**
 * 偽の BaseSync。既定では取り込みに成功し、どのコミットも origin の baseBranch に入っている。
 * fetchError を置くと取り込みが失敗し、missing に入れたコミットはまだ入っていないことになる。
 */
export function fakeBaseSync() {
  const state = {
    fetchError: null as Error | null,
    missing: new Set<string>(),
    fetches: 0,
    baseSync: undefined as unknown as BaseSync,
  };
  state.baseSync = {
    fetch: () => {
      state.fetches++;
      return state.fetchError ? Promise.reject(state.fetchError) : Promise.resolve();
    },
    contains: (_path, _base, commit) => Promise.resolve(!state.missing.has(commit)),
  };
  return state;
}
