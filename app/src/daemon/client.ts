// デーモンとやりとりする唯一の場所。Tauri の invoke / listen をここだけに閉じる。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Method,
  ParamsOf,
  ResultOf,
  ServerEvent,
} from "../../../shared/protocol.ts";
import type { IntakeDraft } from "../intake";
import type { Draft } from "../types";

export type ConnectionStatus = {
  status: "connecting" | "connected" | "disconnected";
  detail?: string | null;
};

/** Rust は method を素通しするだけ。どのメソッドがあるかは protocol.ts が持つ */
export function rpc<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  return invoke<ResultOf<M>>("rpc", { method, params });
}

/**
 * デーモンのイベント。Rust は中身を見ずに流すので、型は protocol.ts の
 * ServerEvent を信じる。知らない event はここを通って reducer が無視する。
 */
export function onDaemonEvent(fn: (ev: ServerEvent) => void): Promise<() => void> {
  return listen<ServerEvent>("daemon-event", (e) => fn(e.payload));
}

export function onConnection(fn: (c: ConnectionStatus) => void): Promise<() => void> {
  return listen<ConnectionStatus>("daemon-connection", (e) => fn(e.payload));
}

/**
 * 今の接続状態を1度だけ問い合わせる。
 * Rust は WebView が用意できる前に接続を終えるので、そのときの
 * daemon-connection は誰も聞いていない。購読を張った直後にこれで追いつく。
 */
export function connectionStatus(): Promise<ConnectionStatus> {
  return invoke<ConnectionStatus>("connection_status");
}

/**
 * 送信前の下書きの読み書き。デーモンではなく Rust 側のファイル操作へ行くが、
 * invoke を1か所に閉じるという約束はこちらにも効くので、同じ場所に置く。
 * 置き場（アプリのデータディレクトリ）は Rust が決める。
 */
export type SavedDrafts = { tasks: Record<string, Draft>; intakes: Record<string, IntakeDraft> };

export async function loadDrafts(): Promise<SavedDrafts> {
  // ファイルが無いと Rust は {} を返す。形が違うファイルも空として読む
  const saved = await invoke<Partial<SavedDrafts>>("load_drafts");
  return { tasks: saved.tasks ?? {}, intakes: saved.intakes ?? {} };
}

export function saveDrafts(drafts: SavedDrafts): Promise<void> {
  return invoke("save_drafts", { drafts });
}
