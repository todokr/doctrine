import { useEffect, useState } from "react";
import type { GhStatus, IssueDetail } from "../../../shared/intake/github.ts";
import type { GithubIssue } from "../../../shared/protocol.ts";
import { ghGuidance, issueNumber, issueTarget, parseIssueInput, type IssueTarget } from "../intake";
import { clock, type Loaded } from "../model";
import { useIntakeRpc, useStore } from "../store";
import { Markdown } from "./text";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GhUnavailable(
  { status, onRetry }: { status: Extract<GhStatus, { ok: false }>; onRetry: () => void },
) {
  const g = ghGuidance(status);
  return (
    <div className="box attn">
      <h2>{g.title}</h2>
      <p>{g.fix}</p>
      {g.command && <p><span className="mono">{g.command}</span></p>}
      <pre className="block">{status.message}</pre>
      <div className="actions">
        <button className="btn sm" onClick={onRetry}>もう一度確かめる</button>
      </div>
    </div>
  );
}

export function IssueList(
  { issues, selected, onSelect }: {
    issues: GithubIssue[];
    selected: string | null;
    onSelect: (url: string) => void;
  },
) {
  return (
    <div className="issues">
      {issues.map((i) => (
        <button
          key={i.url}
          className="issue-row"
          aria-current={selected === i.url}
          onClick={() => onSelect(i.url)}
        >
          <span className="n">{`#${i.number}`}</span>
          <span>{i.title}</span>
          {i.intake_id ? <span className="pill p-muted">Intake あり</span> : <span />}
          <span className="sub">
            担当: {i.assignees.join("、") || "なし"}・更新 {clock(Date.parse(i.updatedAt))}
          </span>
        </button>
      ))}
      {issues.length === 0 && <p className="hint" style={{ padding: 8 }}>ありません</p>}
    </div>
  );
}

export function IssuePreview(
  { issue, detail, target, pending, onStart, onOpen }: {
    issue: { url: string; number: number | null; title: string };
    detail: Loaded<IssueDetail> | undefined;
    target: IssueTarget;
    pending: boolean;
    onStart: () => void;
    onOpen: (intakeId: string) => void;
  },
) {
  return (
    <div className="issue-body">
      <div className="headrow">
        <h2>{issue.number !== null ? `#${issue.number} ${issue.title}` : issue.title}</h2>
      </div>
      <span className="mono hint">{issue.url}</span>
      {detail?.kind === "error" && <p className="hint">{detail.message}</p>}
      {(detail === undefined || detail.kind === "loading") && <p className="hint">読み込み中</p>}
      {detail?.kind === "ok" && (
        <>
          <div className="md"><Markdown src={detail.value.body} /></div>
          {detail.value.comments.map((c, i) => (
            <div className="cmt" key={i}>
              <div className="who">
                {c.author ?? "削除されたユーザー"}・{clock(Date.parse(c.createdAt))}
              </div>
              <Markdown src={c.body} />
            </div>
          ))}
        </>
      )}
      <div className="actions">
        {target.kind === "open"
          ? <button className="btn" onClick={() => onOpen(target.intakeId)}>進行中の Intake を開く</button>
          : <button className="btn primary" disabled={pending} onClick={onStart}>Intake を開始</button>}
      </div>
    </div>
  );
}

type Picked = { url: string; number: number | null; title: string };

