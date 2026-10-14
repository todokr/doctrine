import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { RemoveConfirm, removeConfirmText } from "./components/RemoveWorktree";

const noop = () => {};

describe("removeConfirmText", () => {
  test("dirty が true・null なら失われることを書き、false なら変更が無いと書く", () => {
    expect(removeConfirmText(true)).toBe("未コミットの変更があります。削除すると失われます。");
    expect(removeConfirmText(null)).toBe("未コミットの変更があれば、削除すると失われます。");
    expect(removeConfirmText(false)).toBe("未コミットの変更はありません。");
  });
});

describe("RemoveConfirm", () => {
  test("パスと確認の文言と削除のボタンを出す", () => {
    const html = renderToStaticMarkup(
      <RemoveConfirm path="/w/t-1" dirty={true} pending={false} onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toContain("/w/t-1");
    expect(html).toContain("未コミットの変更があります。削除すると失われます。");
    expect(html).toContain("削除する");
  });
});
