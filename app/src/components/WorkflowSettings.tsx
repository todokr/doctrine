import { useEffect, useRef, useState } from "react";
import type { WorkflowDetail, WorkflowListEntry, WorkflowStepChange, WorkflowStepDetail } from "../../../shared/protocol.ts";
import { rpc } from "../daemon/client";
import type { Loaded } from "../model";
import { useStore, useWorkflowRpc, type WorkflowRpc } from "../store";
import {
  assignSaveIssues,
  checkStepForm,
  TEMPLATE_VARIABLES,
  toStepForm,
  type StepFieldKey,
  type StepForm,
  type StepSaveErrors,
} from "../workflowEdit";
import { WorkflowDefinitionRail } from "./WorkflowRail";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** props だけで描く。検証に落ちたものは選べず、issues を出す */
export function WorkflowList(props: {
  entries: WorkflowListEntry[];
  defaultName: string | null;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const { entries, defaultName, selected, onSelect } = props;
  if (entries.length === 0) {
    return <p className="hint">.doctrine/workflows にワークフローがありません</p>;
  }
  return (
    <div className="wf-list">
      {entries.map((e) => (
        <div key={e.name}>
          <button
            type="button"
            aria-pressed={selected === e.name}
            disabled={!e.ok}
            onClick={() => onSelect(e.name)}
          >
            {e.name}
            {e.name === defaultName && "（既定）"}
          </button>
          {!e.ok && e.issues.map((issue, i) => <p key={i} className="hint error">{issue}</p>)}
        </div>
      ))}
    </div>
  );
}

const BRANCH_HEADING: Record<WorkflowStepDetail["type"], string> = {
  approval: "onReject",
  command: "onFailure",
  agent: "onFailure",
  guide: "onFailure",
};

/** props だけで描く。テンプレート変数の手引き（core/src/workflow/template.ts が受け付けるもの） */
export function TemplateVarsHint(props: { stepIds: string[] }): React.JSX.Element {
  return (
    <details className="vars">
      <summary>使える変数</summary>
      <ul>
        {TEMPLATE_VARIABLES.map((v) => (
          <li key={v.name}>
            <code>{v.name}</code> {v.note}
          </li>
        ))}
      </ul>
      <p className="hint">このワークフローのステップ id: {props.stepIds.join(", ")}</p>
    </details>
  );
}

function stepHasTemplateField(step: WorkflowStepDetail): boolean {
  return step.type === "agent" || step.type === "command" || step.branch !== null;
}

/** props だけで描く。1 ステップの入力欄と保存。テストはこちらを描く */
export function StepFields(props: {
  step: WorkflowStepDetail;
  form: StepForm;
  stepIds: string[];
  saveErrors: StepSaveErrors;
  saved: boolean;
  warnings: string[];
  pending: boolean;
  onChange: (form: StepForm) => void;
  onSave: () => void;
}): React.JSX.Element {
  const { step, form, stepIds, saveErrors, saved, warnings, pending, onChange, onSave } = props;
  const check = checkStepForm(step, form);
  const inputErrors = check.ok ? {} : check.errors;
  const fieldError = (key: StepFieldKey) => inputErrors[key] ?? saveErrors.fields[key];
  const branch = form.branch;

  return (
    <div className="wf-edit">
      <h3 className="mono">{step.id}</h3>
      <p className="hint">{step.type}</p>

      {step.type === "agent" && (
        <>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-prompt">prompt</label>
            <textarea
              id="wf-edit-prompt"
              value={form.prompt}
              onChange={(e) => onChange({ ...form, prompt: e.target.value })}
            />
            {fieldError("prompt") && <p className="hint error">{fieldError("prompt")}</p>}
          </div>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-model">model</label>
            <input
              type="text"
              id="wf-edit-model"
              value={form.model}
              onChange={(e) => onChange({ ...form, model: e.target.value })}
            />
            <p className="hint">空にすると指定を消します</p>
            {fieldError("model") && <p className="hint error">{fieldError("model")}</p>}
          </div>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-permission-mode">permissionMode</label>
            <input
              type="text"
              id="wf-edit-permission-mode"
              value={form.permissionMode}
              onChange={(e) => onChange({ ...form, permissionMode: e.target.value })}
            />
            {fieldError("permissionMode") && <p className="hint error">{fieldError("permissionMode")}</p>}
          </div>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-session">session</label>
            <input
              type="text"
              id="wf-edit-session"
              value={form.session}
              onChange={(e) => onChange({ ...form, session: e.target.value })}
            />
            {fieldError("session") && <p className="hint error">{fieldError("session")}</p>}
          </div>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-allowed-tools">allowedTools</label>
            <textarea
              id="wf-edit-allowed-tools"
              value={form.allowedTools}
              onChange={(e) => onChange({ ...form, allowedTools: e.target.value })}
            />
            <p className="hint">1 行に 1 つ。空にすると指定を消します</p>
            {fieldError("allowedTools") && <p className="hint error">{fieldError("allowedTools")}</p>}
          </div>
        </>
      )}

      {step.type === "command" && (
        <div className="settings-field">
          <label className="hint" htmlFor="wf-edit-run">run</label>
          <textarea
            id="wf-edit-run"
            value={form.run}
            onChange={(e) => onChange({ ...form, run: e.target.value })}
          />
          {fieldError("run") && <p className="hint error">{fieldError("run")}</p>}
        </div>
      )}

      {step.type === "approval" && (
        <>
          <dl className="wf-props">
            <dt>title</dt>
            <dd>{step.title}</dd>
          </dl>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-review-files">review.files</label>
            <textarea
              id="wf-edit-review-files"
              value={form.reviewFiles}
              onChange={(e) => onChange({ ...form, reviewFiles: e.target.value })}
            />
            <p className="hint">1 行に 1 つ。worktree からの相対パス。空にすると review ごと消します</p>
            {fieldError("reviewFiles") && <p className="hint error">{fieldError("reviewFiles")}</p>}
          </div>
        </>
      )}

      {step.type === "guide" && (
        <>
          <dl className="wf-props">
            <dt>session</dt>
            <dd className="mono">{step.session}</dd>
            <dt>model</dt>
            <dd className="mono">{step.model ?? "指定なし"}</dd>
            <dt>permissionMode</dt>
            <dd className="mono">{step.permissionMode ?? "指定なし"}</dd>
            <dt>allowedTools</dt>
            <dd>
              {step.allowedTools
                ? <ul>{step.allowedTools.map((t) => <li key={t} className="mono">{t}</li>)}</ul>
                : "指定なし"}
            </dd>
          </dl>
          <p className="hint">プロンプトは doctrine が組み立てます</p>
        </>
      )}

      {branch ? (
        <div>
          <h4>{BRANCH_HEADING[step.type]}</h4>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-goto">goto</label>
            <select
              id="wf-edit-goto"
              value={branch.goto}
              onChange={(e) => onChange({ ...form, branch: { ...branch, goto: e.target.value } })}
            >
              {stepIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            {fieldError("branch.goto") && <p className="hint error">{fieldError("branch.goto")}</p>}
          </div>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-max-attempts">maxAttempts</label>
            <input
              type="text"
              inputMode="numeric"
              id="wf-edit-max-attempts"
              value={branch.maxAttempts}
              onChange={(e) => onChange({ ...form, branch: { ...branch, maxAttempts: e.target.value } })}
            />
            {fieldError("branch.maxAttempts") && <p className="hint error">{fieldError("branch.maxAttempts")}</p>}
          </div>
          <div className="settings-field">
            <label className="hint" htmlFor="wf-edit-feed">feed</label>
            <textarea
              id="wf-edit-feed"
              value={branch.feed}
              onChange={(e) => onChange({ ...form, branch: { ...branch, feed: e.target.value } })}
            />
            <p className="hint">空にすると feed を消します</p>
            {fieldError("branch.feed") && <p className="hint error">{fieldError("branch.feed")}</p>}
          </div>
          {step.branch?.implicit && (
            <p className="hint">YAML に書かれていない guide の既定の分岐です。変えると YAML に書き出します</p>
          )}
        </div>
      ) : (
        <p className="hint">分岐なし</p>
      )}

      {stepHasTemplateField(step) && <TemplateVarsHint stepIds={stepIds} />}

      {saveErrors.rest && <p className="hint error">{saveErrors.rest}</p>}
      <div className="actions">
        <button className="btn primary" disabled={!check.ok || check.change === null || pending} onClick={onSave}>
          保存
        </button>
        {saved && <p className="hint">作業ツリーに書いた（未コミット）。次に作るタスクから効く</p>}
      </div>
      {warnings.length > 0 && (
        <div className="box attn">
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/** 送信の結果。ok: false はファイルに書いていない */
export type WorkflowStepSubmit =
  | { ok: true; warnings: string[] }
  | ({ ok: false } & StepSaveErrors);

export async function submitWorkflowStep(
  project: string,
  name: string,
  change: WorkflowStepChange,
  save: WorkflowRpc["save"],
): Promise<WorkflowStepSubmit> {
  try {
    const r = await save(project, name, [change]);
    if (r.ok) return { ok: true, warnings: r.warnings };
    return { ok: false, ...assignSaveIssues(r.issues, change.id) };
  } catch (e) {
    return { ok: false, fields: {}, rest: errorMessage(e) };
  }
}

const NO_STEP_ERRORS: StepSaveErrors = { fields: {}, rest: null };

function StepEditor(
  props: { project: string; name: string; step: WorkflowStepDetail; stepIds: string[]; onSaved: () => void },
): React.JSX.Element {
  const { project, name, step, stepIds, onSaved } = props;
  const api = useWorkflowRpc();
  const [form, setForm] = useState<StepForm>(() => toStepForm(step));
  const [saveErrors, setSaveErrors] = useState<StepSaveErrors>(NO_STEP_ERRORS);
  const [saved, setSaved] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setForm(toStepForm(step));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function onChange(next: StepForm) {
    setForm(next);
    setSaveErrors(NO_STEP_ERRORS);
    setSaved(false);
    setWarnings([]);
  }

  async function onSave() {
    const check = checkStepForm(step, form);
    if (!check.ok || check.change === null) return;
    setPending(true);
    try {
      const r = await submitWorkflowStep(project, name, check.change, api.save);
      if (r.ok) {
        setSaveErrors(NO_STEP_ERRORS);
        setSaved(true);
        setWarnings(r.warnings);
        onSaved();
      } else {
        setSaveErrors({ fields: r.fields, rest: r.rest });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <StepFields
      step={step}
      form={form}
      stepIds={stepIds}
      saveErrors={saveErrors}
      saved={saved}
      warnings={warnings}
      pending={pending}
      onChange={onChange}
      onSave={onSave}
    />
  );
}

/** props だけで描く。ok: false なら issues、ok: true なら warnings・図・選んだステップの編集欄 */
export function WorkflowDefinitionView(props: {
  detail: WorkflowDetail;
  selectedStep: string | null;
  onSelectStep: (stepId: string) => void;
  project: string;
  onSaved: () => void;
}) {
  const { detail, selectedStep, onSelectStep, project, onSaved } = props;
  if (!detail.ok) {
    return (
      <div className="box danger">
        <p>{detail.name} は検証に通りません</p>
        <ul>{detail.issues.map((issue, i) => <li key={i} className="mono">{issue}</li>)}</ul>
      </div>
    );
  }
  const step = detail.steps.find((s) => s.id === selectedStep) ?? null;
  return (
    <div>
      {detail.warnings.length > 0 && (
        <div className="box attn">
          <ul>{detail.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      <WorkflowDefinitionRail steps={detail.steps} selected={selectedStep} onSelect={onSelectStep} />
      {step
        ? (
          <StepEditor
            key={step.id}
            project={project}
            name={detail.name}
            step={step}
            stepIds={detail.steps.map((s) => s.id)}
            onSaved={onSaved}
          />
        )
        : <p className="hint">ステップを選ぶと設定が出ます</p>}
    </div>
  );
}

/** 設定画面の節。プロジェクトを選び、workflow.list / workflow.get を取りに行く */
export function WorkflowSettings() {
  const { s } = useStore();
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  // 選んだ path がまだ projects に無ければ（未選択、または切り替え直後）、s.project に合わせて選び直す。
  const path = chosenPath && s.projects.some((p) => p.path === chosenPath)
    ? chosenPath
    : (s.projects.find((p) => p.id === s.project) ?? s.projects[0])?.path ?? null;
  const [list, setList] = useState<Loaded<WorkflowListEntry[]>>({ kind: "loading" });
  const [name, setName] = useState<string | null>(null);
  const [detail, setDetail] = useState<Loaded<WorkflowDetail>>({ kind: "loading" });
  const [step, setStep] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const workflowApi = useWorkflowRpc();
  const prevNameRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setList({ kind: "loading" });
    setName(null);
    setStep(null);
    rpc("workflow.list", { project: path })
      .then((entries) => {
        if (alive) setList({ kind: "ok", value: entries });
      })
      .catch((e: unknown) => {
        if (alive) setList({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!path || !name) {
      setDetail({ kind: "loading" });
      prevNameRef.current = name;
      return;
    }
    let alive = true;
    // 保存後の取り直し（reload だけが変わったとき）は loading にしない。loading にすると
    // StepEditor が消えて選択とその「保存しました」表示が失われるため。
    if (prevNameRef.current !== name) setDetail({ kind: "loading" });
    prevNameRef.current = name;
    workflowApi.get(path, name)
      .then((d) => {
        if (alive) setDetail({ kind: "ok", value: d });
      })
      .catch((e: unknown) => {
        if (alive) setDetail({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, name, reload]);

  if (s.projects.length === 0) {
    return (
      <div className="pad">
        <h2>ワークフロー</h2>
        <p className="hint">登録されたプロジェクトがありません</p>
      </div>
    );
  }

  const project = s.projects.find((p) => p.path === path) ?? null;

  return (
    <div className="pad">
      <h2>ワークフロー</h2>
      <select aria-label="ワークフローを見るプロジェクト" value={path ?? ""} onChange={(e) => setChosenPath(e.target.value)}>
        {s.projects.map((p) => <option key={p.path} value={p.path}>{p.id}</option>)}
      </select>
      {list.kind === "loading" && <p className="hint">読み込んでいます…</p>}
      {list.kind === "error" && <div className="box danger"><p>{list.message}</p></div>}
      {list.kind === "ok" && (
        <WorkflowList
          entries={list.value}
          defaultName={project?.def ?? null}
          selected={name}
          onSelect={(n) => {
            setName(n);
            setStep(null);
          }}
        />
      )}
      {name && detail.kind === "loading" && <p className="hint">読み込んでいます…</p>}
      {name && detail.kind === "error" && <div className="box danger"><p>{detail.message}</p></div>}
      {path && name && detail.kind === "ok" && (
        <WorkflowDefinitionView
          detail={detail.value}
          selectedStep={step}
          onSelectStep={setStep}
          project={path}
          onSaved={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}
