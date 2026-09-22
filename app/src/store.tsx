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
  loadSettings,
  onConnection,
  onDaemonEvent,
  rpc,
  saveDrafts,
} from "./daemon/client";
import { receiveGuide } from "./guide";
import { buildDiff } from "./patch";
import type { GhStatus, IssueDetail } from "../../shared/intake/github.ts";
import type { Answer } from "../../shared/intake/question.ts";
import type {
  GithubIssue,
  IntakeDetail,
  IntakeSummary,
  NewComment,
  PfdDraft,
  Warning,
  WorktreeEntry,
} from "../../shared/protocol.ts";
import {
  contextOf,
  diffOf,
  genOf,
  guideOf,
  intakeDetailOf,
  intakeGenOf,
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
    layout: {},
    diffs: {},
    contexts: {},
    guides: {},
    gen: {},
    intakes: [],
    intakeSel: null,
    showClosedIntakes: false,
    intakeDetails: {},
    intakeGen: {},
    intakeRevise: null,
    drafts: {},
    intakeDrafts: {},
    draftsLoaded: false,
    editing: null,
    modal: null,
    toast: null,
    conn: { status: "connecting" },
    worktrees: [],
    warnings: [],
    staleDays: null,
    removing: null,
  };
}

const Ctx = createContext<{ s: State; dispatch: Dispatch<Action>; refresh: () => Promise<void> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reduce, undefined, initialState);
  // イベントのハンドラから最新の state を見るため（購読は1回しか張らない）
  const latest = useRef(s);
  latest.current = s;
  // 取り直しは同時に何本も走る（イベント・15秒・再接続）。古い応答が
  // 新しい応答の後に届くと、画面が一度古い状態に巻き戻る。
  // 最後に始めた1本だけが反映してよい（ロジック自体は refreshGate.ts でテスト済み）
  const [refreshGate] = useState(() => createRefreshGate());
  // 購読の effect の中で作る refresh を、外の effect からも呼べるようにする
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisteners: (() => void)[] = [];
    // 接続中なのに取り直しが失敗している間だけ true。トーストは状態が変わった
    // 瞬間（失敗し始め）にしか出さない。15 秒ごとに毎回出すと連打になる
    let refreshFailing = false;

    async function refresh() {
      const token = refreshGate.begin();
      try {
        const [projects, tasks, samples, intakes] = await Promise.all([
          rpc("project.list", {}),
          rpc("task.list", {}),
          // ratelimit.sample は agent ステップが走っている間しか飛ばない。開いた直後に
          // 空欄にしないために DB の直近の行で埋める。これが落ちても一覧は出す
          rpc("ratelimit.recent", {}).catch(() => []),
          // 「すべて」で出した終了分を取り直しで消さないよう、今の切り替えを渡す。
          // これが落ちてもタスクの一覧は出す。落ちたときは null にして、前の一覧と
          // Intake の下書きを残す（空の一覧で sync すると下書きが全部消える）
          rpc("intake.list", { include_closed: latest.current.showClosedIntakes }).catch(
            (): IntakeSummary[] | null => null,
          ),
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
        if (intakes) dispatch({ type: "intakes.sync", intakes });

        // worktree.list は worktree ごとに git status を回す（重い）ので、タスク一覧の
        // 反映をそれに待たせないよう別の Promise.all で取る。
        // アイコンの点はビューを開いていなくても要るので取り直しに乗せる
        const [worktreeList, warningList] = await Promise.all([
          rpc("worktree.list", {}).catch((): WorktreeEntry[] | null => null),
          rpc("daemon.warnings", {}).catch((): Warning[] | null => null),
        ]);
        if (!alive || !refreshGate.isLatest(token)) return;
        if (worktreeList || warningList) {
          dispatch({
            type: "worktrees.sync",
            worktrees: worktreeList ?? latest.current.worktrees,
            warnings: warningList,
          });
        }
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
          if ("intake_id" in ev) {
            // dctl から始めた Intake は、まだ一覧に無い
            if (!latest.current.intakes.some((i) => i.id === ev.intake_id)) {
              void refresh();
              return;
            }
            dispatch({ type: "daemon", ev, now: Date.now() });
            // needs_human と progress はイベントに載らないので、一覧を取り直す
            // intake_id を持つイベントは stateChanged と updated だけ。あなたの番が生じた・完了を記録したのは updated で届く
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

    refreshRef.current = refresh;
    void subscribe();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    return () => {
      alive = false;
      refreshRef.current = null;
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
        dispatch({ type: "drafts.loaded", drafts: { tasks: {}, intakes: {} } });
        dispatch({ type: "toast", message: `下書きを読めませんでした（${errorMessage(e)}）` });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // 起動時に1度読む。設定画面ができたときに開き直せば反映されるよう、
  // worktrees のビューを開いたときにも読み直す
  useEffect(() => {
    let alive = true;
    void loadSettings().then(
      (settings) => {
        if (alive) dispatch({ type: "settings.loaded", staleDays: settings.staleDays });
      },
      (e) => {
        if (!alive) return;
        dispatch({ type: "settings.loaded", staleDays: null });
        dispatch({ type: "toast", message: `設定を読めませんでした（${errorMessage(e)}）` });
      },
    );
    return () => {
      alive = false;
    };
  }, [s.view === "worktrees"]);

  useEffect(() => {
    // 読み終える前に書くと、まだ空の drafts でファイルを潰してしまう
    if (!s.draftsLoaded) return;
    void saveDrafts({ tasks: s.drafts, intakes: s.intakeDrafts }).catch((e) =>
      console.warn("下書きを保存できませんでした", e)
    );
  }, [s.drafts, s.intakeDrafts, s.draftsLoaded]);

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

  // 「すべて」の切り替えは、次の 15 秒を待たずに取り直す
  useEffect(() => {
    void refreshRef.current?.();
  }, [s.showClosedIntakes]);

  // 開いている Intake の詳細。選ばれていて、まだ取っていないものだけ
  const intakeId = s.view === "intake" && s.intakeSel !== "new" ? s.intakeSel : null;
  const needIntake = intakeId !== null && intakeDetailOf(s, intakeId) === undefined;
  const intakeGen = intakeId ? intakeGenOf(s, intakeId) : 0;

  useEffect(() => {
    if (!intakeId || !needIntake) return;
    const id = intakeId;
    dispatch({ type: "intake.detail", id, gen: intakeGen, loaded: { kind: "loading" } });
    void rpc("intake.get", { intake_id: id })
      .then((value) =>
        dispatch({ type: "intake.detail", id, gen: intakeGen, loaded: { kind: "ok", value } })
      )
      .catch((e) =>
        dispatch({
          type: "intake.detail",
          id,
          gen: intakeGen,
          loaded: { kind: "error", message: errorMessage(e) },
        })
      );
  }, [intakeId, needIntake, intakeGen]);

  useEffect(() => {
    if (!s.toast) return;
    const h = setTimeout(() => dispatch({ type: "toast", message: null }), 2600);
    return () => clearTimeout(h);
  }, [s.toast]);

  const refresh = () => refreshRef.current?.() ?? Promise.resolve();

  return <Ctx.Provider value={{ s, dispatch, refresh }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("StoreProvider の外で useStore を呼んでいます");
  return v;
}

/** 部品から明示的に一覧を取り直す（例: worktree の削除の後）。購読の effect の外からも呼べる */
export function useRefresh(): () => Promise<void> {
  const v = useContext(Ctx);
  if (!v) throw new Error("StoreProvider の外で useRefresh を呼んでいます");
  return v.refresh;
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
    pause: (taskId: string) => rpc("task.pause", { task_id: taskId }),
    resume: (taskId: string) => rpc("task.resume", { task_id: taskId }),
    // 確認ダイアログを経た後しか呼ばないので、常に force を付ける
    removeWorktree: (path: string) => rpc("worktree.remove", { path, force: true }),
  };
}

/**
 * Issue の選択で使う RPC。useDecide と同じく、ここでは catch しない。
 * projectPath は Project.path（表示名ではない）
 */
export function useIntakeRpc() {
  return {
    ghStatus: (projectPath: string): Promise<GhStatus> =>
      rpc("github.status", { project: projectPath }),
    issues: (
      projectPath: string,
      o: { assignee: "me" | "any"; search?: string },
    ): Promise<GithubIssue[]> =>
      rpc("github.issues", {
        project: projectPath,
        assignee: o.assignee,
        ...(o.search ? { search: o.search } : {}),
      }),
    issue: (projectPath: string, url: string): Promise<IssueDetail> =>
      rpc("github.issue", { project: projectPath, url }),
    start: (
      projectPath: string,
      issueUrl: string,
    ): Promise<IntakeSummary & { alreadyActive: boolean }> =>
      rpc("intake.start", { project: projectPath, issue_url: issueUrl }),
    answer: (intakeId: string, questionSetId: number, answers: Answer[]): Promise<IntakeSummary> =>
      rpc("intake.answer", { intake_id: intakeId, question_set_id: questionSetId, answers }),
    reject: (intakeId: string, draftId: number, comments: NewComment[]): Promise<IntakeSummary> =>
      rpc("intake.reject", { intake_id: intakeId, draft_id: draftId, comments }),
    approve: (intakeId: string, draftId: number, hash: string): Promise<IntakeSummary> =>
      rpc("intake.approve", { intake_id: intakeId, draft_id: draftId, hash }),
    draft: (intakeId: string, draftId: number): Promise<PfdDraft> =>
      rpc("intake.draft", { intake_id: intakeId, draft_id: draftId }),
    processPrompt: async (intakeId: string, draftId: number, processId: string): Promise<string> =>
      (await rpc("intake.processPrompt", {
        intake_id: intakeId,
        draft_id: draftId,
        process_id: processId,
      })).prompt,
    revise: (intakeId: string, comments: NewComment[]): Promise<IntakeSummary> =>
      rpc("intake.revise", { intake_id: intakeId, comments }),
    abandonRevision: (intakeId: string): Promise<IntakeSummary> =>
      rpc("intake.abandonRevision", { intake_id: intakeId }),
    cancel: (intakeId: string, mode: "leave" | "stop"): Promise<IntakeSummary> =>
      rpc("intake.cancel", { intake_id: intakeId, mode }),
    completeHumanProcess: (intakeId: string, processId: string, note: string): Promise<IntakeDetail> =>
      rpc("intake.completeHumanProcess", { intake_id: intakeId, process_id: processId, note }),
    redispatch: (intakeId: string, processId: string): Promise<IntakeDetail> =>
      rpc("intake.redispatch", { intake_id: intakeId, process_id: processId }),
    refresh: (intakeId: string): Promise<IntakeDetail> => rpc("intake.refresh", { intake_id: intakeId }),
    setDispatchPaused: (intakeId: string, paused: boolean): Promise<IntakeSummary> =>
      rpc("intake.setDispatchPaused", { intake_id: intakeId, paused }),
    closeIssue: (intakeId: string): Promise<IntakeSummary> => rpc("intake.closeIssue", { intake_id: intakeId }),
  };
}

/** 第2段階に回した操作のボタンが押されたときに出す */
export function useNotYet() {
  const { dispatch } = useStore();
  return (message: string) => dispatch({ type: "toast", message });
}
