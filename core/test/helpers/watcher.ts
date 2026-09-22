import { type BaseSync, INITIAL_WATCH_HEALTH, type IntakeWatcher } from "../../src/intake/watch.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import type { WorkflowLoader } from "../../src/workflow/load.ts";

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

const DEFAULT_WORKFLOW_TEXT =
  "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n";

/** プロジェクトのパスを見ずに、どの名前にも同じ YAML を返す読み手。 */
export function fakeWorkflowLoader(text: string = DEFAULT_WORKFLOW_TEXT): WorkflowLoader {
  return (_projectPath, _name) => {
    const { workflow, warnings } = parseWorkflow(text);
    return Promise.resolve({ text, workflow, warnings });
  };
}
