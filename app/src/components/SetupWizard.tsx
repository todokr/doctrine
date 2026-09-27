import { useState, type ReactNode } from "react";
import { pickDirectory, rpc } from "../daemon/client";
import { trackerGuidance } from "../intake";
import { useStore } from "../store";
import {
  MODEL_ROLES,
  blocker,
  initialWizard,
  next,
  policyQuestions,
  prev,
  submitWizard,
  withDetection,
  WorkspaceSetupError,
  type WizardState,
  type WizardStep,
} from "../wizard";
import { ISSUE_PHASES, type IssuePhase } from "../../../shared/intake/tracker.ts";
import type { SetupPolicy, TrackerConfig } from "../../../shared/protocol.ts";

const STEP_WORD: Record<WizardStep, string> = {
  welcome: "ようこそ",
  directory: "ディレクトリ",
  projects: "プロジェクト構成",
  tracker: "トラッカー",
  policy: "ワークフローの方針",
  confirm: "確認",
};

const PHASE_WORD: Record<IssuePhase, string> = {
  todo: "着手前（todo）",
  inProgress: "作業中（inProgress）",
  inReview: "レビュー中（inReview）",
};

const MODEL_SUGGESTIONS = ["claude-opus-5-5", "claude-sonnet-5"];

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const trackerWord = (t: TrackerConfig) => (t.kind === "github" ? "GitHub Issues" : `Linear（チーム ${t.team}）`);

function Welcome() {
  return (
    <>
      <p>
        doctrine で作業するディレクトリを workspace として登録し、プロジェクトごとのワークフロー
        （<span className="mono">.doctrine/workflows/default.yaml</span>）を作ります。
      </p>
      <p className="hint">
        ワークフローは、ここで選ぶ方針をもとに doctrine のタスク（setup）が各リポジトリを読んで書きます。
        書き上がると承認の画面で止まるので、中身を確かめてから承認してください。
      </p>
    </>
  );
}

function Directory({ s, pending, onPick }: { s: WizardState; pending: boolean; onPick: () => void }) {
  const d = s.detection;
  return (
    <>
      <p>
        git リポジトリのルートか、複数の git リポジトリを直下に持つディレクトリを選んでください。
      </p>
      <div className="actions">
        <button className="btn" disabled={pending} onClick={onPick}>ディレクトリを選ぶ</button>
        {s.path && <span className="mono">{s.path}</span>}
      </div>
      {d && !d.alreadyRegistered && (
        <p className="hint">
          {d.existing
            ? "workspace.yaml があります。その内容で登録します。"
            : d.isRepoRoot
            ? "git リポジトリのルートです。このリポジトリを 1 つのプロジェクトとして登録します。"
            : d.repositories.length > 0
            ? `直下に git リポジトリが ${d.repositories.length} 個あります。`
            : null}
        </p>
      )}
    </>
  );
}

