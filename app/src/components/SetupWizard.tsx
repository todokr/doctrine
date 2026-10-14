import { useState, type ReactNode } from "react";
import { pickDirectory, rpc } from "../daemon/client";
import { trackerGuidance } from "../intake";
import { useStore } from "../store";
import {
  blocker,
  initialWizard,
  next,
  prev,
  submitWizard,
  withDetection,
  type WizardState,
  type WizardStep,
} from "../wizard";
import { ISSUE_PHASES, type IssuePhase } from "../../../shared/intake/tracker.ts";
import type { TrackerConfig } from "../../../shared/protocol.ts";

const STEP_WORD: Record<WizardStep, string> = {
  welcome: "ようこそ",
  directory: "ディレクトリ",
  projects: "プロジェクト構成",
  tracker: "トラッカー",
  confirm: "確認",
};

const PHASE_WORD: Record<IssuePhase, string> = {
  todo: "着手前（todo）",
  inProgress: "作業中（inProgress）",
  inReview: "レビュー中（inReview）",
};

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const trackerWord = (t: TrackerConfig) => (t.kind === "github" ? "GitHub Issues" : `Linear（チーム ${t.team}）`);

function Welcome() {
  return (
    <>
      <p>doctrine で作業するディレクトリを workspace として登録します。</p>
      <p className="hint">
        まだ <span className="mono">.doctrine/</span> が無いプロジェクトには、ワークフローの雛形
        （<span className="mono">.doctrine/workflows/default.yaml</span>）を置きます。リポジトリに合わせて直してから使ってください。
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
  const g = trackerGuidance({ reason: "no_api_key", message: "" }, s.path ?? "");
  return (
    <>
      <p>Issue をどこから取り込むかを選んでください。後から設定しても構いません。</p>
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

function Confirm({ s }: { s: WizardState }) {
  const selected = s.projects.filter((p) => p.selected);
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
      </dl>
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
      await submitWizard(s);
      await refresh();
      dispatch({ type: "wizard.done", toast: "workspace を登録しました" });
    } catch (e) {
      setS((x) => ({ ...x, error: `登録できませんでした: ${errorMessage(e)}` }));
    } finally {
      setPending(false);
    }
  }

  // 確認画面の失敗は、そこを離れたら消す
  const go = (step: WizardStep) => setS((x) => ({ ...x, step, error: x.step === "confirm" ? null : x.error }));

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
