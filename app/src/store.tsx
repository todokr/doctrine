import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import { NOW, PROJECTS, seedTasks } from "./mock";
import { reduce, type Action, type State } from "./model";
import type { Draft } from "./types";

// 送信前の下書きは閉じても消さない。spec ではアプリのデータディレクトリに置くが、ガワの段階では localStorage で代える
const DRAFTS_KEY = "doctrine-drafts";

function loadDrafts(): Record<string, Draft> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function initialState(): State {
  return {
    tasks: seedTasks(),
    projects: PROJECTS,
    now: NOW,
    view: "tasks",
    project: "all",
    sel: "t-9f21",
    scope: {},
    step: {},
    drafts: loadDrafts(),
    editing: null,
    modal: null,
    toast: null,
    // 実際の取得・購読の配線は Task 11 でここに入る
    conn: { status: "connecting" },
  };
}

const Ctx = createContext<{ s: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reduce, undefined, initialState);

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
