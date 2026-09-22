import { useEffect, useState } from "react";
import type { WorkflowBranchDetail, WorkflowDetail, WorkflowListEntry, WorkflowStepDetail } from "../../../shared/protocol.ts";
import { rpc } from "../daemon/client";
import type { Loaded } from "../model";
import { useStore } from "../store";
import { WorkflowDefinitionRail } from "./WorkflowRail";

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

function BranchSettings({ kind, branch }: { kind: WorkflowStepDetail["type"]; branch: WorkflowBranchDetail | null }) {
  if (!branch) {
    return (
      <>
        <dt>分岐</dt>
        <dd>分岐なし</dd>
      </>
    );
  }
  return (
    <>
      <dt>{BRANCH_HEADING[kind]}</dt>
      <dd>
        <dl className="wf-props">
          <dt>goto</dt>
          <dd className="mono">{branch.goto}</dd>
          <dt>maxAttempts</dt>
          <dd className="mono">{branch.maxAttempts}</dd>
          <dt>feed</dt>
          <dd>{branch.feed ? <pre className="block">{branch.feed}</pre> : "指定なし"}</dd>
        </dl>
        {branch.implicit && <p className="hint">YAML に書かれていない guide の既定の分岐です</p>}
      </dd>
    </>
  );
}

/** props だけで描く。1 ステップの設定を読み取り専用で出す */
export function StepSettings({ step }: { step: WorkflowStepDetail }) {
  return (
    <div>
      <h3 className="mono">{step.id}</h3>
      <p className="hint">{step.type}</p>
      <dl className="wf-props">
        {step.type === "command" && (
          <>
            <dt>run</dt>
            <dd><pre className="block">{step.run}</pre></dd>
          </>
        )}
        {step.type === "agent" && (
          <>
            <dt>model</dt>
            <dd className="mono">{step.model ?? "指定なし"}</dd>
            <dt>permissionMode</dt>
            <dd className="mono">{step.permissionMode ?? "指定なし"}</dd>
            <dt>session</dt>
            <dd className="mono">{step.session ?? "指定なし"}</dd>
            <dt>allowedTools</dt>
            <dd>
              {step.allowedTools
                ? <ul>{step.allowedTools.map((t) => <li key={t} className="mono">{t}</li>)}</ul>
                : "指定なし"}
            </dd>
            <dt>prompt</dt>
            <dd><pre className="block">{step.prompt}</pre></dd>
          </>
        )}
        {step.type === "approval" && (
          <>
            <dt>title</dt>
            <dd>{step.title}</dd>
            <dt>review.files</dt>
            <dd>
              {step.reviewFiles
                ? <ul>{step.reviewFiles.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
                : "指定なし"}
            </dd>
          </>
        )}
        {step.type === "guide" && (
          <>
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
          </>
        )}
        <BranchSettings kind={step.type} branch={step.branch} />
      </dl>
      {step.type === "guide" && <p className="hint">プロンプトは doctrine が組み立てます</p>}
    </div>
  );
}

/** props だけで描く。ok: false なら issues、ok: true なら warnings・図・選んだステップの設定 */
export function WorkflowDefinitionView(props: {
  detail: WorkflowDetail;
  selectedStep: string | null;
  onSelectStep: (stepId: string) => void;
}) {
  const { detail, selectedStep, onSelectStep } = props;
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
      {step ? <StepSettings step={step} /> : <p className="hint">ステップを選ぶと設定が出ます</p>}
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
      return;
    }
    let alive = true;
    setDetail({ kind: "loading" });
    setStep(null);
    rpc("workflow.get", { project: path, name })
      .then((d) => {
        if (alive) setDetail({ kind: "ok", value: d });
      })
      .catch((e: unknown) => {
        if (alive) setDetail({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [path, name]);

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
        <WorkflowList entries={list.value} defaultName={project?.def ?? null} selected={name} onSelect={setName} />
      )}
      {name && detail.kind === "loading" && <p className="hint">読み込んでいます…</p>}
      {name && detail.kind === "error" && <div className="box danger"><p>{detail.message}</p></div>}
      {name && detail.kind === "ok" && (
        <WorkflowDefinitionView detail={detail.value} selectedStep={step} onSelectStep={setStep} />
      )}
    </div>
  );
}
