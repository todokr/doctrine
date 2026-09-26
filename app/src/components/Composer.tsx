import { useEffect, useState, type Dispatch } from "react";
import type { WorkflowListEntry } from "../../../shared/protocol.ts";
import {
  canSubmitComposer,
  composerWorkflowOptions,
  createdToast,
  createParams,
  initialComposerForm,
  pickWorkflow,
  selectedSteps,
  type ComposerForm,
} from "../composer";
import type { Action, ComposerInit, Loaded } from "../model";
import { useComposerRpc, useRefresh, useStore, type ComposerRpc } from "../store";
import type { Project } from "../types";
import { WorkflowRail } from "./WorkflowRail";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** props だけで描く。テストはこちらを描く */
export function ComposerFields(props: {
  projects: Project[];
  form: ComposerForm;
  workflows: Loaded<WorkflowListEntry[]>;
  pending: boolean;
  error: string | null;
  onChange: (form: ComposerForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { projects, form, workflows, pending, error, onChange, onSubmit, onCancel } = props;
  const entries = workflows.kind === "ok" ? workflows.value : [];
  const steps = selectedSteps(entries, form.workflow);
  const broken = entries.flatMap((e) => (e.ok ? [] : [e]));
  return (
    <div className="pad">
      <h1>新しいタスク</h1>
      <div className="settings-field">
        <label className="hint" htmlFor="composer-project">プロジェクト</label>
        {projects.length === 0 ? <p className="hint">プロジェクトがありません</p> : (
          <select
            id="composer-project"
            aria-label="プロジェクト"
            value={form.project}
            onChange={(e) => onChange({ ...form, project: e.target.value })}
          >
            {projects.map((p) => <option key={p.path} value={p.path}>{p.id}</option>)}
          </select>
        )}
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="composer-workflow">ワークフロー</label>
        {workflows.kind === "loading" && <p className="hint">ワークフローを読み込んでいます…</p>}
        {workflows.kind === "error" && <p className="hint error">{workflows.message}</p>}
        {workflows.kind === "ok" && (
          <select
            id="composer-workflow"
            aria-label="ワークフロー"
            value={form.workflow}
            onChange={(e) => onChange({ ...form, workflow: e.target.value })}
          >
            {composerWorkflowOptions(entries).map((o) => (
              <option key={o.name} value={o.name} disabled={o.disabled}>{o.label}</option>
            ))}
          </select>
        )}
      </div>
      {broken.length > 0 && (
        <section className="box danger">
          <h3>選べないワークフロー</h3>
          {broken.map((e) => (
            <div key={e.name}>
              <b>{e.name}</b>
              <ul>{e.issues.map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          ))}
        </section>
      )}
      {steps && <WorkflowRail detail={{ steps, stepRuns: [], task: { current_step_id: null } }} legend={false} />}
      <div className="settings-field">
        <label className="hint" htmlFor="composer-title">タイトル</label>
        <input
          type="text"
          id="composer-title"
          value={form.title}
          onChange={(e) => onChange({ ...form, title: e.target.value })}
        />
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="composer-prompt">指示</label>
        <textarea
          id="composer-prompt"
          rows={8}
          value={form.prompt}
          onChange={(e) => onChange({ ...form, prompt: e.target.value })}
        />
      </div>
      {error && <p className="hint error">{error}</p>}
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={!canSubmitComposer(form, entries) || pending}
          onClick={onSubmit}
        >
          作成
        </button>
        <button type="button" className="btn" onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}

export type ComposerSubmit = { ok: true } | { ok: false; message: string };

/** 送って、取り直してから選ぶ。失敗したら何も dispatch せずメッセージを返す（入力は呼び出し側に残る） */
export async function submitComposer(
  form: ComposerForm,
  deps: { create: ComposerRpc["create"]; refresh: () => Promise<void>; dispatch: Dispatch<Action> },
): Promise<ComposerSubmit> {
  let created;
  try {
    created = await deps.create(createParams(form));
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
  // 取り直しの前に選ぶと、sync が一覧に無い sel を外してしまう
  await deps.refresh();
  deps.dispatch({
    type: "composer.created",
    id: created.id,
    toast: createdToast(created.title, created.warnings),
  });
  return { ok: true };
}

export function Composer({ init }: { init: ComposerInit }): React.JSX.Element {
  const { s, dispatch } = useStore();
  const refresh = useRefresh();
  const rpc = useComposerRpc();
  const [form, setForm] = useState(() => initialComposerForm(s.projects, init, s.project));
  const [workflows, setWorkflows] = useState<Loaded<WorkflowListEntry[]>>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (form.project === "") return;
    let alive = true;
    setWorkflows({ kind: "loading" });
    rpc.workflows(form.project).then(
      (list) => {
        if (!alive) return;
        setWorkflows({ kind: "ok", value: list });
        // 読み込み中に打った入力を潰さないよう、関数形式で workflow だけ置き換える
        setForm((f) => ({ ...f, workflow: pickWorkflow(list, f.workflow) }));
      },
      (e) => alive && setWorkflows({ kind: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [form.project]);

  const change = (next: ComposerForm) => {
    setError(null);
    setForm(next.project !== form.project ? { ...next, workflow: "" } : next);
  };

  const submit = async () => {
    setPending(true);
    try {
      const r = await submitComposer(form, { create: rpc.create, refresh, dispatch });
      if (!r.ok) setError(r.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <ComposerFields
      projects={s.projects}
      form={form}
      workflows={workflows}
      pending={pending}
      error={error}
      onChange={change}
      onSubmit={submit}
      onCancel={() => dispatch({ type: "composer.close" })}
    />
  );
}
