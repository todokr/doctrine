import type { ServerEvent, Warning } from "../../../shared/protocol.ts";

/** メモリ上に持つ件数。デーモンを再起動すると消える（レビューアプリ設計spec 9章）。 */
export const WARNING_CAPACITY = 100;

export type WarningLog = {
  push(message: string, taskId?: string): void;
  /** 新しい順。daemon.warnings がそのまま返す。 */
  recent(): Warning[];
};

/**
 * 人に見せる必要のある警告の置き場。
 *
 * 3つの出口を1箇所に束ねる: デーモンのstderr、つないでいるアプリへの
 * `daemon.warning`、後から開いたアプリが読む `daemon.warnings`。
 * 溜めてから吐く形にすると、アプリを開いている間に起きた警告が
 * 次の吐き出しまで届かない。
 */
export function createWarningLog(o: {
  broadcast(ev: ServerEvent): void;
  write?(line: string): void;
  now?(): Date;
}): WarningLog {
  const write = o.write ?? ((line: string) => console.error(line));
  const now = o.now ?? (() => new Date());
  // 新しい順に持つ。recent() が毎回並べ替えなくて済む。
  const recent: Warning[] = [];
  return {
    push(message, taskId) {
      const entry: Warning = { at: now().toISOString(), message };
      if (taskId !== undefined) entry.task_id = taskId;
      recent.unshift(entry);
      recent.length = Math.min(recent.length, WARNING_CAPACITY);
      write(`[warn] ${taskId === undefined ? "" : `${taskId}: `}${message}`);
      o.broadcast({ event: "daemon.warning", ...entry });
    },
    recent: () => [...recent],
  };
}