function Projects({ s, onChange }: { s: WizardState; onChange: (s: WizardState) => void }) {
  const d = s.detection;
  if (d?.existing || d?.isRepoRoot) {
    return (
      <>
        <p>
          {d.existing
            ? "workspace.yaml に書かれたプロジェクトをそのまま登録します。"
            : "このリポジトリを 1 つのプロジェクトとして登録します。"}
        </p>
        <ul className="wz-list">
          {s.projects.map((p) => (
            <li key={p.name}><b>{p.name}</b> <span className="mono hint">{p.dir}</span></li>
          ))}
        </ul>
      </>
    );
  }
  const edit = (i: number, patch: Partial<WizardState["projects"][number]>) =>
    onChange({ ...s, projects: s.projects.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <>
      <p>登録するリポジトリを選び、プロジェクトの名前を決めてください。名前は英小文字・数字・ハイフンで書きます。</p>
      <div className="wz-repos">
        {s.projects.map((p, i) => (
          <div className="wz-repo" key={p.dir}>
            <label>
              <input type="checkbox" checked={p.selected} onChange={(e) => edit(i, { selected: e.target.checked })} />
              <span className="mono">{p.dir}</span>
            </label>
            <input
              type="text"
              aria-label={`${p.dir} のプロジェクト名`}
              value={p.name}
              disabled={!p.selected}
              onChange={(e) => edit(i, { name: e.target.value })}
            />
          </div>
        ))}
      </div>
    </>
  );
}

function Tracker({ s, onChange }: { s: WizardState; onChange: (s: WizardState) => void }) {
  const t = s.tracker;
  const setTracker = (tracker: TrackerConfig) => onChange({ ...s, tracker });
  const setState = (phase: IssuePhase, value: string) => {
    if (t.kind !== "linear") return;
    const states = { ...t.states };
    if (value.trim() === "") delete states[phase];
    else states[phase] = value;
    setTracker({ kind: "linear", team: t.team, ...(Object.keys(states).length ? { states } : {}) });
  };
  const g = trackerGuidance({ ok: false, reason: "no_api_key", message: "" });
  return (
    <>
      <p>Issue をどこから取り込むかを選んでください。setup のタスクはトラッカーを使わないので、後から設定しても構いません。</p>
      <div className="wz-choices">
        <label>
          <input type="radio" name="wz-tracker" checked={t.kind === "github"} onChange={() => setTracker({ kind: "github" })} />
          GitHub Issues
        </label>
        <label>
          <input
            type="radio"
            name="wz-tracker"
            checked={t.kind === "linear"}
            onChange={() => setTracker({ kind: "linear", team: "" })}
          />
          Linear
        </label>
      </div>
      {t.kind === "linear" && (
        <>
          <div className="settings-field">
            <label className="hint" htmlFor="wz-team">チームのキー（例 ENG）</label>
            <input
              type="text"
              id="wz-team"
              value={t.team}
              onChange={(e) => setTracker({ ...t, team: e.target.value })}
            />
          </div>
          <p className="hint">状態の名前は、Linear の既定と違うときだけ書いてください。</p>
          {ISSUE_PHASES.map((phase) => (
            <div className="settings-field" key={phase}>
              <label className="hint" htmlFor={`wz-state-${phase}`}>{PHASE_WORD[phase]}</label>
              <input
                type="text"
                id={`wz-state-${phase}`}
                value={t.states?.[phase] ?? ""}
                onChange={(e) => setState(phase, e.target.value)}
              />
            </div>
          ))}
          <div className="box attn">
            <h2>Linear の API key はここでは扱いません</h2>
            <p>{g.fix}</p>
            {g.command && <p><span className="mono">{g.command}</span></p>}
          </div>
        </>
      )}
    </>
  );
}

function Policy({ s, onChange }: { s: WizardState; onChange: (s: WizardState) => void }) {
  const set = (policy: SetupPolicy) => onChange({ ...s, policy });
  return (
    <>
      <p>
        workspace のすべてのプロジェクトに共通の方針です。検証コマンドや baseBranch のようにプロジェクトごとに違うことは、
        setup のタスクがリポジトリを読んで決めます。
      </p>
      {policyQuestions(s.policy).map((q) => (
        <fieldset className="wz-q" key={q.key}>
          <legend>{q.label}</legend>
          {q.key === "models"
            ? (
              <div className="wz-models">
                {MODEL_ROLES.map((r) => (
                  <label key={r.key}>
                    <span className="hint">{r.label}</span>
                    <input
                      type="text"
                      list="wz-model-suggestions"
                      value={s.policy.models[r.key]}
                      onChange={(e) => set({ ...s.policy, models: { ...s.policy.models, [r.key]: e.target.value } })}
                    />
                  </label>
                ))}
                <datalist id="wz-model-suggestions">
                  {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
                </datalist>
              </div>
            )
            : (
              <div className="wz-choices">
                {q.options.map((o) => (
                  <label key={o.label}>
                    <input
                      type="radio"
                      name={`wz-${q.key}`}
                      checked={s.policy[q.key] === o.value}
                      onChange={() => set({ ...s.policy, [q.key]: o.value })}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
        </fieldset>
      ))}
    </>
  );
}

function Confirm({ s }: { s: WizardState }) {
  const selected = s.projects.filter((p) => p.selected);
  const answers = policyQuestions(s.policy).flatMap((q) => {
    if (q.key === "models") {
      return [[q.label, MODEL_ROLES.map((r) => `${r.label} ${s.policy.models[r.key]}`).join(" / ")]];
    }
    const chosen = q.options.find((o) => o.value === s.policy[q.key]);
    return [[q.label, chosen?.label ?? ""]];
  });
  return (
    <>
      <dl className="wf-props">
        <Row label="ディレクトリ"><span className="mono">{s.path}</span></Row>
        <Row label="プロジェクト">
          {selected.map((p) => (
            <div key={p.name}><b>{p.name}</b> <span className="mono hint">{p.dir}</span></div>
          ))}
        </Row>
        <Row label="トラッカー">{trackerWord(s.tracker)}</Row>
        {answers.map(([label, value]) => <Row key={label} label={label}>{value}</Row>)}
      </dl>
      <p className="hint">
        登録すると、まだ <span className="mono">.doctrine/</span> が無く、今回ワークフローの雛形を作ったプロジェクトごとに
        setup のタスクを 1 つ作ります。<span className="mono">.doctrine/</span> が既にあるプロジェクトのワークフローには触りません。
      </p>
      {s.error && <div className="box danger"><p>{s.error}</p></div>}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * workspace.add は通り、workspace.setup が落ちた後の画面。workspace は登録済みなので、
 * 戻って登録し直す道は出さない。閉じるまで理由を出し続ける
 */
export function SetupFailedScreen({ message, onDone }: { message: string; onDone: () => void }) {
  return (
    <div className="wizard">
      <div className="wz-panel">
        <h1>setup のタスクを作れませんでした</h1>
        <p>workspace は登録しました。ワークフローを作るタスクだけが作れませんでした。</p>
        <div className="box danger"><p>{message}</p></div>
        <p>
          各プロジェクトには雛形の <span className="mono">.doctrine/workflows/default.yaml</span> が置かれています。
          タスク画面から手でワークフローを直してください。
        </p>
        <div className="actions">
          <button className="btn primary" onClick={onDone}>タスク一覧へ</button>
        </div>
      </div>
    </div>
  );
}

/** props だけで描く。テストはこちらを描く */
export function WizardScreen(props: {
  s: WizardState;
  closable: boolean;
  pending: boolean;
  onChange: (s: WizardState) => void;
  onPick: () => void;
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { s, pending, onChange } = props;
  const reason = blocker(s);
  const steps = (Object.keys(STEP_WORD) as WizardStep[]).filter((k) => k !== "tracker" || !s.detection?.existing);
  return (
    <div className="wizard">
      <div className="wz-panel">
        <div className="headrow">
          <ol className="wz-steps">
            {steps.map((k) => <li key={k} aria-current={k === s.step ? "step" : undefined}>{STEP_WORD[k]}</li>)}
          </ol>
          <span className="spacer" />
          {props.closable && <button className="btn sm" onClick={props.onClose}>閉じる</button>}
        </div>
        <h1>{s.step === "welcome" ? "doctrine をはじめる" : STEP_WORD[s.step]}</h1>
        {s.step === "welcome" && <Welcome />}
        {s.step === "directory" && <Directory s={s} pending={pending} onPick={props.onPick} />}
        {s.step === "projects" && <Projects s={s} onChange={onChange} />}
        {s.step === "tracker" && <Tracker s={s} onChange={onChange} />}
        {s.step === "policy" && <Policy s={s} onChange={onChange} />}
        {s.step === "confirm" && <Confirm s={s} />}
        {reason && <p className="hint error">{reason}</p>}
        <div className="actions">
          {s.step !== "welcome" && <button className="btn" disabled={pending} onClick={props.onBack}>戻る</button>}
          {s.step === "confirm"
            ? <button className="btn primary" disabled={pending} onClick={props.onSubmit}>登録する</button>
            : <button className="btn primary" disabled={pending || reason !== null} onClick={props.onNext}>次へ</button>}
        </div>
      </div>
    </div>
  );
}

export function SetupWizard({ closable }: { closable: boolean }) {
  const { dispatch, refresh } = useStore();
  const [s, setS] = useState(initialWizard);
  const [pending, setPending] = useState(false);
  // workspace.setup が落ちた理由。null でなければ SetupFailedScreen を出す
  const [setupFailed, setSetupFailed] = useState<string | null>(null);

  async function pick() {
    let path: string | null;
    try {
      path = await pickDirectory();
    } catch (e) {
      setS((x) => ({ ...x, error: `ディレクトリを選べませんでした（${errorMessage(e)}）` }));
      return;
    }
    if (path === null) return;
    const picked = path;
    setS((x) => ({ ...x, path: picked, detection: null, projects: [], error: null }));
    setPending(true);
    try {
      const detection = await rpc("workspace.detect", { path: picked });
      setS((x) => withDetection(x, picked, detection));
    } catch (e) {
      setS((x) => ({ ...x, error: errorMessage(e) }));
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    setPending(true);
    try {
      const { tasks } = await submitWizard(s);
      await refresh();
      dispatch({
        type: "wizard.done",
        id: tasks[0]?.id ?? null,
        toast: tasks.length > 0 ? `setup のタスクを ${tasks.length} 件作りました` : "ワークフローは既存のものを使います",
      });
    } catch (e) {
      if (e instanceof WorkspaceSetupError) {
        await refresh();
        setSetupFailed(e.message);
        return;
      }
      setS((x) => ({ ...x, error: `登録できませんでした: ${errorMessage(e)}` }));
    } finally {
      setPending(false);
    }
  }

  // 確認画面の失敗は、そこを離れたら消す
  const go = (step: WizardStep) => setS((x) => ({ ...x, step, error: x.step === "confirm" ? null : x.error }));

  if (setupFailed !== null) {
    return <SetupFailedScreen message={setupFailed} onDone={() => dispatch({ type: "wizard.done", id: null, toast: null })} />;
  }

  return (
    <WizardScreen
      s={s}
      closable={closable}
      pending={pending}
      onChange={setS}
      onPick={() => void pick()}
      onNext={() => go(next(s))}
      onBack={() => go(prev(s))}
      onSubmit={() => void submit()}
      onClose={() => dispatch({ type: "wizard.close" })}
    />
  );
}
