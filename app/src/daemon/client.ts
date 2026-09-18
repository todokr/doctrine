// デーモンとやりとりする唯一の場所。Tauri の invoke / listen をここだけに閉じる。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Method,
  ParamsOf,
  ResultOf,
  ServerEvent,
} from "../../../src/daemon/protocol.ts";

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
