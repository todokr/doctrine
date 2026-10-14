import { mkdir, rm } from "node:fs/promises";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Request, Response, ServerEvent } from "../../../shared/protocol.ts";
import { stateRoot } from "../util/home.ts";

/**
 * 追従先は1接続につき1つ（レビューアプリ設計spec 9章）。アプリは1本の接続を
 * 画面全体で共有するので、複数を同時に追従できると、画面を切り替えた
 * ぶんだけ追従先が増え、見ていないタスクのログまで流れ続ける。
 * 追従先はタスクの id か Intake の id で、どちらも UUID なので同じ枠を分け合う。
 */
export type Connection = {
  follow(key: string): void;
  unfollow(): void;
  isFollowing(key: string): boolean;
};

export type Handler = (
  method: string,
  params: Record<string, unknown>,
  conn: Connection,
) => Promise<unknown>;

export type SocketEnv = {
  doctrineSocket?: string;
  xdgRuntimeDir?: string;
  /** macOS の分岐でしか要らないので、呼ばれたときだけ解決する。
   *  先に解決すると、XDG_RUNTIME_DIR はあるが HOME が無い環境で
   *  stateRoot() が投げ、繋がるはずの経路まで落ちる。 */
  stateRoot: () => string;
  uid: number;
  os: "darwin" | "linux";
};

/** 環境を引数で受ける純関数。OS 分岐をテストから叩けるようにするため。 */
export function resolveSocketPath(env: SocketEnv): string {
  if (env.doctrineSocket) return env.doctrineSocket;
  if (env.xdgRuntimeDir) return join(env.xdgRuntimeDir, "doctrine", "dctld.sock");
  // macOS には XDG_RUNTIME_DIR が無く、/run は read-only なので mkdir が失敗する。
  // 状態ディレクトリ（DB と同じ場所、0o700）に置く。古いソケットファイルが
  // 再起動をまたいで残るが、assertSocketNotLive が扱う。
  if (env.os === "darwin") return join(env.stateRoot(), "dctld.sock");
  return join(`/run/user/${env.uid}`, "doctrine", "dctld.sock");
}

/** TCPポートは開かない。ファイルパーミッションがそのまま認可になる。 */
export function socketPath(): string {
  return resolveSocketPath({
    doctrineSocket: process.env.DOCTRINE_SOCKET,
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    stateRoot,
    uid: process.getuid?.() ?? 1000,
    os: process.platform === "darwin" ? "darwin" : "linux",
  });
}

type Client = {
  conn: Socket;
  following: string | null;
  closed: boolean;
};

export function createServer(handler: Handler) {
  const clients = new Set<Client>();
  const serving = new Set<Promise<void>>();
  let server: Server | null = null;

  async function serve(client: Client): Promise<void> {
    const conn: Connection = {
      follow: (id) => client.following = id,
      unfollow: () => client.following = null,
      isFollowing: (id) => client.following === id,
    };
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of client.conn) {
        buf += decoder.decode(chunk as Buffer, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim() === "") continue;
          void dispatch(line, client, conn);
        }
      }
    } catch {
      // 相手が切断した、または close() で閉じた
    } finally {
      closeClient(client);
    }
  }

  async function dispatch(line: string, client: Client, conn: Connection) {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      write(client, { id: null, ok: false, error: "JSONとして読めません" });
      return;
    }
    try {
      const result = await handler(req.method, req.params ?? {}, conn);
      write(client, { id: req.id, ok: true, result });
    } catch (e) {
      write(client, { id: req.id, ok: false, error: (e as Error).message });
    }
  }

  /** Socket.write は書き切れなかった分を内部に溜め、呼んだ順に書く。応答とイベントの順序はそれで保たれる。 */
  function write(client: Client, payload: Response | ServerEvent) {
    if (client.closed) return;
    client.conn.write(JSON.stringify(payload) + "\n");
  }

  function closeClient(client: Client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    client.conn.destroy();
  }

  return {
    async listen(path: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await rm(path, { force: true });
      const s = createNetServer((conn) => {
        // 相手が先に切れたときの EPIPE / ECONNRESET。聞かないとデーモンごと落ちる。
        conn.on("error", () => {});
        const client: Client = { conn, following: null, closed: false };
        clients.add(client);
        const p = serve(client);
        serving.add(p);
        void p.finally(() => serving.delete(p));
      });
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(path, () => {
          s.off("error", reject);
          resolve();
        });
      });
      server = s;
    },
    broadcast(ev: ServerEvent, opts: { followKey?: string; followersOnly?: boolean } = {}): void {
      const key = opts.followKey ?? ("task_id" in ev ? ev.task_id : undefined);
      for (const client of clients) {
        if (opts.followersOnly && (key === undefined || client.following !== key)) continue;
        write(client, ev);
      }
    },
    /** サーバを閉じるとソケットファイルも消える（libuv がパスを unlink する）。 */
    async close(): Promise<void> {
      for (const client of [...clients]) closeClient(client);
      if (server) {
        const s = server;
        server = null;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      await Promise.allSettled([...serving]);
    },
  };
}
