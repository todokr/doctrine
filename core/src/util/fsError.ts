/** fs / net の呼び出しが「対象が無い」（ENOENT）で失敗したか。 */
export function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
