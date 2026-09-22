import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { StatusDot } from "./StatusDot";

test("トーンのクラスと文言を出す", () => {
  const html = renderToStaticMarkup(<StatusDot tone="run" word="実行中" />);
  expect(html).toBe('<span class="st tone-run"><i aria-hidden="true"></i>実行中</span>');
});
