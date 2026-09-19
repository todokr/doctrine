// diff の1行を色分けするためのトークン化。副作用を持たない（テストは highlight.test.ts）
// 既定の entry が markup / css / clike / javascript を積む。以降はその上に足す
import Prism from "prismjs";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import type { DiffLine } from "./model";

// Prism は読み込み時に DOM を走査して自動でハイライトする。この画面は
// 自前で描くので止める（class="language-*" を撒かない以上は無害だが、
// 意図しない走査を残さない）
Prism.manual = true;

/** ファイル名から言語を決める。拡張子だけを見る — 中身の推測はしない */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  json: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  css: "css",
  html: "markup", xml: "markup", svg: "markup",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python",
  sql: "sql",
  md: "markdown",
};

/** 拡張子を持たない設定ファイル。名前そのもので決める */
const BY_NAME: Record<string, string> = {
  Dockerfile: "bash",
  Makefile: "bash",
};

/** 対応していない言語は null。呼び出し側は色を付けずにそのまま描く */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export type Piece = { text: string; cls: string | null };

/**
 * Prism のトークン名 → styles.css のクラス。表に無い名前は色を付けない。
 * 言語ごとに固有の名前が無数にあるので、全部を色分けしようとはせず、
 * 「何が文字列で何がコメントか」が読めるところまでに絞る。
 */
const CLASS_OF: Record<string, string> = {
  comment: "com", prolog: "com", doctype: "com", cdata: "com",
  string: "str", char: "str", "template-string": "str", "attr-value": "str", regex: "str",
  keyword: "kw", boolean: "kw", atrule: "kw", important: "kw", tag: "kw", selector: "kw",
  number: "num", unit: "num",
  function: "fn", "function-variable": "fn",
  "class-name": "ty", builtin: "ty", constant: "ty", symbol: "ty",
  property: "ty", "attr-name": "ty", "lifetime-annotation": "ty",
};

type Node = string | { type: string; content: Node | Node[] };

function flatten(nodes: Node[], inherited: string | null, out: Piece[]): void {
  for (const node of nodes) {
    if (typeof node === "string") {
      out.push({ text: node, cls: inherited });
      continue;
    }
    // 入れ子の内側に表に載る名前があればそちらを優先する。
    // （テンプレートリテラルの中の式、タグの中の属性名など）
    const cls = CLASS_OF[node.type] ?? inherited;
    const content = node.content;
    if (typeof content === "string") out.push({ text: content, cls });
    else flatten(Array.isArray(content) ? content : [content], cls, out);
  }
}

/**
 * コードを行ごとのトークン列にする。
 *
 * 行ではなくまとまり（hunk 1つ分）を渡す。ブロックコメントやテンプレート
 * リテラルのように行をまたぐトークンは、1行ずつ食わせると開始行だけが
 * 色付いて続きが素のまま残る。まとめて食わせてから改行で割れば、
 * またいだトークンは各行の断片として正しく色が付く。
 */
export function highlightLines(code: string, language: string | null): Piece[][] {
  const grammar = language ? Prism.languages[language] : undefined;
  if (!grammar) return code.split("\n").map((text) => [{ text, cls: null }]);

  const pieces: Piece[] = [];
  flatten(Prism.tokenize(code, grammar) as Node[], null, pieces);

  const lines: Piece[][] = [[]];
  for (const piece of pieces) {
    const parts = piece.text.split("\n");
    parts.forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines[lines.length - 1].push({ text, cls: piece.cls });
    });
  }
  return lines;
}

/**
 * hunk の各行にトークンを割り当てる。
 *
 * 削除行と追加行を混ぜたまま食わせない。`-  const s = "a` と `+  const s = "b`
 * が並ぶと、片方の開いた引用符をもう片方が閉じてしまい、そこから先が全部
 * 文字列になる。変更前の姿（文脈＋削除）と変更後の姿（文脈＋追加）を別々の
 * コードとして食わせれば、どちらも本物のソースなので正しく解ける。
 */
export function highlightHunk(lines: DiffLine[], language: string | null): Piece[][] {
  const before = lines.filter((l) => l.kind !== "a");
  const after = lines.filter((l) => l.kind !== "d");
  const beforeTokens = highlightLines(before.map((l) => l.text).join("\n"), language);
  const afterTokens = highlightLines(after.map((l) => l.text).join("\n"), language);
  let b = 0, a = 0;
  return lines.map((l) => {
    // 文脈行は両方の流れに現れる。変更後の姿の方を採る（読む人が見るのは今の形）
    const piece = l.kind === "d" ? beforeTokens[b] : afterTokens[a];
    if (l.kind !== "a") b++;
    if (l.kind !== "d") a++;
    return piece ?? [{ text: l.text, cls: null }];
  });
}
