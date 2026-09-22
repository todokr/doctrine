import { useEffect, useState, type Dispatch } from "react";
import type { AppSettings } from "../daemon/client";
import { checkGlobalLimit, checkSettingsForm, toSettingsForm, type SettingsForm } from "../settings";
import { sendDecision } from "../decision";
import type { Action, Loaded } from "../model";
import { useSettingsRpc, useSlotsRpc, useStore } from "../store";
import type { DaemonSlots } from "../../../shared/protocol.ts";
import type { IntakeRunPurpose } from "../../../shared/intake/state.ts";

/** 取りこぼしを吸収する保険。store.tsx の REFRESH_MS と同じ値 */
const REFRESH_MS = 15_000;

const PURPOSE_LABEL: Record<IntakeRunPurpose, string> = { investigate: "調査", decompose: "分解", revise: "改訂" };

/** props だけで描く。テストはこちらを描く */
export function SettingsFields(props: {
  form: SettingsForm;
  pending: boolean;
  onChange: (form: SettingsForm) => void;
  onSave: () => void;
}): React.JSX.Element {
  const { form, pending, onChange, onSave } = props;
  const check = checkSettingsForm(form);
  const errors = check.ok ? {} : check.errors;
  return (
    <>
      <h2>アプリ</h2>
      <div className="settings-field">
        <label className="hint" htmlFor="settings-editor">エディタの起動コマンド</label>
        <input
          type="text"
          id="settings-editor"
          value={form.editorCommand}
          onChange={(e) => onChange({ ...form, editorCommand: e.target.value })}
        />
        <p className="hint">
          <span className="mono">{"{path}"}</span> は開く worktree のパスに置き換わります（クォートして渡します）。
        </p>
        {errors.editorCommand && <p className="hint error">{errors.editorCommand}</p>}
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="settings-terminal">ターミナルの起動コマンド</label>
        <input
          type="text"
          id="settings-terminal"
          value={form.terminalCommand}
          onChange={(e) => onChange({ ...form, terminalCommand: e.target.value })}
        />
        <p className="hint">
          <span className="mono">{"{path}"}</span> は開く worktree のパスに置き換わります（クォートして渡します）。
        </p>
        {errors.terminalCommand && <p className="hint error">{errors.terminalCommand}</p>}
      </div>
      <div className="settings-field">
        <label className="hint" htmlFor="settings-stale-days">古い worktree とみなす日数</label>
        <input
          type="text"
          inputMode="numeric"
          id="settings-stale-days"
          value={form.staleDays}
          onChange={(e) => onChange({ ...form, staleDays: e.target.value })}
        />
        <p className="hint">終端状態になってからこの日数を過ぎた worktree を古いとみなします。</p>
        {errors.staleDays && <p className="hint error">{errors.staleDays}</p>}
      </div>
      <div className="actions">
        <button className="btn primary" disabled={!check.ok || pending} onClick={onSave}>保存</button>
      </div>
    </>
  );
}

/**
 * 検証して保存する。保存に成功したら store の設定を置き換えてトーストを出し、true を返す。
 * 検証に通らなければ何も送らずに false を返す。送信の失敗はトーストで出し、false を返す。
 */
export async function submitSettings(
  form: SettingsForm,
  save: (settings: AppSettings) => Promise<void>,
  dispatch: Dispatch<Action>,
): Promise<boolean> {
  const check = checkSettingsForm(form);
  if (!check.ok) return false;
  const r = await sendDecision(save(check.value), "設定を保存できませんでした");
  if (r.ok) {
    dispatch({ type: "settings", loaded: { kind: "ok", value: check.value } });
    dispatch({ type: "toast", message: "設定を保存しました" });
    return true;
  }
  dispatch({ type: "toast", message: r.message });
  return false;
}

function SettingsEditor({ initial }: { initial: AppSettings }) {
  const { dispatch } = useStore();
  const { save } = useSettingsRpc();
  const [form, setForm] = useState(() => toSettingsForm(initial));
  const [pending, setPending] = useState(false);

  async function onSave() {
    setPending(true);
    try {
      await submitSettings(form, save, dispatch);
    } finally {
      setPending(false);
    }
  }

  return <SettingsFields form={form} pending={pending} onChange={setForm} onSave={onSave} />;
}

