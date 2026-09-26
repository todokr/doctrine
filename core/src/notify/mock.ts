import type { Notifier } from "./notifier.ts";

export type MockNotifier = Notifier & { calls: { title: string; body: string }[] };

/** fail を渡すと、呼び出しを calls に積んだうえでその Error で reject する。 */
export function createMockNotifier(o: { fail?: Error } = {}): MockNotifier {
  const calls: { title: string; body: string }[] = [];
  return {
    calls,
    notify(title, body) {
      calls.push({ title, body });
      return o.fail ? Promise.reject(o.fail) : Promise.resolve();
    },
  };
}
