import { describe, expect, test } from "vitest";
import { guideSchema } from "../../shared/guide/schema.ts";

const minimalGuide = {
  version: 1,
  why: "利用者が待たされる原因を取り除く",
  what: [],
  how: [],
  readingOrder: [],
  decisions: [],
  risks: [],
  tests: [],
  diagrams: [],
};

describe("shared/guide の guideSchema", () => {
  test("最小のガイドが parse を通る", () => {
    expect(guideSchema.parse(minimalGuide)).toEqual(minimalGuide);
  });

  test("知らないキーがあったら落ちる", () => {
    expect(guideSchema.safeParse({ ...minimalGuide, summary: "要約" }).success).toBe(false);
  });
});
