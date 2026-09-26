import { runCommand } from "../util/exec.ts";

/** OS 通知を 1 通送る境界。アダプタと同じく、テストはモックに対して主張する。 */
export type Notifier = { notify(title: string, body: string): Promise<void> };

export type RunCommand = (cmd: string, args: string[]) => Promise<unknown>;

/** AppleScript の文字列リテラルに埋め込むため。`\` を先に置き換えないと、`"` の置換で入った `\` が二重になる。 */
function escapeAppleScript(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function osascriptArgs(title: string, body: string): string[] {
  return [
    "-e",
    `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`,
  ];
}

export function notifySendArgs(title: string, body: string): string[] {
  return ["-a", "doctrine", title, body];
}

/** デーモンの動作対象は darwin と linux だけ。それ以外では何もしない。run の reject はそのまま伝える。 */
export function notifierFor(
  os: typeof Deno.build.os = Deno.build.os,
  run: RunCommand = runCommand,
): Notifier {
  if (os === "darwin") {
    return { notify: async (t, b) => void await run("osascript", osascriptArgs(t, b)) };
  }
  if (os === "linux") {
    return { notify: async (t, b) => void await run("notify-send", notifySendArgs(t, b)) };
  }
  return { notify: () => Promise.resolve() };
}
