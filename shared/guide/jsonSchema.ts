import { z } from "zod/v4";
import { guideSchema } from "./schema.ts";

/** claude -p --json-schema に渡せる JSON Schema（draft-07）を返す。 */
export function guideJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(guideSchema, { target: "draft-7" });
}
