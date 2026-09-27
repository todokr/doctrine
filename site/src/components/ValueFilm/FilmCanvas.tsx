import type { CSSProperties, ReactNode } from 'react';
import {
  HEIGHT,
  WIDTH,
  easeInOut,
  easeOut,
  lerp,
  lerpView,
  placeImage,
  progress,
  window01,
  type View,
} from './timeline';

export type FilmImage = { src: string; width: number; height: number };

export type FilmImages = {
  general: FilmImage;
  question: FilmImage;
  pfd: FilmImage;
  review: FilmImage;
};

// 場面の区切り（秒）。各場面はこの「場面の中の時刻」で書き、下の SCHEDULE で動画上の区間へ伸び縮みさせる。
const S = {
  problem: [0, 5],
  bridge: [0, 3],
  hand: [5, 12],
  engine: [12, 20],
  judge: [20, 26],
  end: [26, 30],
} as const;

// 動画上で各場面を置く区間（秒）。
const SCHEDULE: Record<keyof typeof S, readonly [number, number]> = {
  problem: [0, 4.5],
  bridge: [4.5, 7.5],
  hand: [7.5, 14],
  engine: [14, 21],
  judge: [21, 26.5],
  end: [26.5, 30],
};

const local = (t: number, scene: keyof typeof S) => {
  const [a, b] = S[scene];
  const [c, d] = SCHEDULE[scene];
  return a + ((t - c) * (b - a)) / (d - c);
};

export function FilmCanvas({
  t,
  images,
  lazy = false,
}: {
  t: number;
  images: FilmImages;
  lazy?: boolean;
}) {
  const loading = lazy ? 'lazy' : 'eager';
  return (
    <div className="vf-canvas" style={{ width: WIDTH, height: HEIGHT }} data-t={t.toFixed(4)}>
      <Problem t={local(t, 'problem')} />
      <Bridge t={local(t, 'bridge')} images={images} />
      <HandOver t={local(t, 'hand')} images={images} loading={loading} />
      <Engine t={local(t, 'engine')} />
      <Judge t={local(t, 'judge')} images={images} loading={loading} />
      <EndCard t={local(t, 'end')} images={images} />
    </div>
  );
}

function Layer({ opacity, children }: { opacity: number; children: ReactNode }) {
  // 画像のデコード待ちで黒いコマが出ないよう、場面は外さずに不透明度だけで出し入れする。
  return (
    <div className="vf-layer" style={{ opacity, visibility: opacity <= 0 ? 'hidden' : 'visible' }}>
      {children}
    </div>
  );
}

function Caption({
  t,
  from,
  to,
  children,
  top = 96,
  size = 68,
}: {
  t: number;
  from: number;
  to: number;
  children: ReactNode;
  top?: number;
  size?: number;
}) {
  const o = window01(t, from, to, 0.35);
  const rise = (1 - easeOut(progress(t, from, from + 0.5))) * 24;
  return (
    <div
      className="vf-caption"
      style={{ top, fontSize: size, opacity: o, transform: `translate(-50%, ${rise}px)` }}
    >
      {children}
    </div>
  );
}

/* 場面 1: エージェントは速く書く。PR が積み上がり、人は追いつけない。 */

const PRS = [
  { n: 214, add: 1204, del: 310, title: 'タスクに期限を付ける' },
  { n: 215, add: 388, del: 92, title: 'Google でログインできるようにする' },
  { n: 216, add: 2051, del: 744, title: '一覧を無限スクロールにする' },
  { n: 217, add: 612, del: 140, title: 'タグで絞り込めるようにする' },
  { n: 218, add: 97, del: 33, title: '完了済みをまとめて消す' },
  { n: 219, add: 1530, del: 402, title: '共有リストを作る' },
  { n: 220, add: 845, del: 261, title: 'ダークモードに対応する' },
  { n: 221, add: 433, del: 58, title: '通知の設定画面を作る' },
];

