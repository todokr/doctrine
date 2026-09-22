import { useEffect, useState } from "react";
import type { ProjectConfig, ProjectSummary, WorkflowListEntry } from "../../../shared/protocol.ts";
import type { Loaded } from "../model";
import {
  assignSaveError,
  checkProjectConfigForm,
  toProjectConfigForm,
  workflowOptions,
  type ProjectConfigForm,
  type ProjectConfigSaveErrors,
  type WorkflowOption,
} from "../projectConfig";
import { useProjectConfigRpc, useRefresh, useStore, type ProjectConfigRpc } from "../store";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** props だけで描く。テストはこちらを描く */
export function ProjectConfigFields(props: {
  form: ProjectConfigForm;
  workflows: WorkflowOption[];
  saveErrors: ProjectConfigSaveErrors;
  saved: boolean;
  pending: boolean;
  onChange: (form: ProjectConfigForm) => void;
  onSave: () => void;
}): React.JSX.Element {
  const { form, workflows, saveErrors, saved, pending, onChange, onSave } = props;
  const check = checkProjectConfigForm(form);
  const inputErrors = check.ok ? {} : check.errors;
  return (
    <div>
      <div className="settings-field">
        <label className="hint" htmlFor="project-default-workflow">defaultWorkflow</label>
        <select
          id="project-default-workflow"
          value={form.defaultWorkflow}
          onChange={(e) => onChange({ ...form, defaultWorkflow: e.target.value })}
        >
          {workflows.map((w) => <option key={w.name} value={w.name}>{w.label}</option>)}
        </select>
        <p className="hint">新しいタスクが使うワークフロー</p>
        {(inputErrors.defaultWorkflow || saveErrors.fields.defaultWorkflow) && (
          <p className="hint error">{inputErrors.defaultWorkflow ?? saveErrors.fields.defaultWorkflow}</p>
        )}
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="project-max-concurrent">maxConcurrent</label>
        <input
          type="text"
          inputMode="numeric"
          id="project-max-concurrent"
          value={form.maxConcurrent}
          onChange={(e) => onChange({ ...form, maxConcurrent: e.target.value })}
        />
        <p className="hint">このプロジェクトで同時に動かすタスクの数</p>
        {(inputErrors.maxConcurrent || saveErrors.fields.maxConcurrent) && (
          <p className="hint error">{inputErrors.maxConcurrent ?? saveErrors.fields.maxConcurrent}</p>
        )}
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="project-base-branch">baseBranch</label>
        <input
          type="text"
          id="project-base-branch"
          value={form.baseBranch}
          onChange={(e) => onChange({ ...form, baseBranch: e.target.value })}
        />
        <p className="hint">worktree を切る元のブランチ</p>
        {(inputErrors.baseBranch || saveErrors.fields.baseBranch) && (
          <p className="hint error">{inputErrors.baseBranch ?? saveErrors.fields.baseBranch}</p>
        )}
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="project-setup">setup</label>
        <textarea
          id="project-setup"
          value={form.setup}
          onChange={(e) => onChange({ ...form, setup: e.target.value })}
        />
        <p className="hint">各タスクの最初に走るコマンド。空にすると消します</p>
        {(inputErrors.setup || saveErrors.fields.setup) && (
          <p className="hint error">{inputErrors.setup ?? saveErrors.fields.setup}</p>
        )}
      </div>
      {saveErrors.rest && <p className="hint error">{saveErrors.rest}</p>}
      <div className="actions">
        <button className="btn primary" disabled={!check.ok || pending} onClick={onSave}>保存</button>
        {saved && <p className="hint">作業ツリーの .doctrine/project.yaml に書きました（未コミット）</p>}
      </div>
    </div>
  );
}

export type ProjectConfigSubmit =
  | { ok: true; saved: ProjectSummary }
  | ({ ok: false } & ProjectConfigSaveErrors);

