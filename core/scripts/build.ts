import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;
const bundle = `${dist}/dctld.mjs`;
const config = `${dist}/dctld.sea.json`;
const output = `${dist}/dctld`;

// yaml は CJS のまま `require("process")` を呼ぶ。ESM の出力には require が無いので差し込む。
const banner =
  'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [`${root}src/daemon/main.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  outfile: bundle,
  banner: { js: banner },
});
await writeFile(
  config,
  JSON.stringify({
    main: bundle,
    mainFormat: "module",
    output,
    disableExperimentalSEAWarning: true,
  }),
);
// Homebrew の node は SEA を無効にしてビルドされている。mise の node（公式の配布物）を使う。
const sea = spawnSync(process.execPath, ["--build-sea", config], { encoding: "utf8" });
if (sea.status !== 0) {
  const hint = sea.stderr.includes("disabled")
    ? `\n${process.execPath} は SEA を無効にしてビルドされています。mise run core:build で mise の node を使ってください`
    : "";
  throw new Error(`node --build-sea が失敗しました\n${sea.stdout}${sea.stderr}${hint}`);
}
// macOS は埋め込みで署名が壊れ、署名し直さないと起動時に SIGKILL される。
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", "--force", output], { stdio: "inherit" });
}
await rm(bundle);
await rm(config);
