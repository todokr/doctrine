/**
 * ツールごとに「何を相手にしたか」を取る。
 * 引数の名前はツール定義に従うので、ツールが増えたらここに足す。
 */
const PARTS: Record<string, (i: Record<string, unknown>) => string[]> = {
  Bash: (i) => [str(i.command)],
  Read: (i) => [str(i.file_path)],
  Write: (i) => [str(i.file_path)],
  Edit: (i) => [str(i.file_path)],
  NotebookEdit: (i) => [str(i.notebook_path)],
  Grep: (i) => [str(i.pattern), str(i.path)],
  Glob: (i) => [str(i.pattern), str(i.path)],
  Agent: (i) => [str(i.description)],
  Task: (i) => [str(i.description)],
  Skill: (i) => [str(i.skill), str(i.args)],
  WebFetch: (i) => [str(i.url)],
  WebSearch: (i) => [str(i.query)],
  TodoWrite: () => [],
};

/** ツール呼び出しの「何を相手にしたか」。未知のツールは入力全体の JSON を1要素で返す。 */
export function toolInputParts(name: string, input: Record<string, unknown>): string[] {
  const known = PARTS[name];
  if (known) return known(input).filter((p) => p !== "");
  if (Object.keys(input).length === 0) return [];
  return [JSON.stringify(input)];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