function Problem({ t }: { t: number }) {
  const o = window01(t, S.problem[0] - 1, S.problem[1]);
  return (
    <Layer opacity={o}>
      <Caption t={t} from={-1} to={2.6}>
        エージェントは、速く書く。
      </Caption>
      <Caption t={t} from={2.6} to={5}>
        でも、<span className="vf-em">理解</span>が追いつかない。
      </Caption>
      {PRS.map((pr, i) => {
        const appear = 0.3 + i * 0.42;
        const p = easeOut(progress(t, appear, appear + 0.45));
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = 300 + col * 680 + (1 - p) * 80;
        const y = 280 + row * 150 - (1 - p) * 40;
        return (
          <div
            key={pr.n}
            className="vf-pr"
            style={{ left: x, top: y, opacity: p, transform: `rotate(${(i % 3) - 1}deg)` }}
          >
            <span className="vf-pr-num">#{pr.n}</span>
            <span className="vf-pr-title">{pr.title}</span>
            <span className="vf-pr-diff">
              <span className="vf-add">+{pr.add.toLocaleString('en-US')}</span>{' '}
              <span className="vf-del">−{pr.del}</span>
            </span>
          </div>
        );
      })}
      <div
        className="vf-counter"
        style={{ opacity: easeOut(progress(t, 2.8, 3.4)) }}
      >
        レビュー待ち <strong>{Math.min(PRS.length, Math.max(0, Math.floor((t - 0.3) / 0.42) + 1))}</strong> 件
      </div>
    </Layer>
  );
}

/* 転換: doctrine が答えを出す。 */

export const BRIDGE_COPY = '理解を追いつかせる。';

function Bridge({ t, images }: { t: number; images: FilmImages }) {
  const o = window01(t, S.bridge[0], S.bridge[1], 0.4);
  const rise = easeOut(progress(t, 0, 0.7));
  const text = easeOut(progress(t, 0.35, 1));
  return (
    <Layer opacity={o}>
      <div className="vf-glow vf-glow-center" />
      <img
        className="vf-general vf-general-center"
        src={images.general.src}
        alt=""
        draggable={false}
        style={{ opacity: rise, transform: `translate(-50%, ${(1 - rise) * 60}px)` }}
      />
      <div className="vf-bridge" style={{ opacity: text, transform: `translate(-50%, ${(1 - text) * 16}px)` }}>
        <span className="vf-em">doctrine</span> で、{BRIDGE_COPY}
      </div>
    </Layer>
  );
}

/* 場面 2: Epic を渡すと、論点が質問で返り、答えると PFD に分解される。 */

function ScreenWindow({
  image,
  view,
  label,
  loading,
  style,
  children,
}: {
  image: FilmImage;
  view: View;
  label: string;
  loading: 'lazy' | 'eager';
  style?: CSSProperties;
  children?: (place: ReturnType<typeof placeImage>) => ReactNode;
}) {
  const W = 1500;
  const H = 720;
  const place = placeImage(view, W, H, image.width / image.height);
  return (
    <div className="vf-window" style={{ width: W, height: H + 44, ...style }}>
      <div className="vf-window-bar">
        <i />
        <i />
        <i />
        <span>{label}</span>
      </div>
      <div className="vf-window-body" style={{ width: W, height: H }}>
        <img
          src={image.src}
          alt=""
          loading={loading}
          draggable={false}
          style={{ left: place.left, top: place.top, width: place.width, height: place.height }}
        />
        {children?.(place)}
      </div>
    </div>
  );
}

function HandOver({ t, images, loading }: { t: number; images: FilmImages; loading: 'lazy' | 'eager' }) {
  const o = window01(t, S.hand[0], S.hand[1]);
  const qOpacity = window01(t, 5, 8.6, 0.4);
  const pOpacity = window01(t, 8.6, 12, 0.4);
  const qView = lerpView(
    { cx: 0.57, cy: 0.36, w: 0.86 },
    { cx: 0.35, cy: 0.56, w: 0.4 },
    easeInOut(progress(t, 5.6, 8.4)),
  );
  const pView = lerpView(
    { cx: 0.5, cy: 0.45, w: 1 },
    { cx: 0.7, cy: 0.4, w: 0.58 },
    easeInOut(progress(t, 9.2, 11.8)),
  );
  return (
    <Layer opacity={o}>
      <Caption t={t} from={5} to={8.6} size={60}>
        Epic を渡すと、まず<span className="vf-em">論点が質問で</span>返ってくる。
      </Caption>
      <Caption t={t} from={8.6} to={12} size={60}>
        答えると、PR 1 つ分ずつの<span className="vf-em">プロセスに分解</span>される。
      </Caption>
      <div className="vf-layer" style={{ opacity: qOpacity }}>
        <ScreenWindow image={images.question} view={qView} label="Intake — 回答待ち" loading={loading} style={{ left: 210, top: 230 }} />
      </div>
      <div className="vf-layer" style={{ opacity: pOpacity }}>
        <ScreenWindow image={images.pfd} view={pView} label="Intake — PFD" loading={loading} style={{ left: 210, top: 230 }} />
      </div>
    </Layer>
  );
}

