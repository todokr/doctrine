import { canonicalJson, type Pfd } from "../../../../shared/intake/pfd.ts";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** intake_drafts.hash に入れる値。canonicalJson(pfd) の SHA-256。 */
export function pfdHash(pfd: Pfd): Promise<string> {
  return sha256Hex(canonicalJson(pfd));
}
