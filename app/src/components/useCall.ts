import { useState } from "react";
import { sendDecision } from "../decision";
import { useStore } from "../store";

/** RPC を送り、成功したときだけ後片付けをする。失敗はトースト */
export function useCall() {
  const { dispatch } = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const call = async <T,>(key: string, send: Promise<T>, failed: string, onOk: (value: T) => void) => {
    setPending(key);
    try {
      let value!: T;
      const r = await sendDecision(send.then((v) => {
        value = v;
      }), failed);
      if (r.ok) onOk(value);
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setPending(null);
    }
  };
  return { pending, call };
}
