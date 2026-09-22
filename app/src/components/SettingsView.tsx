import { useState, type Dispatch } from "react";
import type { AppSettings } from "../daemon/client";
import { checkSettingsForm, toSettingsForm, type SettingsForm } from "../settings";
import { sendDecision } from "../decision";
import type { Action } from "../model";
import { useSettingsRpc, useStore } from "../store";
import { WorkflowSettings } from "./WorkflowSettings";

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
    <div className="pad">
      <h1>設定</h1>
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
    </div>
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

export function SettingsView(): React.JSX.Element {
  const { s } = useStore();
  const main = s.settings.kind === "loading"
    ? <div className="pad"><p className="hint">設定を読み込んでいます…</p></div>
    : s.settings.kind === "error"
    ? (
      <div className="pad">
        <div className="box danger">
          <p>設定を読めませんでした</p>
          <p className="mono">{s.settings.message}</p>
          <p className="hint">設定ファイルを直してから、アプリを開き直してください。</p>
        </div>
      </div>
    )
    : <SettingsEditor key={JSON.stringify(s.settings.value)} initial={s.settings.value} />;
  return (
    <>
      {main}
      <WorkflowSettings />
    </>
  );
}