export async function submitProjectConfig(
  project: string,
  form: ProjectConfigForm,
  save: ProjectConfigRpc["save"],
): Promise<ProjectConfigSubmit> {
  const check = checkProjectConfigForm(form);
  if (!check.ok) return { ok: false, fields: check.errors, rest: null };
  try {
    const saved = await save(project, check.value);
    return { ok: true, saved };
  } catch (e) {
    return { ok: false, ...assignSaveError(errorMessage(e)) };
  }
}

export async function loadProjectConfig(
  project: string,
  api: Pick<ProjectConfigRpc, "get" | "workflows">,
): Promise<{ config: ProjectConfig; workflows: WorkflowListEntry[] }> {
  const [config, workflows] = await Promise.all([api.get(project), api.workflows(project)]);
  return { config, workflows };
}

function projectSummaryToConfig(s: ProjectSummary): ProjectConfig {
  return {
    defaultWorkflow: s.default_workflow,
    maxConcurrent: s.max_concurrent,
    baseBranch: s.base_branch,
    ...(s.setup !== null ? { setup: s.setup } : {}),
  };
}

const NO_SAVE_ERRORS: ProjectConfigSaveErrors = { fields: {}, rest: null };

function ProjectConfigEditor({ path }: { path: string }): React.JSX.Element {
  const api = useProjectConfigRpc();
  const refresh = useRefresh();
  const [loaded, setLoaded] = useState<Loaded<{ config: ProjectConfig; workflows: WorkflowListEntry[] }>>({
    kind: "loading",
  });
  const [form, setForm] = useState<ProjectConfigForm | null>(null);
  const [saveErrors, setSaveErrors] = useState<ProjectConfigSaveErrors>(NO_SAVE_ERRORS);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoaded({ kind: "loading" });
    loadProjectConfig(path, api)
      .then(({ config, workflows }) => {
        if (!alive) return;
        setLoaded({ kind: "ok", value: { config, workflows } });
        setForm(toProjectConfigForm(config));
      })
      .catch((e) => {
        if (!alive) return;
        setLoaded({ kind: "error", message: errorMessage(e) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick]);

  function onChange(next: ProjectConfigForm) {
    setForm(next);
    setSaveErrors(NO_SAVE_ERRORS);
    setSaved(false);
  }

  async function onSave() {
    if (!form) return;
    setPending(true);
    try {
      const r = await submitProjectConfig(path, form, api.save);
      if (r.ok) {
        setForm(toProjectConfigForm(projectSummaryToConfig(r.saved)));
        setSaveErrors(NO_SAVE_ERRORS);
        setSaved(true);
        void refresh();
      } else {
        setSaveErrors({ fields: r.fields, rest: r.rest });
      }
    } finally {
      setPending(false);
    }
  }

  if (loaded.kind === "loading" || !form) {
    return <p className="hint">プロジェクトの設定を読み込んでいます…</p>;
  }
  if (loaded.kind === "error") {
    return (
      <div className="box danger">
        <p>プロジェクトの設定を読めませんでした</p>
        <p className="mono">{loaded.message}</p>
        <div className="actions">
          <button className="btn sm" onClick={() => setTick((t) => t + 1)}>もう一度読む</button>
        </div>
      </div>
    );
  }

  return (
    <ProjectConfigFields
      form={form}
      workflows={workflowOptions(loaded.value.workflows, form.defaultWorkflow)}
      saveErrors={saveErrors}
      saved={saved}
      pending={pending}
      onChange={onChange}
      onSave={onSave}
    />
  );
}

export function ProjectConfigSection(): React.JSX.Element {
  const { s } = useStore();
  const [projectId, setProjectId] = useState(() => s.project !== "all" ? s.project : s.projects[0]?.id);
  const selected = s.projects.some((p) => p.id === projectId) ? projectId : s.projects[0]?.id;
  const path = s.projects.find((p) => p.id === selected)?.path;
  return (
    <section>
      <h2>プロジェクト</h2>
      {s.projects.length === 0 ? <p className="hint">プロジェクトがありません</p> : (
        <>
          <label className="hint">
            <select
              aria-label="設定するプロジェクト"
              value={selected ?? ""}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {s.projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
            </select>
          </label>
          {path && <ProjectConfigEditor key={path} path={path} />}
        </>
      )}
    </section>
  );
}
