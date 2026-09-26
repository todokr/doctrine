// PFD の図を目で確かめる開発用のページ（/pfd-preview.html）。アプリの画面ではなく、main.tsx から辿れない
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../styles.css";
import { PfdDiagram } from "../components/PfdDiagram";
import { PfdElementPanel } from "../components/PfdElementPanel";
import { INTAKE_REVIEWING, PFD_LONG_LABELS, PFD_SAMPLE, PFD_STATUSES_A, PFD_STATUSES_B } from "../fixtures";
import { buildPfdView, pfdElement } from "../pfd";

const CASES = [
  { title: "承認前", view: buildPfdView(PFD_SAMPLE) },
  { title: "長いラベル", view: buildPfdView(PFD_LONG_LABELS) },
  { title: "承認後（状態 A）", view: buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A }) },
  { title: "承認後（状態 B）", view: buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_B }) },
  {
    title: "コメントと固定",
    view: buildPfdView(PFD_SAMPLE, {
      comments: { "p:design": 2, "a:schema": 1 },
      frozen: new Set(["p:design", "a:issue", "a:policy", "a:schema"]),
    }),
  },
];

function Case({ title, view }: (typeof CASES)[number]) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section style={{ display: "grid", gap: 8, marginBottom: 24 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>{title}</h2>
      <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
      <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{selected ?? "（未選択）"}</code>
    </section>
  );
}

/** 画面と同じ .plan-body に図と要素の欄を並べる。幅を変えて列の組み替えを見る */
function WithPanel() {
  const [selected, setSelected] = useState<string | null>("p:design");
  const [comments, setComments] = useState<{ index: number; comment: { target_kind: "process"; target_id: string; body: string } }[]>([]);
  const view = buildPfdView(PFD_SAMPLE);
  return (
    <section style={{ display: "grid", gap: 8, marginBottom: 24 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>要素の欄</h2>
      <div className="plan-body">
        <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
        <PfdElementPanel
          pfd={PFD_SAMPLE}
          info={selected === null ? null : pfdElement(PFD_SAMPLE, selected, INTAKE_REVIEWING.question_sets)}
          onSelect={setSelected}
          prompt={undefined}
          onOpenPrompt={() => {}}
          comments={comments}
          previous={[{ comment: INTAKE_REVIEWING.comments[0], reply: "列を減らしました" }]}
          onAddComment={(body) =>
            setComments((c) => [...c, { index: c.length, comment: { target_kind: "process", target_id: "design", body } }])}
          onDeleteComment={(index) => setComments((c) => c.filter((x) => x.index !== index))}
        />
      </div>
    </section>
  );
}

function Preview() {
  const [dark, setDark] = useState(false);
  const toggle = () => {
    const next = !dark;
    if (next) document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    setDark(next);
  };
  return (
    <main style={{ padding: 16, background: "var(--surface)", color: "var(--ink-2)", minHeight: "100vh" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 16 }}>PFD の図</h1>
        <button type="button" className="btn sm" onClick={toggle}>{dark ? "ライト" : "ダーク"}</button>
      </header>
      <WithPanel />
      {CASES.map((c) => <Case key={c.title} {...c} />)}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Preview />);
