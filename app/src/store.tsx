import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  connectionStatus,
  loadDrafts,
  onConnection,
  onDaemonEvent,
  rpc,
  saveDrafts,
} from "./daemon/client";
import { receiveGuide } from "./guide";
import { buildDiff } from "./patch";
import {
  contextOf,
  diffOf,
  genOf,
  guideOf,
  reduce,
  scopeOf,
  selectedTask,
  toProject,
  toRateLimitWindow,
  toTask,
  type Action,
  type State,
} from "./model";
import { createRefreshGate } from "./refreshGate";
import { settleListeners } from "./settleListeners";

/** 取りこぼしを吸収する保険。dctl add で作られた queued はイベントが飛ばない */
const REFRESH_MS = 15_000;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function initialState(): State {
  return {
    tasks: [],
    projects: [],
    detail: {},
    logs: {},
    limits: {},
    now: Date.now(),
    view: "tasks",
    project: "all",
    sel: null,
    scope: {},
    step: {},
    diffs: {},
    contexts: {},
    guides: {},
    gen: {},
    drafts: {},
    draftsLoaded: false,
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
  const [refreshGate] = useState(() => createRefreshGate());

  useEffect(() => {
    let alive = true;
    let unlisteners: (() => void)[] = [];
    // 接続中なのに取り直しが失敗している間だけ true。トーストは状態が変わった
    // 瞬間（失敗し始め）にしか出さない。15 秒ごとに毎回出すと連打になる
    let refreshFailing = false;

    async function refresh() {
      const token = refreshGate.begin();
      try {
        const [projects, tasks, samples] = await Promise.all([
          rpc("project.list", {}),
          rpc("task.list", {}),
          // ratelimit.sample は agent ステップが走っている間しか飛ばない。開いた直後に
          // 空欄にしないために DB の直近の行で埋める。これが落ちても一覧は出す
          rpc("ratelimit.recent", {}).catch(() => []),
        ]);
        if (!alive || !refreshGate.isLatest(token)) return;
        refreshFailing = false;
        dispatch({
          type: "limits.recent",
          samples: samples.map(toRateLimitWindow).filter((w) => w !== null),
        });
        // previous を渡さないと、stepRun.finished で立てた差し戻しの通知が
        // 15 秒ごとの取り直しのたびに消える
        const known = latest.current.tasks;
        dispatch({
          type: "sync",
          projects: projects.map(toProject),
          tasks: tasks.map((row) => toTask(row, projects, known.find((t) => t.id === row.id))),
          now: Date.now(),
        });
      } catch (e) {
        // 切断中は失敗して当然。理由はバナーが出している。
        // ただし接続中に失敗するのは、ソケットは開いているが dctld が固まっている
        // ような場合で、バナーは緑のまま何も知らせない。ここでだけ表に出す。
        // isLatest を条件にしないのは、固まっている間は 15 秒ごとの新しい取り直しが
        // 常に古い方を追い越して「最新ではない」ままになり、トーストが一生出なくなるため。
        if (alive && !refreshFailing && latest.current.conn.status === "connected") {
          refreshFailing = true;
          const message = e instanceof Error ? e.message : String(e);
          dispatch({
            type: "toast",
            message: `一覧を取り直せません（${message}）。dctld が固まっている可能性があります。dctld を再起動してください`,
          });
        }
      }
    }

    async function subscribe() {
      // 先に購読を張り終える。状態の問い合わせを先にすると、その隙間に起きた
      // 接続の変化を取りこぼす
      const { registered, failedCount } = await settleListeners([
        onConnection((conn) => {
          dispatch({ type: "connection", conn });
          // 再接続したら取り直す。これがイベントの取りこぼしを吸収する
          if (conn.status === "connected") void refresh();
        }),
        onDaemonEvent((ev) => {
          // ratelimit.sample のように task_id を持たないイベントがあるので、
          // この絞り込みが要る（型の絞り込みとしても load-bearing）。
          // 知らない task_id のイベントは、まだ持っていないタスクが動いたということ。
          // reducer は純関数で取得できないので、ここで取り直す。
          if ("task_id" in ev && !latest.current.tasks.some((t) => t.id === ev.task_id)) {
            void refresh();
            return;
          }
          dispatch({ type: "daemon", ev, now: Date.now() });
        }),
      ]);
      if (!alive) {
        for (const off of registered) off();
        return;
      }
      // 片方だけ失敗しても、登録できたぶんは必ず後片付けの対象にする。
      // 取りこぼしても 15 秒の取り直しが拾うので、ここで止めはしない
      unlisteners = registered;
      if (failedCount > 0) {
        dispatch({
          type: "toast",
          message: "イベントの購読に失敗しました。15秒ごとの取り直しだけで動きます",
        });
      }

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

  // 起動時に1度だけ読む
  useEffect(() => {
    let alive = true;
    void loadDrafts().then(
      (drafts) => {
        if (alive) dispatch({ type: "drafts.loaded", drafts });
      },
      (e) => {
        // 読めなくてもレビューは続けられる。ただし「前に書いた下書きが出てこない」
        // 理由が分からないと不審なので、その場で伝える
        if (!alive) return;
        console.warn("下書きを読めませんでした", e);
        dispatch({ type: "drafts.loaded", drafts: {} });
        dispatch({ type: "toast", message: `下書きを読めませんでした（${errorMessage(e)}）` });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // 読み終える前に書くと、まだ空の drafts でファイルを潰してしまう
    if (!s.draftsLoaded) return;
    void saveDrafts(s.drafts).catch((e) => console.warn("下書きを保存できませんでした", e));
  }, [s.drafts, s.draftsLoaded]);

  // レビュー画面が要る diff と経緯を取る。選ばれていて、まだ取っていないものだけ。
  // worktree は suspended の間は凍っているので、15 秒ごとの取り直しには乗せない
  // （2 MiB の git diff を定期的に走らせる意味が無い）。取り直しが要るのは
  // 状態が動いたときで、そのとき reducer が捨てて gen を上げる。
  const reviewing = (() => {
    const t = selectedTask(s);
    return t && t.state === "suspended" ? t.id : null;
  })();
  const scope = reviewing ? scopeOf(s, reviewing) : "all";
  const needDiff = reviewing !== null && diffOf(s, reviewing, scope) === undefined;
  const needContext = reviewing !== null && contextOf(s, reviewing) === undefined;
  const needGuide = reviewing !== null && guideOf(s, reviewing) === undefined;
  const gen = reviewing ? genOf(s, reviewing) : 0;

  useEffect(() => {
    if (!reviewing || !needDiff) return;
    const id = reviewing;
    dispatch({ type: "diff", id, scope, gen, loaded: { kind: "loading" } });
    void rpc("task.diff", scope === "since" ? { task_id: id, since: "last_review" } : { task_id: id })
      .then((meta) => {
        // patch の組み立てもここで済ませる。壊れた patch は取得の失敗と同じ扱いでよい
        const value = { meta, files: buildDiff(meta) };
        dispatch({ type: "diff", id, scope, gen, loaded: { kind: "ok", value } });
      })
      .catch((e) => {
        dispatch({ type: "diff", id, scope, gen, loaded: { kind: "error", message: errorMessage(e) } });
      });
  }, [reviewing, scope, needDiff, gen]);

  useEffect(() => {
    if (!reviewing || !needContext) return;
    const id = reviewing;
    dispatch({ type: "context", id, gen, loaded: { kind: "loading" } });
    void rpc("task.context", { task_id: id })
      .then((value) => dispatch({ type: "context", id, gen, loaded: { kind: "ok", value } }))
      .catch((e) =>
        dispatch({ type: "context", id, gen, loaded: { kind: "error", message: errorMessage(e) } })
      );
  }, [reviewing, needContext, gen]);

  useEffect(() => {
    if (!reviewing || !needGuide) return;
    const id = reviewing;
    dispatch({ type: "guide", id, gen, loaded: { kind: "loading" } });
    // diff とは別の要求なので、ガイドが取れなくても diff は読める
    void rpc("task.guide", { task_id: id })
      .then((res) => dispatch({ type: "guide", id, gen, loaded: { kind: "ok", value: receiveGuide(res) } }))
      .catch((e) =>
        dispatch({ type: "guide", id, gen, loaded: { kind: "error", message: errorMessage(e) } })
      );
  }, [reviewing, needGuide, gen]);

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

/**
 * 判断をデーモンへ送る。画面の状態はここで書き換えない。
 * デーモンが決めた結果は task.stateChanged と取り直しで返ってくる。
 *
 * Promise を呼び出し側に返す（ここでは catch しない）。呼び出し側
 * （ReviewView / RejectModal / TaskView）は decision.ts の `sendDecision` で
 * 成否を判定し、成功したときだけ approve / reject.confirm / cancel を
 * dispatch する。下書きの破棄は「送れた」ときにしか起きてはいけないので、
 * ここで失敗を握って消してしまうと下書きが復元できなくなる。
 */
export function useDecide() {
  return {
    approve: (taskId: string) => rpc("task.approve", { task_id: taskId }),
    reject: (taskId: string, comment: string) => rpc("task.reject", { task_id: taskId, comment }),
    cancel: (taskId: string) => rpc("task.cancel", { task_id: taskId }),
  };
}

/** 第2段階に回した操作のボタンが押されたときに出す */
export function useNotYet() {
  const { dispatch } = useStore();
  return (message: string) => dispatch({ type: "toast", message });
}