/** props だけで描く。テストはこちらを描く */
export function SlotsFields(props: {
  connected: boolean;
  slots: Loaded<DaemonSlots>;
  limit: string;
  pending: boolean;
  onChange: (limit: string) => void;
  onSave: () => void;
  onOpenTask: (id: string) => void;
  onOpenIntake: (id: string) => void;
}): React.JSX.Element {
  const { connected, slots, limit, pending, onChange, onSave, onOpenTask, onOpenIntake } = props;
  const check = checkGlobalLimit(limit);
  const okSlots = connected && slots.kind === "ok" ? slots.value : null;
  const disabledField = !connected || slots.kind !== "ok";
  const disabledSave = disabledField || !check.ok || pending ||
    (okSlots !== null && Number(limit.trim()) === okSlots.global_limit);

  return (
    <>
      <h2>実行枠</h2>
      <p className="hint">タスクと Intake の実行を合わせて、同時に走らせる数の上限です。</p>
      {!connected && <p className="hint">デーモンにつながっていないため、実行枠を見たり変えたりできません</p>}
      {connected && slots.kind === "loading" && <p className="hint">実行枠を読み込んでいます…</p>}
      {connected && slots.kind === "error" && (
        <div className="box danger">
          <p>実行枠を読めませんでした</p>
          <p className="mono">{slots.message}</p>
        </div>
      )}
      {okSlots && (
        <p className="hint">
          いまの値: {okSlots.global_limit} / 使っている数: {okSlots.in_use} / {okSlots.global_limit}
        </p>
      )}
      <div className="settings-field">
        <label className="hint" htmlFor="settings-global-limit">全体の実行枠</label>
        <input
          type="text"
          inputMode="numeric"
          id="settings-global-limit"
          value={limit}
          disabled={disabledField}
          onChange={(e) => onChange(e.target.value)}
        />
        {!check.ok && <p className="hint error">{check.error}</p>}
      </div>
      <div className="actions">
        <button className="btn primary" disabled={disabledSave} onClick={onSave}>実行枠を保存</button>
      </div>
      <h3>枠待ちのタスク</h3>
      <p className="hint">プロジェクトの枠や利用上限で待っているものも含みます</p>
      {okSlots && okSlots.waiting_tasks.length === 0 && <p className="hint">ありません</p>}
      {okSlots && okSlots.waiting_tasks.length > 0 && (
        <ul className="warnings">
          {okSlots.waiting_tasks.map((t) => (
            <li key={t.id}>
              <button className="btn sm" onClick={() => onOpenTask(t.id)}>{t.title}</button>
              <span className="mono hint">{t.id}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>枠待ちの Intake</h3>
      {okSlots && okSlots.waiting_intake_runs.length === 0 && <p className="hint">ありません</p>}
      {okSlots && okSlots.waiting_intake_runs.length > 0 && (
        <ul className="warnings">
          {okSlots.waiting_intake_runs.map((r) => (
            <li key={r.id}>
              <button className="btn sm" onClick={() => onOpenIntake(r.intake_id)}>{r.issue_title}</button>
              <span className="hint">{PURPOSE_LABEL[r.purpose]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 検証して daemon.setGlobalLimit を送る。成功したらトーストを出し、応答の DaemonSlots を返す。
 * 検証に通らなければ何も送らずに null。送信の失敗はトーストで出して null。
 */
export async function submitGlobalLimit(
  text: string,
  setGlobalLimit: (globalLimit: number) => Promise<DaemonSlots>,
  dispatch: Dispatch<Action>,
): Promise<DaemonSlots | null> {
  const check = checkGlobalLimit(text);
  if (!check.ok) return null;
  try {
    const slots = await setGlobalLimit(check.value);
    dispatch({ type: "toast", message: "実行枠を保存しました" });
    return slots;
  } catch (e) {
    dispatch({ type: "toast", message: "実行枠を保存できませんでした: " + String(e) });
    return null;
  }
}

function SlotsSection(): React.JSX.Element {
  const { s, dispatch } = useStore();
  const { load, setGlobalLimit } = useSlotsRpc();
  const connected = s.conn.status === "connected";
  const [slots, setSlots] = useState<Loaded<DaemonSlots>>({ kind: "loading" });
  const [limit, setLimit] = useState("");
  const [, setEdited] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    const fetchSlots = async () => {
      try {
        const v = await load();
        if (!alive) return;
        setSlots({ kind: "ok", value: v });
        setEdited((wasEdited) => {
          if (!wasEdited) setLimit(String(v.global_limit));
          return wasEdited;
        });
      } catch (e) {
        if (!alive) return;
        setSlots({ kind: "error", message: String(e) });
      }
    };
    fetchSlots();
    const id = setInterval(fetchSlots, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  async function onSave() {
    setPending(true);
    try {
      const result = await submitGlobalLimit(limit, setGlobalLimit, dispatch);
      if (result) {
        setSlots({ kind: "ok", value: result });
        setLimit(String(result.global_limit));
        setEdited(false);
      } else {
        try {
          const v = await load();
          setSlots({ kind: "ok", value: v });
        } catch (e) {
          setSlots({ kind: "error", message: String(e) });
        }
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <SlotsFields
      connected={connected}
      slots={slots}
      limit={limit}
      pending={pending}
      onChange={(v) => {
        setLimit(v);
        setEdited(true);
      }}
      onSave={onSave}
      onOpenTask={(id) => dispatch({ type: "task.open", id })}
      onOpenIntake={(id) => dispatch({ type: "intake.open", id })}
    />
  );
}

export function SettingsView(): React.JSX.Element {
  const { s } = useStore();
  let body: React.JSX.Element;
  if (s.settings.kind === "loading") {
    body = <p className="hint">設定を読み込んでいます…</p>;
  } else if (s.settings.kind === "error") {
    body = (
      <div className="box danger">
        <p>設定を読めませんでした</p>
        <p className="mono">{s.settings.message}</p>
        <p className="hint">設定ファイルを直してから、アプリを開き直してください。</p>
      </div>
    );
  } else {
    body = <SettingsEditor key={JSON.stringify(s.settings.value)} initial={s.settings.value} />;
  }
  return (
    <div className="pad">
      <h1>設定</h1>
      {body}
      <SlotsSection />
    </div>
  );
}
