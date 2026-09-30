import { trackerGuidance } from "../intake";
import type { Workspace } from "../types";

function TrackerLine({ tracker, root }: { tracker: Workspace["tracker"]; root: string }): React.JSX.Element {
  if (tracker.ok) {
    const { config } = tracker;
    return <p>{`トラッカー: ${config.kind === "linear" ? `Linear（team: ${config.team}）` : "GitHub"}`}</p>;
  }
  const g = trackerGuidance(tracker, root);
  return (
    <div className="box attn">
      <p><b>{g.title}</b></p>
      <p>{g.fix}</p>
      {tracker.message !== "" && <pre className="block">{tracker.message}</pre>}
    </div>
  );
}

/** props だけで描く。テストはこちらを描く */
export function WorkspaceList({ workspaces }: { workspaces: Workspace[] }): React.JSX.Element {
  return (
    <section>
      <h2>workspace</h2>
      {workspaces.length === 0 ? <p className="hint">ありません</p> : workspaces.map((w) => (
        <div className="box" key={w.id}>
          <h3>{w.name}</h3>
          <p className="mono hint">{w.path}</p>
          {w.projects.length === 0
            ? <p className="hint">プロジェクトはありません</p>
            : (
              <ul className="warnings">
                {w.projects.map((p) => (
                  <li key={p.path}><b>{p.name}</b> <span className="mono hint">{p.path}</span></li>
                ))}
              </ul>
            )}
          <TrackerLine tracker={w.tracker} root={w.path} />
        </div>
      ))}
    </section>
  );
}
