import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Markdown } from "./text";

const render = (src: string) => renderToStaticMarkup(<Markdown src={src} />);

test("表をヘッダと本文の行に分けて描く", () => {
  expect(render("| 名前 | 値 |\n| --- | --- |\n| a | 1 |\n| b | 2 |")).toBe(
    '<div class="md-table"><table><thead><tr><th>名前</th><th>値</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table></div>',
  );
});

test("区切り行のコロンで寄せを決める", () => {
  const html = render("| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |");
  expect(html).toContain('<td style="text-align:left">1</td>');
  expect(html).toContain('<td style="text-align:center">2</td>');
  expect(html).toContain('<td style="text-align:right">3</td>');
  expect(html).toContain("<td>4</td>");
});

test("先頭と末尾のパイプを省いた表も読む", () => {
  const html = render("a | b\n--- | ---\n1 | 2");
  expect(html).toContain("<th>a</th><th>b</th>");
  expect(html).toContain("<td>1</td><td>2</td>");
});

test("セルのバッククォートはコードにし、エスケープしたパイプは文字として残す", () => {
  expect(render("| x |\n| - |\n| `a` と a\\|b |")).toContain("<td><code>a</code> と a|b</td>");
});

test("列数をヘッダに合わせて埋めるか切り捨てる", () => {
  const html = render("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |");
  expect(html).toContain("<tr><td>1</td><td></td></tr>");
  expect(html).toContain("<tr><td>1</td><td>2</td></tr>");
  expect(html).not.toContain("<td>3</td>");
});

test("区切り行が続かないパイプ入りの行は段落のまま", () => {
  expect(render("a | b\nc")).toBe("<p>a | b</p><p>c</p>");
});

test("表の後ろの行は表に取り込まない", () => {
  expect(render("| a |\n| - |\n| 1 |\n\n## 次\n- x")).toBe(
    '<div class="md-table"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div><h2>次</h2><ul><li>x</li></ul>',
  );
});

test("箇条書きの直後の表は箇条書きを閉じてから描く", () => {
  expect(render("- x\n| a |\n| - |")).toBe(
    '<ul><li>x</li></ul><div class="md-table"><table><thead><tr><th>a</th></tr></thead></table></div>',
  );
});

test("見出し・箇条書き・段落は今までどおり描く", () => {
  expect(render("# T\n## S\n- a\n1. b\npara `c`")).toBe(
    "<h1>T</h1><h2>S</h2><ul><li>a</li></ul><ol><li>b</li></ol><p>para <code>c</code></p>",
  );
});
