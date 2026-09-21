import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PFD_SAMPLE, PFD_STATUSES_A } from "../fixtures";
import { buildPfdView, LOOK, type PfdView } from "../pfd";
import { PfdDiagram } from "./PfdDiagram";

const render = (view: PfdView, selected: string | null = null) =>
  renderToStaticMarkup(<PfdDiagram view={view} selected={selected} onSelect={() => {}} />);

/** ノードの `<g>` から次のノードの手前までを切り出す。kind は aria-label の先頭語（成果物 / プロセス） */
const block = (html: string, kind: "成果物" | "プロセス", name: string) => {
  const parts = html.split('<g class="pfd-node').slice(1);
  const found = parts.find((p) => p.includes(`aria-label="${kind} ${name}`));
  if (!found) throw new Error(`${kind} ${name} が描かれていない`);
  return `<g class="pfd-node${found}`;
};

const openTag = (b: string) => b.slice(0, b.indexOf(">") + 1);

describe("PfdDiagram", () => {
  test("外部の読み込みを持たない", () => {
    const html = render(buildPfdView(PFD_SAMPLE));
    for (const s of ["http", "<img", "<script"]) expect(html).not.toContain(s);
    expect(html).toContain("<svg");
    const count = PFD_SAMPLE.artifacts.length + PFD_SAMPLE.processes.length;
    expect(html.match(/role="button"/g)).toHaveLength(count);
    expect(html.match(/tabindex="0"/g)).toHaveLength(count);
  });

  test("成果物とプロセスの形を描き分ける", () => {
    const html = render(buildPfdView(PFD_SAMPLE));
    const artifact = block(html, "成果物", "CSV スキーマ");
    expect(openTag(artifact)).toContain("pfd-artifact");
    expect(artifact).toContain('rx="4"');
    const process = block(html, "プロセス", "スキーマを設計する");
    expect(openTag(process)).toContain("pfd-process");
    expect(process).toContain('rx="14"');
  });

  test("人・既存・goal・決定の印", () => {
    const html = render(buildPfdView(PFD_SAMPLE));
    const human = block(html, "プロセス", "受け入れる");
    expect(openTag(human)).toContain("human");
    expect(human).toContain("pfd-inner");
    expect(human).toContain("人");
    const given = block(html, "成果物", "Issue");
    expect(openTag(given)).toContain("given");
    expect(given).toContain("既存");
    const goal = block(html, "成果物", "リリース");
    expect(openTag(goal)).toContain("goal");
    expect(goal).toContain("◎");
    const decision = block(html, "成果物", "出力方針");
    expect(openTag(decision)).toContain("decision");
    expect(decision).toContain("決定");
    const plain = block(html, "プロセス", "スキーマを設計する");
    expect(plain).not.toContain("pfd-inner");
  });

  test("選んだ要素だけ強調する", () => {
    const view = buildPfdView(PFD_SAMPLE);
    const html = render(view, "p:design");
    expect(html.match(/pfd-node[^"]*selected/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(openTag(block(html, "プロセス", "スキーマを設計する"))).toContain("selected");
    expect(openTag(block(html, "プロセス", "スキーマを設計する"))).toContain('aria-pressed="true"');
    expect(openTag(block(html, "成果物", "CSV スキーマ"))).toContain('aria-pressed="false"');
    expect(render(view, null)).not.toContain("selected");
  });

  test("成果物とプロセスの id が重なっても片方だけが強調される", () => {
    const view = buildPfdView({
      title: "t",
      goal: ["x"],
      artifacts: [{ id: "a0", name: "入り口", given: true }, { id: "x", name: "同名の成果物", given: false }],
      processes: [{ id: "x", name: "同名のプロセス", actor: "agent", inputs: ["a0"], outputs: ["x"] }],
    });
    const html = render(view, "p:x");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(openTag(block(html, "プロセス", "同名のプロセス"))).toContain("selected");
    expect(openTag(block(html, "成果物", "同名の成果物"))).not.toContain("selected");
  });

  test("状態で塗り分ける", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A }));
    for (const p of PFD_SAMPLE.processes) {
      const look = LOOK[PFD_STATUSES_A[p.id].state];
      const b = block(html, "プロセス", p.name);
      expect(openTag(b)).toContain(look.cls);
      expect(openTag(b)).toContain(look.word);
      if (look.mark) expect(b).toContain(look.mark);
    }
    const plain = render(buildPfdView(PFD_SAMPLE));
    for (const l of Object.values(LOOK)) {
      expect(plain).not.toContain(l.cls);
      expect(plain).not.toContain(l.word);
    }
  });

  test("揃っている成果物を塗る", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A }));
    expect(openTag(block(html, "成果物", "CSV スキーマ"))).toContain("available");
    expect(openTag(block(html, "成果物", "出力 API"))).not.toContain("available");
  });

  test("コメントのある要素に件数の丸", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { comments: { "p:design": 3 } }));
    expect(html.match(/class="pfd-comments"/g)).toHaveLength(1);
    const b = block(html, "プロセス", "スキーマを設計する");
    expect(b).toMatch(/class="pfd-comments"[^]*>3<\/text>/);
    expect(openTag(b)).toContain("コメント 3 件");
    expect(render(buildPfdView(PFD_SAMPLE))).not.toContain("pfd-comments");
  });

  test("固定の要素に鍵の印", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { frozen: new Set(["a:schema"]) }));
    const b = block(html, "成果物", "CSV スキーマ");
    expect(openTag(b)).toContain("frozen");
    expect(b).toContain("🔒");
    expect(html.match(/🔒/g)).toHaveLength(1);
  });

  test("プロセスの段の数字", () => {
    const html = render(buildPfdView(PFD_SAMPLE));
    const stages = [...html.matchAll(/<text[^>]*class="pfd-stage"[^>]*>(\d+)<\/text>/g)].map((m) => m[1]);
    expect(stages).toEqual(["1", "2", "2", "3", "4"]);
  });
});
