import { INITIAL_WATCH_HEALTH, type IntakeWatcher } from "../../src/intake/watch.ts";

/** 何もしない見張り。見張りを使わない試験の DaemonContext に置く。 */
export function noopWatcher(): IntakeWatcher {
  return {
    cycle: () => Promise.resolve(),
    request: () => Promise.resolve(),
    health: () => INITIAL_WATCH_HEALTH,
    idle: () => true,
  };
}
