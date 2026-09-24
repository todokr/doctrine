export type LinearCall = {
  url: string;
  headers: Headers;
  query: string;
  variables: Record<string, unknown>;
};

/**
 * query ごとに応答を返す。object なら { data: object } を 200 で返す。
 * Response ならそのまま返す。Error なら投げる。
 * undefined なら「想定外の Linear 呼び出し」で投げる。
 */
export function fakeLinear(
  respond: (
    query: string,
    variables: Record<string, unknown>,
  ) => object | Response | Error | undefined,
): { fetch: typeof fetch; calls: LinearCall[] } {
  const calls: LinearCall[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const call: LinearCall = {
      url: String(input),
      headers: new Headers(init?.headers),
      query: body.query ?? "",
      variables: body.variables ?? {},
    };
    calls.push(call);
    const res = respond(call.query, call.variables);
    if (res === undefined) {
      return Promise.reject(new Error(`想定外の Linear 呼び出し: ${call.query}`));
    }
    if (res instanceof Error) return Promise.reject(res);
    if (res instanceof Response) return Promise.resolve(res);
    return Promise.resolve(new Response(JSON.stringify({ data: res }), { status: 200 }));
  };
  return { fetch: fake as typeof fetch, calls };
}
