import { createServer as createNetServer, type Socket } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Request, Response, ServerEvent } from "./protocol.ts";

export type Connection = {
  follow(taskId: string): void;
  unfollow(taskId: string): void;
  isFollowing(taskId: string): boolean;
};

export type Handler = (
  method: string,
  params: Record<string, unknown>,
  conn: Connection,
) => Promise<unknown>;

/** TCPポートは開かない。ファイルパーミッションがそのまま認可になる。 */
export function socketPath(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(base, "doctrine", "dctld.sock");
}

export function createServer(handler: Handler) {
  const conns = new Map<Socket, Set<string>>();

  const server = createNetServer((socket) => {
    const following = new Set<string>();
    conns.set(socket, following);
    const conn: Connection = {
      follow: (id) => following.add(id),
      unfollow: (id) => following.delete(id),
      isFollowing: (id) => following.has(id),
    };

    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === "") continue;
        void dispatch(line, socket, conn);
      }
    });
    socket.on("close", () => conns.delete(socket));
    socket.on("error", () => conns.delete(socket));
  });

  async function dispatch(line: string, socket: Socket, conn: Connection) {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      write(socket, { id: null, ok: false, error: "JSONとして読めません" });
      return;
    }
    try {
      const result = await handler(req.method, req.params ?? {}, conn);
      write(socket, { id: req.id, ok: true, result });
    } catch (e) {
      write(socket, { id: req.id, ok: false, error: (e as Error).message });
    }
  }

  function write(socket: Socket, payload: Response | ServerEvent) {
    if (socket.writable) socket.write(JSON.stringify(payload) + "\n");
  }

  return {
    async listen(path: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await unlink(path).catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    },
    broadcast(ev: ServerEvent, opts: { taskId?: string; followersOnly?: boolean } = {}): void {
      const key = opts.taskId ?? ("task_id" in ev ? ev.task_id : undefined);
      for (const [socket, following] of conns) {
        if (opts.followersOnly && (key === undefined || !following.has(key))) continue;
        write(socket, ev);
      }
    },
    async close(): Promise<void> {
      for (const socket of conns.keys()) socket.destroy();
      conns.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
