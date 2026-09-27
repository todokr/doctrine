// トップページの動画（src/components/ValueFilm）を mp4 に書き出す。
//
//   pnpm render:film                     ビルドして 30 秒・30fps の mp4 を film-out/doctrine.mp4 に出す
//   pnpm render:film --frames 0,12,27.5  指定した時刻の静止画だけを film-out/ に出す
//   pnpm render:film --url http://localhost:4400/doctrine/film/  起動済みのサーバーを使う（ビルドを省く）
//
// インストール済みの Google Chrome と ffmpeg を使う。
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import config from '../astro.config.mjs';

const DURATION = 30;
const FPS = 30;

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    frames: { type: 'string' },
    out: { type: 'string', default: 'film-out' },
  },
});

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });

// astro preview はプロジェクトごとに 1 つのデーモンとして動き、起動済みならその URL を返すだけで終わる。
const startPreview = async () => {
  await run('pnpm', ['astro', 'build']);
  const output = await new Promise((resolve, reject) => {
    let text = '';
    const child = spawn('pnpm', ['astro', 'preview'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => (text += chunk));
    child.on('exit', (code) => (code === 0 ? resolve(text) : reject(new Error(`astro preview exited with ${code}`))));
  });
  const origin = output.match(/http:\/\/localhost:\d+/)?.[0];
  if (!origin) throw new Error(`preview の URL が読めない: ${output}`);
  return { origin, startedHere: !output.includes('already running') };
};

const preview = values.url ? null : await startPreview();
const url = values.url ?? `${preview.origin}${config.base ?? ''}/film/`;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.__setTime === 'function');
  await page.evaluate(async () => {
    document.querySelector('astro-dev-toolbar')?.remove();
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
  });

  const shoot = async (t) => {
    await page.evaluate((time) => window.__setTime(time), t);
    return page.screenshot({ type: 'png' });
  };

  await mkdir(values.out, { recursive: true });

  if (values.frames) {
    for (const t of values.frames.split(',').map(Number)) {
      const path = `${values.out}/frame-${t.toFixed(2)}.png`;
      await writeFile(path, await shoot(t));
      console.log(path);
    }
  } else {
    const path = `${values.out}/doctrine.mp4`;
    const ffmpeg = spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', path],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const done = new Promise((resolve, reject) =>
      ffmpeg.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))),
    );
    // ffmpeg が先に落ちたときは、書き込みの EPIPE ではなく done の失敗として finally まで届ける。
    done.catch(() => {});
    ffmpeg.stdin.on('error', () => {});
    const total = DURATION * FPS;
    for (let i = 0; i < total && ffmpeg.exitCode === null && ffmpeg.signalCode === null; i++) {
      const png = await shoot(i / FPS);
      if (!ffmpeg.stdin.write(png)) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
      if (i % FPS === 0) process.stdout.write(`\r${i / FPS}s / ${DURATION}s`);
    }
    ffmpeg.stdin.end();
    await done;
    console.log(`\n${path}`);
  }
} finally {
  await browser.close();
  if (preview?.startedHere) await run('pnpm', ['astro', 'preview', 'stop']);
}
