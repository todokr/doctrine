import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url));
const bin = join(homedir(), ".local", "bin");
const path = join(bin, "dctld");

// このチェックアウトのソースを node で直接走らせる起動スクリプトを置く。
await mkdir(bin, { recursive: true });
await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${main}' "$@"\n`);
await chmod(path, 0o755);
console.log(`${path} を置きました`);
if (!(process.env.PATH ?? "").split(":").includes(bin)) {
  console.log(
    `${bin} が PATH にありません。シェルの設定に export PATH="${bin}:$PATH" を足してください`,
  );
}