/* 場面 3: 依存関係に沿った投入、conflict の自動修復、利用上限からの再開。人の手は動かない。 */

type Node = { id: string; x: number; y: number; label: string };

const NODES: Node[] = [
  { id: 'a', x: 250, y: 420, label: '期限の列を足す' },
  { id: 'b', x: 250, y: 700, label: '通知設定を足す' },
  { id: 'c', x: 700, y: 330, label: '期限の API' },
  { id: 'd', x: 700, y: 560, label: '期限順に並べる' },
  { id: 'e', x: 700, y: 790, label: '通知ジョブ' },
  { id: 'f', x: 1150, y: 450, label: '期限の入力欄' },
  { id: 'g', x: 1150, y: 700, label: 'リマインダー画面' },
  { id: 'h', x: 1600, y: 575, label: '期限切れを通知' },
];

const EDGES: [string, string][] = [
  ['a', 'c'],
  ['a', 'd'],
  ['b', 'd'],
  ['b', 'e'],
  ['c', 'f'],
  ['d', 'f'],
  ['d', 'g'],
  ['e', 'g'],
  ['f', 'h'],
  ['g', 'h'],
];

// 各タスクが走り始める時刻と、マージされる時刻。d は conflict を直し、g は利用上限で待ってから再開する。
const RUN: Record<string, [number, number]> = {
  a: [12.3, 13.1],
  b: [12.5, 13.4],
  c: [13.3, 14.4],
  d: [13.6, 16.6],
  e: [13.6, 14.6],
  f: [16.8, 17.7],
  g: [17.0, 19.3],
  h: [19.4, 20.1],
};

const CONFLICT: [number, number] = [14.9, 16.1];
const LIMIT: [number, number] = [17.5, 18.8];

type NodeState = 'idle' | 'running' | 'conflict' | 'waiting' | 'merged';

function nodeState(id: string, t: number): NodeState {
  const [start, end] = RUN[id];
  if (t >= end) return 'merged';
  if (t < start) return 'idle';
  if (id === 'd' && t >= CONFLICT[0] && t < CONFLICT[1]) return 'conflict';
  if (id === 'g' && t >= LIMIT[0] && t < LIMIT[1]) return 'waiting';
  return 'running';
}

const BADGE: Record<NodeState, string> = {
  idle: '入力待ち',
  running: '実行中',
  conflict: 'conflict を修復中',
  waiting: '上限待ち',
  merged: 'マージ済み',
};

function Engine({ t }: { t: number }) {
  const o = window01(t, S.engine[0], S.engine[1]);
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  return (
    <Layer opacity={o}>
      <Caption t={t} from={12} to={14.7} size={60}>
        依存関係に沿って、<span className="vf-em">次のタスクが自動で</span>投入される。
      </Caption>
      <Caption t={t} from={14.7} to={17.3} size={60}>
        conflict したら、<span className="vf-em">取り込んで直す</span>。
      </Caption>
      <Caption t={t} from={17.3} to={20} size={60}>
        利用上限に当たっても、<span className="vf-em">待って再開</span>する。
      </Caption>
      <svg className="vf-graph" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {EDGES.map(([from, to]) => {
          const a = byId[from];
          const b = byId[to];
          const flow = progress(t, RUN[from][1], RUN[from][1] + 0.5);
          const x1 = a.x + 150;
          const x2 = b.x - 150;
          const mid = (x1 + x2) / 2;
          const d = `M ${x1} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${x2} ${b.y}`;
          return (
            <g key={`${from}-${to}`}>
              <path d={d} className="vf-edge" />
              <path d={d} className="vf-edge-live" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - flow} />
            </g>
          );
        })}
      </svg>
      {NODES.map((n) => {
        const state = nodeState(n.id, t);
        const pop = easeOut(progress(t, RUN[n.id][1], RUN[n.id][1] + 0.3));
        const scale = state === 'merged' ? 1 + (1 - pop) * 0.08 : 1;
        return (
          <div
            key={n.id}
            className={`vf-node vf-node-${state}`}
            style={{ left: n.x - 150, top: n.y - 52, transform: `scale(${scale})` }}
          >
            <span className="vf-node-label">{n.label}</span>
            <span className="vf-node-badge">
              {state === 'merged' ? '✓ ' : state === 'waiting' ? '⏸ ' : ''}
              {BADGE[state]}
            </span>
          </div>
        );
      })}
      <div className="vf-footnote" style={{ opacity: window01(t, 13, 20, 0.5) }}>
        この間、人はコマンドを 1 つも叩かない
      </div>
    </Layer>
  );
}

