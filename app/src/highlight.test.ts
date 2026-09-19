import { describe, expect, test } from "vitest";
import { SAMPLE_DIFF } from "./fixtures";
import { highlightHunk, highlightLines, languageOf } from "./highlight";
import { diffLines } from "./model";
import { buildDiff } from "./patch";

/** 行のトークンを、元のテキストに戻す */
const joined = (pieces: { text: string }[]) => pieces.map((p) => p.text).join("");

describe("languageOf", () => {
  test("拡張子から決める", () => {
    expect(languageOf("app/src/model.ts")).toBe("typescript");
    expect(languageOf("app/src/App.tsx")).toBe("tsx");
    expect(languageOf("app/src-tauri/src/lib.rs")).toBe("rust");
    expect(languageOf(".github/workflows/ci.yml")).toBe("yaml");
  });
  test("知らない拡張子と拡張子なしは null（色を付けない）", () => {
    expect(languageOf("LICENSE")).toBeNull();
    expect(languageOf("a/b/.gitignore")).toBeNull();
    expect(languageOf("data.parquet")).toBeNull();
  });
});

describe("highlightLines", () => {
  test("行をまたぐブロックコメントは、続きの行にも色が付く", () => {
    const lines = highlightLines("/* ひとつめ\n   ふたつめ */\nconst a = 1;", "typescript");
    expect(lines).toHaveLength(3);
    expect(lines[0].every((p) => p.cls === "com")).toBe(true);
    expect(lines[1].every((p) => p.cls === "com")).toBe(true);
    expect(lines[2].some((p) => p.cls === "kw")).toBe(true);
  });

  test("知らない言語でも行数は保ち、色を付けないだけ", () => {
    const lines = highlightLines("a\nb\nc", null);
    expect(lines.map(joined)).toEqual(["a", "b", "c"]);
    expect(lines.flat().every((p) => p.cls === null)).toBe(true);
  });

  test("元のテキストを1文字も落とさない", () => {
    const code = 'const s = "あ\\tい";\n// コメント\n';
    expect(highlightLines(code, "typescript").map(joined).join("\n")).toBe(code);
  });
});

describe("highlightHunk", () => {
  const hunk = buildDiff(SAMPLE_DIFF).find((f) => f.path === "src/keep.ts")!.hunks[0];
  const lines = diffLines(hunk);

  test("hunk の行数ぶんだけ返し、テキストは変えない", () => {
    const tokens = highlightHunk(lines, "typescript");
    expect(tokens).toHaveLength(lines.length);
    expect(tokens.map(joined)).toEqual(lines.map((l) => l.text));
  });

  test("削除行と追加行を別々に解釈するので、対になる変更で文字列が繋がらない", () => {
    // `-... => \`hello ${name}\`;` と `+... => \`hi ${name}!\`;` を1つの流れに
    // 混ぜると、片方のバッククォートがもう片方を閉じて以降が全部文字列になる
    const tokens = highlightHunk(lines, "typescript");
    const added = tokens[lines.findIndex((l) => l.kind === "a")];
    expect(added.some((p) => p.cls === "kw")).toBe(true);
  });

  test("文脈行は変更後の姿として解釈する", () => {
    const tokens = highlightHunk(lines, "typescript");
    // 先頭2行はブロックコメント（変更前・変更後どちらの流れにも出る）
    expect(tokens[0].every((p) => p.cls === "com")).toBe(true);
    expect(tokens[1].every((p) => p.cls === "com")).toBe(true);
  });
});
