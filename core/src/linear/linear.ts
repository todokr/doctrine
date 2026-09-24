import { z } from "zod";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

const errorsSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).min(1),
});

/** Linear の GraphQL を 1 回呼び、data を schema で検証して返す。 */
export async function linearGraphql<T>(
  o: { apiKey: string; fetch: typeof fetch },
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const res = await o.fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: o.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json: unknown;
  let readable = true;
  try {
    json = JSON.parse(text);
  } catch {
    readable = false;
  }
  if (readable) {
    const failed = errorsSchema.safeParse(json);
    if (failed.success) {
      throw new Error(`${label}: ${failed.data.errors.map((e) => e.message).join("; ")}`);
    }
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
  if (!readable) {
    throw new Error(`${label} の応答を JSON として読めません: ${text.slice(0, 200)}`);
  }
  const parsed = z.object({ data: schema }).safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${label} の応答が想定した形ではありません: ${detail}`);
  }
  return parsed.data.data as T;
}