/* 場面 4: 人は Review Guide で理解してから承認する。 */

function Judge({ t, images, loading }: { t: number; images: FilmImages; loading: 'lazy' | 'eager' }) {
  const o = window01(t, S.judge[0], S.judge[1]);
  const toDiagram = easeInOut(progress(t, 20.4, 22.4));
  const toButton = easeInOut(progress(t, 23.2, 24.6));
  const view = lerpView(
    lerpView({ cx: 0.6, cy: 0.3, w: 0.8 }, { cx: 0.36, cy: 0.22, w: 0.36 }, toDiagram),
    { cx: 0.75, cy: 0.777, w: 0.5 },
    toButton,
  );
  // 「承認する」ボタンの画像上の位置。
  const button = { x: 0.969, y: 0.981 };
  const click = progress(t, 25.0, 25.35);
  const clicked = t >= 25.2;
  return (
    <Layer opacity={o}>
      <Caption t={t} from={20} to={23.2} size={60}>
        届くのは、<span className="vf-em">何を・なぜ変えたか</span>の説明。
      </Caption>
      <Caption t={t} from={23.2} to={26} size={60}>
        人は、<span className="vf-em">理解してから</span>判断する。
      </Caption>
      <ScreenWindow image={images.review} view={view} label="Review Guide" loading={loading} style={{ left: 210, top: 230 }}>
        {(place) => {
          const bx = place.left + button.x * place.width;
          const by = place.top + button.y * place.height;
          const cursorIn = easeOut(progress(t, 24.2, 24.9));
          const cx = lerp(bx + 260, bx, cursorIn);
          const cy = lerp(by + 180, by, cursorIn);
          return (
            <>
              <div
                className="vf-ring"
                style={{
                  left: bx,
                  top: by,
                  opacity: clicked ? 1 - progress(t, 25.2, 26) : 0,
                  transform: `translate(-50%, -50%) scale(${1 + progress(t, 25.2, 26) * 1.6})`,
                }}
              />
              <svg
                className="vf-cursor"
                width="44"
                height="44"
                viewBox="0 0 24 24"
                style={{
                  left: cx - 6,
                  top: cy - 4,
                  opacity: progress(t, 24.1, 24.3),
                  transform: `scale(${1 - Math.sin(click * Math.PI) * 0.15})`,
                }}
              >
                <path d="M5 3l14 8-6 1.5L10 19z" />
              </svg>
            </>
          );
        }}
      </ScreenWindow>
    </Layer>
  );
}

/* 場面 5: 締め。 */

function EndCard({ t, images }: { t: number; images: FilmImages }) {
  const o = window01(t, S.end[0], S.end[1], 0.5);
  const inX = easeOut(progress(t, 26.1, 26.9));
  const text = easeOut(progress(t, 26.5, 27.3));
  return (
    <Layer opacity={o}>
      <div className="vf-glow" />
      <img
        className="vf-general"
        src={images.general.src}
        alt=""
        draggable={false}
        style={{ opacity: inX, transform: `translateX(${(1 - inX) * -60}px)` }}
      />
      <div className="vf-end" style={{ opacity: text, transform: `translateY(${(1 - text) * 20}px)` }}>
        <div className="vf-end-title">
          作業は渡す、
          <br />
          理解は譲らない
        </div>
        <div className="vf-end-sub">
          <strong>doctrine</strong> — 手元のマシンで動く software factory
        </div>
      </div>
    </Layer>
  );
}
