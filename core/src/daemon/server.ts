import { dirname, join } from "@std/path";
import type { Request, Response, ServerEvent } from "../../../shared/protocol.ts";
import { stateRoot } from "../util/home.ts";

/**
 * 追従先は1接続につき1タスク（レビューアプリ設計spec 9章）。アプリは1本の接続を
 * 画面全体で共有するので、複数タスクを同時に追従できると、画面を切り替えた
 * ぶんだけ追従先が増え、見ていないタスクのログまで流れ続ける。
 */
export type Connection = {
  follow(taskId: string): void;
  unfollow(): void;
  isFollowing(taskId: string): boolean;
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
    doctrineSocket: Deno.env.get("DOCTRINE_SOCKET"),
    xdgRuntimeDir: Deno.env.get("XDG_RUNTIME_DIR"),
    stateRoot,
    uid: Deno.uid() ?? 1000,
    os: Deno.build.os === "darwin" ? "darwin" : "linux",
  });
}

type Client = {
  conn: Deno.UnixConn;
  following: string | null;
  closed: boolean;
  /** 書き込みは非同期なので、応答とイベントの順序を保つために直列につなぐ。 */
  writing: Promise<void>;
};

export function createServer(handler: Handler) {
  const clients = new Set<Client>();
  const serving = new Set<Promise<void>>();
  const encoder = new TextEncoder();
  let listener: Deno.UnixListener | null = null;
  let accepting: Promise<void> = Promise.resolve();

  async function serve(client: Client): Promise<void> {
    const conn: Connection = {
      follow: (id) => client.following = id,
      unfollow: () => client.following = null,
      isFollowing: (id) => client.following === id,
    };
    const decoder = new TextDecoder();
    const bytes = new Uint8Array(64 * 1024);
    let buf = "";
    try {
      while (true) {
        const n = await client.conn.read(bytes);
        if (n === null) break;
        buf += decoder.decode(bytes.subarray(0, n), { stream: true });
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

  function write(client: Client, payload: Response | ServerEvent) {
    if (client.closed) return;
    const data = encoder.encode(JSON.stringify(payload) + "\n");
    client.writing = client.writing
      .then(async () => {
        let offset = 0;
        while (offset < data.length && !client.closed) {
          offset += await client.conn.write(data.subarray(offset));
        }
      })
      .catch(() => closeClient(client));
  }

  function closeClient(client: Client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    try {
      client.conn.close();
    } catch { /* 既に閉じている */ }
  }

  return {
    async listen(path: string): Promise<void> {
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.remove(path).catch(() => {});
      const l = Deno.listen({ transport: "unix", path });
      listener = l;
      accepting = (async () => {
        try {
          for await (const conn of l) {
            const client: Client = {
              conn,
              following: null,
              closed: false,
              writing: Promise.resolve(),
            };
            clients.add(client);
            const p = serve(client);
            serving.add(p);
            void p.finally(() => serving.delete(p));
          }
        } catch {
          // close() でリスナーを閉じた
        }
      })();
    },
    broadcast(ev: ServerEvent, opts: { taskId?: string; followersOnly?: boolean } = {}): void {
      const key = opts.taskId ?? ("task_id" in ev ? ev.task_id : undefined);
      for (const client of clients) {
        if (opts.followersOnly && (key === undefined || client.following !== key)) continue;
        write(client, ev);
      }
    },
    /** リスナーを閉じるとソケットファイルも消える（Deno がパスを unlink する）。 */
    async close(): Promise<void> {
      for (const client of [...clients]) closeClient(client);
      if (listener) {
        try {
          listener.close();
        } catch { /* 既に閉じている */ }
        listener = null;
      }
      await accepting;
      await Promise.allSettled([...serving]);
    },
  };
}
