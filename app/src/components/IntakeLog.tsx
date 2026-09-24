import { useEffect } from "react";
import type { IntakeDetail, IntakeRun } from "../../../shared/protocol.ts";
import { rpc } from "../daemon/client";
import { intakeFace, RUN_PURPOSE_WORD } from "../intake";
import type { IntakeLogView } from "../model";
import { useStore } from "../store";
import { LogBlock } from "./LogBlock";

/** 末尾を一度に何行もらうか。intake.logs の既定と揃える */
const TAIL = 200;

/**
 * ログの末尾と追従。追従の枠はタスクと 1 つを分け合うので、面を離れるときは必ずやめる。
 * 調査中・分解中の間だけ追う。止まったら（要確認など）末尾を取り直して、そこで止める。
 */
function useIntakeLogs(intakeId: string, following: boolean) {
  const { dispatch } = useStore();
  useEffect(() => {
    let alive = true;
    void rpc("intake.logs", { intake_id: intakeId, tail: TAIL, follow: following })
      .then((logs) => {
        if (alive) {
          dispatch({ type: "intake.logs", id: intakeId, logs: { runId: logs.run_id, lines: logs.lines } });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (following) void rpc("intake.logs", { intake_id: intakeId, follow: false }).catch(() => {});
    };
  }, [intakeId, following, dispatch]);
}

/** props だけで描く。テストはこちらを描く */
export function IntakeLogPanel(
  { intakeId, log, runs, following }: {
    intakeId: string;
    log: IntakeLogView | undefined;
    runs: IntakeRun[];
    following: boolean;
  },
) {
  const run = runs.find((r) => r.id === log?.runId);
  return (
    <>
      <div className="headrow">
        <span className="lbl">Log</span>
        <span className="mono hint">
          {run ? `${RUN_PURPOSE_WORD[run.purpose]} ${run.attempt} 回目` : ""}
        </span>
        <span className="spacer" />
        {!following && <span className="hint">末尾 {TAIL} 行</span>}
      </div>
      <LogBlock
        lines={log?.lines}
        resetKey={`${intakeId}:${log?.runId}`}
        empty={log?.runId === null ? "まだ実行がありません。" : "この実行のログはまだありません。"}
      />
    </>
  );
}

/** 調査中・分解中・要確認の面の Log 欄 */
export function IntakeLog({ detail }: { detail: IntakeDetail }) {
  const { s } = useStore();
  const following = intakeFace(detail.state) === "running";
  useIntakeLogs(detail.id, following);
  return (
    <IntakeLogPanel
      intakeId={detail.id}
      log={s.intakeLogs[detail.id]}
      runs={detail.runs}
      following={following}
    />
  );
}
