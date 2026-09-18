import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import { connectionStatus, onConnection, onDaemonEvent, rpc } from "./daemon/client";
import { reduce, toProject, toTask, type Action, type State } from "./model";
import { createRefreshGate } from "./refreshGate";
import type { Draft } from "./types";

// 送信前の下書きは閉じても消さない。spec ではアプリのデータディレクトリに置くが、localStorage で代える
const DRAFTS_KEY = "doctrine-drafts";

/** 取りこぼしを吸収する保険。dctl add で作られた queued はイベントが飛ばない */
const REFRESH_MS = 15_000;

function loadDrafts(): Record<string, Draft> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function initialState(): State {
  return {
    tasks: [],
    projects: [],
    now: Date.now(),
    view: "tasks",
    project: "all",
    sel: null,
    scope: {},
    step: {},
    drafts: loadDrafts(),
    editing: null,
    modal: null,
    toast: null,
    conn: { status: "connecting" },
  };
}

const Ctx = createContext<{ s: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reduce, undefined, initialState);
  // イベントのハンドラから最新の state を見るため（購読は1回しか張らない）
  const latest = useRef(s);
  latest.current = s;
  // 取り直しは同時に何本も走る（イベント・15秒・再接続）。古い応答が
  // 新しい応答の後に届くと、画面が一度古い状態に巻き戻る。
  // 最後に始めた1本だけが反映してよい（ロジック自体は refreshGate.ts でテスト済み）
  const refreshGate = useRef(createRefreshGate()).current;

  useEffect(() => {
    let alive = true;
    let unlisteners: (() => void)[] = [];

    async function refresh() {
      const token = refreshGate.begin();
      try {
        const [projects, tasks] = await Promise.all([
          rpc("project.list", {}),
          rpc("task.list", {}),
        ]);
        if (!alive || !refreshGate.isLatest(token)) return;
        // previous を渡さないと、stepRun.finished で付いた degraded のステップ名が
        // 15 秒ごとの取り直しのたびに消える
        const known = latest.current.tasks;
        dispatch({
          type: "sync",
          projects: projects.map(toProject),
          tasks: tasks.map((row) => toTask(row, projects, known.find((t) => t.id === row.id))),
          now: Date.now(),
        });
      } catch {
        // 切断中は失敗して当然。理由はバナーが出している
      }
    }

    async function subscribe() {
      // 先に購読を張り終える。状態の問い合わせを先にすると、その隙間に起きた
      // 接続の変化を取りこぼす
      const listeners = await Promise.all([
        onConnection((conn) => {
          dispatch({ type: "connection", conn });
          // 再接続したら取り直す。これがイベントの取りこぼしを吸収する
          if (conn.status === "connected") void refresh();
        }),
        onDaemonEvent((ev) => {
          // 知らないタスクのイベントは、まだ持っていないタスクが動いたということ。
          // reducer は純関数なので取得できない。ここで取り直す
          if ("task_id" in ev && !latest.current.tasks.some((t) => t.id === ev.task_id)) {
            void refresh();
            return;
          }
          dispatch({ type: "daemon", ev, now: Date.now() });
        }),
      ]);
      if (!alive) {
        for (const off of listeners) off();
        return;
      }
      unlisteners = listeners;

      // Rust は WebView が用意できる前に接続を終えている。そのときの
      // daemon-connection は誰も聞いていないので、ここで追いつく。
      // これが無いと、データは流れているのにバナーが出たままになる
      try {
        const conn = await connectionStatus();
        if (alive) dispatch({ type: "connection", conn });
      } catch {
        // 取れなくても、次の変化はイベントで届く
      }
      void refresh();
    }

    void subscribe();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    return () => {
      alive = false;
      clearInterval(timer);
      for (const off of unlisteners) off();
    };
    // 購読は1回だけ張る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(s.drafts));
    } catch {
      // 保存できなくても画面は動かす
    }
  }, [s.drafts]);

  useEffect(() => {
    if (!s.toast) return;
    const h = setTimeout(() => dispatch({ type: "toast", message: null }), 2600);
    return () => clearTimeout(h);
  }, [s.toast]);

  return <Ctx.Provider value={{ s, dispatch }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("StoreProvider の外で useStore を呼んでいます");
  return v;
}

/** 第2段階に回した操作のボタンが押されたときに出す */
export function useNotYet() {
  const { dispatch } = useStore();
  return (message: string) => dispatch({ type: "toast", message });
}