export function IssuePicker() {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [projectId, setProjectId] = useState(() => s.project !== "all" ? s.project : s.projects[0]?.id);
  const path = s.projects.find((p) => p.id === projectId)?.path;
  const [status, setStatus] = useState<Loaded<GhStatus>>({ kind: "loading" });
  const [statusTick, setStatusTick] = useState(0);
  const [assignee, setAssignee] = useState<"me" | "any">("me");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [issues, setIssues] = useState<Loaded<GithubIssue[]>>({ kind: "loading" });
  const [picked, setPicked] = useState<Picked | null>(null);
  const [detail, setDetail] = useState<Loaded<IssueDetail> | undefined>(undefined);
  const [direct, setDirect] = useState("");
  const [pending, setPending] = useState(false);

  // プロジェクトが変わるたびに gh の状態を取り直し、別のプロジェクトのものを捨てる
  useEffect(() => {
    setStatus({ kind: "loading" });
    setIssues({ kind: "loading" });
    setPicked(null);
    setDetail(undefined);
    setDirect("");
    if (!path) return;
    let alive = true;
    api.ghStatus(path).then(
      (value) => alive && setStatus({ kind: "ok", value }),
      (e) => alive && setStatus({ kind: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
    // api は毎回作り直される
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, statusTick]);

  const ghOk = status.kind === "ok" && status.value.ok;
  useEffect(() => {
    if (!path || !ghOk) return;
    let alive = true;
    setIssues({ kind: "loading" });
    api.issues(path, { assignee, search }).then(
      (value) => alive && setIssues({ kind: "ok", value }),
      (e) => alive && setIssues({ kind: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ghOk, status, assignee, search]);

  const pickedUrl = picked?.url;
  useEffect(() => {
    if (!path || !pickedUrl) return;
    let alive = true;
    setDetail({ kind: "loading" });
    api.issue(path, pickedUrl).then(
      (value) => alive && setDetail({ kind: "ok", value }),
      (e) => alive && setDetail({ kind: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pickedUrl]);

  const head = (
    <>
      <div className="crumbs"><span>Intake</span><span>/</span><span>Issue を選ぶ</span></div>
      <div className="headrow">
        <h1>Issue を選んで Intake を始める</h1>
        <span className="spacer" />
        <label className="hint">
          プロジェクト{" "}
          <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)}>
            {s.projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
        </label>
      </div>
    </>
  );

  if (!path) return <div className="pad">{head}<p className="hint">プロジェクトがありません</p></div>;
  if (status.kind === "loading") return <div className="pad">{head}<p className="hint">読み込み中</p></div>;
  if (status.kind === "error") {
    return (
      <div className="pad">
        {head}
        <div className="box danger"><p>{status.message}</p></div>
        <div className="actions">
          <button className="btn sm" onClick={() => setStatusTick((t) => t + 1)}>もう一度確かめる</button>
        </div>
      </div>
    );
  }
  if (!status.value.ok) {
    return (
      <div className="pad">
        {head}
        <GhUnavailable status={status.value} onRetry={() => setStatusTick((t) => t + 1)} />
      </div>
    );
  }
  const repo = status.value.repo;

  const choose = (url: string) => {
    const listed = issues.kind === "ok" ? issues.value.find((i) => i.url === url) : undefined;
    const n = issueNumber(url);
    setDetail(undefined);
    setPicked({ url, number: listed?.number ?? (n === null ? null : Number(n)), title: listed?.title ?? "" });
  };
  const listed = picked && issues.kind === "ok" ? issues.value.find((i) => i.url === picked.url) : undefined;
  const title = picked?.title || (detail?.kind === "ok" ? detail.value.title : "");

  return (
    <div className="pad">
      {head}
      <div className="picker">
        <div style={{ display: "grid", gap: 10 }}>
          <div className="actions">
            <div className="seg">
              <button aria-pressed={assignee === "me"} onClick={() => setAssignee("me")}>自分が担当</button>
              <button aria-pressed={assignee === "any"} onClick={() => setAssignee("any")}>すべて</button>
            </div>
            <input
              type="text"
              aria-label="タイトルで探す"
              placeholder="タイトルで探す（Enter で検索）"
              style={{ flex: 1, minWidth: 160 }}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSearch(searchText.trim());
              }}
            />
          </div>
          {issues.kind === "error" && <div className="box danger"><p>{issues.message}</p></div>}
          {issues.kind === "loading" && <p className="hint">読み込み中</p>}
          {issues.kind === "ok" && (
            <IssueList issues={issues.value} selected={picked?.url ?? null} onSelect={choose} />
          )}
          <div style={{ display: "grid", gap: 4 }}>
            <label className="hint" htmlFor="issue-direct">番号か URL を直接入れる</label>
            <div className="actions">
              <input
                id="issue-direct"
                type="text"
                placeholder="#123 / 123 / https://github.com/…/issues/123"
                style={{ flex: 1 }}
                value={direct}
                onChange={(e) => setDirect(e.target.value)}
              />
              <button
                className="btn sm"
                onClick={() => {
                  const url = parseIssueInput(direct, repo);
                  if (url === null) dispatch({ type: "toast", message: "番号か URL を読めません" });
                  else choose(url);
                }}
              >
                選ぶ
              </button>
            </div>
          </div>
        </div>
        {picked && (
          <IssuePreview
            issue={{ url: picked.url, number: picked.number, title }}
            detail={detail}
            target={issueTarget({ url: picked.url, intake_id: listed?.intake_id }, s.intakes)}
            pending={pending}
            onOpen={(id) => dispatch({ type: "intake.select", id })}
            onStart={async () => {
              setPending(true);
              try {
                const { alreadyActive: _, ...intake } = await api.start(path, picked.url);
                dispatch({ type: "intake.started", intake });
              } catch (e) {
                dispatch({ type: "toast", message: `Intake を始められませんでした（${errorMessage(e)}）` });
              } finally {
                setPending(false);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
