import type { FighterView, MatchView, PoseFrame, SimEvent } from '@spar/protocol';
import {
  COLORS, FONT, MONO, PIP, RING, STAGE_H, STAGE_W, clamp, damp, punchLabel, rangeScale, withAlpha, type Vec,
} from './theme';
import { fromPoseFrame, synthPose } from './pose';
import { drawShadow, drawSkeleton, type Projection } from './shadow';
import { createFx, type FxAnchors } from './fx';
import { createHud } from './hud';

export interface RenderStats {
  rttMs: number;
  rollbackFrames: number;
  framesAhead?: number;
}

export interface RenderNames {
  local?: string;
  opponent?: string;
}

export interface DrawArgs {
  view: MatchView;
  localPlayer: 0 | 1;
  opponentPose: PoseFrame | null;
  localPose: PoseFrame | null;
  inputKind?: 'camera' | 'keyboard';
  /** New (deduplicated) sim events since the last draw. */
  events: SimEvent[];
  nowMs: number;
  stalled: boolean;
  stats?: RenderStats;
  names?: RenderNames;
}

export interface Renderer {
  readonly canvas: HTMLCanvasElement;
  draw(a: DrawArgs): void;
  /** Re-fit the backing store to the parent element and devicePixelRatio. Called automatically. */
  resize(): void;
  dispose(): void;
}

const KNOCKDOWN_COUNT_FRAMES = 600;

/** Set once per state change; INTRO overlay timing runs off it since roundFrame stays 0 in INTRO. */
interface Anim {
  lastNow: number;
  oppScale: number;
  down: [number, number];
  boost: [number, number];
  lastState: MatchView['state'] | null;
  introStart: number;
  anchors: FxAnchors;
}

/** Local player's own "things happen to you" anchor: lower-middle of the stage. */
const LOCAL_ANCHOR: Vec = { x: STAGE_W / 2, y: 610 };

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const hud = createHud();
  const fx = createFx();

  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let scale = 1;
  let ox = 0;
  let oy = 0;

  const anim: Anim = {
    lastNow: 0,
    oppScale: 1,
    down: [0, 0],
    boost: [0, 0],
    lastState: null,
    introStart: -1,
    anchors: {
      oppHead: { x: RING.oppX, y: 330 },
      oppBody: { x: RING.oppX, y: 520 },
      oppWrists: { L: { x: RING.oppX + 90, y: 420 }, R: { x: RING.oppX - 90, y: 420 } },
      oppGloveR: 40,
      local: LOCAL_ANCHOR,
    },
  };

  function resize(): void {
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || canvas.clientWidth || 1280;
    const h = parent?.clientHeight || canvas.clientHeight || Math.round((w * 9) / 16);
    dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (w === cssW && h === cssH && canvas.width === Math.round(w * dpr)) return;
    cssW = w;
    cssH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    scale = Math.min(cssW / STAGE_W, cssH / STAGE_H);
    ox = (cssW - STAGE_W * scale) / 2;
    oy = (cssH - STAGE_H * scale) / 2;
  }

  const ro =
    typeof ResizeObserver !== 'undefined' && canvas.parentElement
      ? new ResizeObserver(() => resize())
      : null;
  ro?.observe(canvas.parentElement as Element);
  const onWinResize = () => resize();
  if (typeof window !== 'undefined') window.addEventListener('resize', onWinResize);
  resize();

  /** Stage transform (virtual 1600×900 → device pixels), optionally shaken. */
  function setStage(shake: Vec): void {
    ctx!.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + shake.x * scale), dpr * (oy + shake.y * scale));
  }

  function drawRing(nowMs: number): void {
    const c = ctx!;
    // floor
    const floor = c.createLinearGradient(0, RING.horizonY, 0, STAGE_H);
    floor.addColorStop(0, '#15171e');
    floor.addColorStop(0.55, '#111319');
    floor.addColorStop(1, '#0a0b0e');
    c.fillStyle = floor;
    c.fillRect(0, RING.horizonY, STAGE_W, STAGE_H - RING.horizonY);
    // back wall
    const wall = c.createLinearGradient(0, 0, 0, RING.horizonY);
    wall.addColorStop(0, '#0b0c10');
    wall.addColorStop(1, '#101219');
    c.fillStyle = wall;
    c.fillRect(0, 0, STAGE_W, RING.horizonY);
    // spotlight pool under the opponent
    c.save();
    c.translate(RING.oppX, RING.floorY + 10);
    c.scale(1, 0.22);
    const pool = c.createRadialGradient(0, 0, 0, 0, 0, 720);
    pool.addColorStop(0, withAlpha('#ffffff', 0.09));
    pool.addColorStop(0.5, withAlpha(COLORS.blue, 0.05));
    pool.addColorStop(1, withAlpha('#000000', 0));
    c.fillStyle = pool;
    c.beginPath();
    c.arc(0, 0, 720, 0, Math.PI * 2);
    c.fill();
    c.restore();
    // ropes: three sagging lines, corner-tinted at the ends
    c.lineWidth = 3;
    c.lineCap = 'round';
    RING.ropesY.forEach((y, i) => {
      const g = c.createLinearGradient(0, 0, STAGE_W, 0);
      g.addColorStop(0, withAlpha(COLORS.red, 0.22));
      g.addColorStop(0.2, withAlpha('#ffffff', 0.09));
      g.addColorStop(0.8, withAlpha('#ffffff', 0.09));
      g.addColorStop(1, withAlpha(COLORS.blue, 0.22));
      c.strokeStyle = g;
      c.beginPath();
      c.moveTo(0, y);
      c.quadraticCurveTo(STAGE_W / 2, y + 16 + i * 3 + Math.sin(nowMs / 900 + i) * 1.5, STAGE_W, y);
      c.stroke();
    });
    // corner posts
    for (const [x, color] of [[24, COLORS.red], [STAGE_W - 24, COLORS.blue]] as Array<[number, string]>) {
      c.fillStyle = withAlpha(color, 0.35);
      c.fillRect(x - 5, RING.ropesY[0] - 40, 10, RING.ropesY[2] - RING.ropesY[0] + 80);
    }
    // vignette
    const vig = c.createRadialGradient(STAGE_W / 2, STAGE_H / 2, STAGE_H * 0.35, STAGE_W / 2, STAGE_H / 2, STAGE_W * 0.7);
    vig.addColorStop(0, withAlpha('#000000', 0));
    vig.addColorStop(1, withAlpha('#000000', 0.6));
    c.fillStyle = vig;
    c.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  function drawPip(me: FighterView, localPose: PoseFrame | null, localPlayer: 0 | 1, nowMs: number): void {
    const c = ctx!;
    c.save();
    c.fillStyle = withAlpha(COLORS.panel, 0.88);
    c.strokeStyle = COLORS.border;
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(PIP.x, PIP.y, PIP.w, PIP.h, 10);
    c.fill();
    c.stroke();
    c.clip();
    const pose = localPose ? fromPoseFrame(localPose) : synthPose(me, nowMs);
    const down = anim.down[localPlayer];
    const proj: Projection = {
      cx: PIP.x + PIP.w / 2,
      floorY: PIP.y + PIP.h - 24,
      w: PIP.w * 0.9,
      h: PIP.h * 0.86,
      mirror: true,
      dy: down * PIP.h * 0.3,
      tilt: down * 0.2,
    };
    drawSkeleton(c, pose, proj, COLORS.red, localPose ? 0.35 : 0);
    // tag + phase label
    c.font = `800 12px ${FONT}`;
    c.textAlign = 'left';
    c.fillStyle = COLORS.red;
    c.fillText('YOU', PIP.x + 10, PIP.y + 18);
    c.fillStyle = COLORS.dim;
    c.textAlign = 'right';
    c.fillText(localPose ? 'CAMERA' : 'KEYS', PIP.x + PIP.w - 10, PIP.y + 18);
    const phase = me.phase;
    const label =
      phase === 'IDLE'
        ? me.guardHigh ? 'GUARD HIGH' : 'GUARD LOW'
        : phase === 'STUNNED' || phase === 'KNOCKDOWN'
          ? phase
          : `${punchLabel(me.punch, me.body)} · ${phase}`;
    c.font = `800 14px ${MONO}`;
    c.textAlign = 'center';
    c.fillStyle =
      phase === 'ACTIVE' ? COLORS.red
        : phase === 'STARTUP' ? COLORS.amber
          : phase === 'STUNNED' || phase === 'KNOCKDOWN' ? COLORS.amber
            : me.head !== 'CENTER' ? COLORS.cyan
              : COLORS.text;
    const headTag = me.head === 'CENTER' ? '' : ` · ${me.head}`;
    c.fillText(label + headTag, PIP.x + PIP.w / 2, PIP.y + PIP.h - 8);
    c.restore();
  }

  function bigText(text: string, x: number, y: number, size: number, color: string, weight = 900, font = FONT): void {
    const c = ctx!;
    c.font = `${weight} ${size}px ${font}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(3, size * 0.1);
    c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  function dim(alpha: number): void {
    ctx!.fillStyle = withAlpha('#000000', alpha);
    ctx!.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  function scoreLine(view: MatchView, localPlayer: 0 | 1, idx: number, names: Required<RenderNames>): string {
    const a = view.scores[localPlayer][idx];
    const b = view.scores[1 - localPlayer][idx];
    return `ROUND ${idx + 1}   ${names.local} ${a} — ${b} ${names.opponent}`;
  }

  function drawStateOverlay(a: DrawArgs, names: Required<RenderNames>, nowMs: number): void {
    const c = ctx!;
    const { view, localPlayer } = a;
    c.save();
    switch (view.state) {
      case 'INTRO': {
        const age = anim.introStart >= 0 ? nowMs - anim.introStart : 0;
        dim(0.35);
        bigText(`ROUND ${view.round}`, STAGE_W / 2, 370, 40, COLORS.dim, 800);
        const fight = age >= 1250;
        const pulse = 1 + 0.04 * Math.sin(nowMs / 110);
        c.save();
        c.translate(STAGE_W / 2, 460);
        c.scale(pulse, pulse);
        bigText(fight ? 'FIGHT!' : 'READY…', 0, 0, fight ? 120 : 96, fight ? COLORS.red : COLORS.text);
        c.restore();
        break;
      }
      case 'REST': {
        dim(0.45);
        bigText('CORNER', STAGE_W / 2, 360, 44, COLORS.dim, 800);
        bigText(`${view.clockSec} s`, STAGE_W / 2, 440, 72, COLORS.text, 800, MONO);
        const idx = view.scores[0].length - 1;
        if (idx >= 0) bigText(scoreLine(view, localPlayer, idx, names), STAGE_W / 2, 520, 28, COLORS.text, 700);
        if (idx >= 1) {
          const tot = (p: 0 | 1) => view.scores[p].reduce((s, v) => s + v, 0);
          bigText(`TOTAL ${tot(localPlayer)} — ${tot((1 - localPlayer) as 0 | 1)}`, STAGE_W / 2, 560, 22, COLORS.dim, 700);
        }
        break;
      }
      case 'OVER': {
        dim(0.5);
        const won = view.winner === localPlayer;
        const draw = view.winner === 'DRAW';
        const title = draw ? 'DRAW' : won ? 'YOU WIN' : view.winner === null ? 'MATCH OVER' : 'YOU LOSE';
        const color = draw ? COLORS.text : won ? COLORS.gold : COLORS.red;
        bigText(title, STAGE_W / 2, 380, 120, color);
        const method =
          view.method === 'KO' || view.method === 'TKO'
            ? `by ${view.method} in round ${view.round}`
            : view.method === 'DECISION' ? 'by decision' : '';
        if (method) bigText(method, STAGE_W / 2, 460, 30, COLORS.text, 700);
        const rounds = view.scores[0].length;
        if (rounds > 0) {
          const parts: string[] = [];
          for (let i = 0; i < rounds; i++) {
            parts.push(`R${i + 1} ${view.scores[localPlayer][i]}–${view.scores[1 - localPlayer][i]}`);
          }
          bigText(parts.join('   ·   '), STAGE_W / 2, 520, 24, COLORS.dim, 700, MONO);
        }
        break;
      }
      case 'FIGHTING':
        break;
    }
    // 10-count while someone is down
    for (const i of [0, 1] as const) {
      const f = view.fighters[i];
      if (f.phase !== 'KNOCKDOWN') continue;
      const count = clamp(Math.floor((KNOCKDOWN_COUNT_FRAMES - f.phaseFrames) / 60) + 1, 1, 10);
      const mine = i === localPlayer;
      const y = mine ? 500 : 470;
      const beat = 1 + 0.08 * Math.max(0, 1 - ((KNOCKDOWN_COUNT_FRAMES - f.phaseFrames) % 60) / 12);
      c.save();
      c.translate(STAGE_W / 2, y);
      c.scale(beat, beat);
      bigText(String(count), 0, 0, 150, mine ? COLORS.red : COLORS.gold, 900, MONO);
      c.restore();
      bigText(mine ? 'GET UP — both hands over your head (G)' : `${names.opponent} IS DOWN`, STAGE_W / 2, y + 100, 26, COLORS.text, 700);
    }
    c.restore();
  }

  function drawEdgeFlash(alpha: number): void {
    if (alpha <= 0) return;
    const c = ctx!;
    const g = c.createRadialGradient(STAGE_W / 2, STAGE_H / 2, STAGE_H * 0.45, STAGE_W / 2, STAGE_H / 2, STAGE_W * 0.62);
    g.addColorStop(0, withAlpha(COLORS.red, 0));
    g.addColorStop(1, withAlpha(COLORS.red, 0.8 * alpha));
    c.fillStyle = g;
    c.fillRect(0, 0, STAGE_W, STAGE_H);
  }

  function draw(a: DrawArgs): void {
    const c = ctx!;
    const nowMs = a.nowMs;
    const dt = anim.lastNow > 0 ? clamp(nowMs - anim.lastNow, 0, 100) : 16;
    anim.lastNow = nowMs;
    const names: Required<RenderNames> = { local: a.names?.local ?? 'YOU', opponent: a.names?.opponent ?? 'THEM' };
    const { view, localPlayer } = a;
    const oppIdx = (1 - localPlayer) as 0 | 1;
    const me = view.fighters[localPlayer];
    const them = view.fighters[oppIdx];

    if (view.state !== anim.lastState) {
      if (view.state === 'INTRO') anim.introStart = nowMs;
      anim.lastState = view.state;
    }

    for (const e of a.events) fx.handleEvent(e, { view, localPlayer, anchors: anim.anchors, names, nowMs });
    fx.update(nowMs);

    anim.oppScale = damp(anim.oppScale, rangeScale(view.range), 110, dt);
    for (const i of [0, 1] as const) {
      const f = view.fighters[i];
      anim.down[i] = damp(anim.down[i], f.phase === 'KNOCKDOWN' ? 1 : 0, 220, dt);
      const target = f.phase === 'ACTIVE' ? 1 : f.phase === 'STARTUP' ? 0.55 : 0;
      anim.boost[i] = damp(anim.boost[i], target, target > anim.boost[i] ? 30 : 80, dt);
    }

    // ── clear (device pixels) ──
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = COLORS.bg;
    c.fillRect(0, 0, canvas.width, canvas.height);

    // ── world (shaken) ──
    setStage(fx.shake(nowMs));
    drawRing(nowMs);

    const oppPose = a.opponentPose ? fromPoseFrame(a.opponentPose) : synthPose(them, nowMs);
    const s = anim.oppScale;
    const h = RING.figureH * s;
    const w = RING.figureW * s;
    const proj: Projection = {
      cx: RING.oppX,
      floorY: RING.floorY,
      w,
      h,
      mirror: true,
      dy: anim.down[oppIdx] * 0.32 * h,
      tilt: anim.down[oppIdx] * 0.25,
    };
    // Their own left is image +x, which the mirror puts on our left → slip-left shifts stage −x.
    const exag = a.opponentPose ? 1 : 0.3;
    const headShift: Vec = {
      x: them.head === 'SLIP_L' ? -0.06 * w * exag : them.head === 'SLIP_R' ? 0.06 * w * exag : 0,
      y: them.head === 'DUCK' ? 0.08 * h * exag : 0,
    };
    const res = drawShadow(c, oppPose, proj, {
      style: { color: COLORS.blue, fill: COLORS.fill, glow: 22 },
      fighter: them,
      nowMs,
      headShift,
      wobble: fx.wobble(oppIdx, nowMs),
      punchBoost: anim.boost[oppIdx],
      minVis: a.opponentPose ? 0.35 : 0,
    });
    anim.anchors = { oppHead: res.head, oppBody: res.body, oppWrists: res.wrists, oppGloveR: res.gloveR, local: LOCAL_ANCHOR };
    fx.drawWorld(c, nowMs);

    // ── HUD (steady) ──
    setStage({ x: 0, y: 0 });
    drawPip(me, a.localPose, localPlayer, nowMs);
    hud.draw(c, { view, localPlayer, names, nowMs, dtMs: dt, stalled: a.stalled, stats: a.stats });
    fx.drawOverlay(c, nowMs);
    drawStateOverlay(a, names, nowMs);
    drawEdgeFlash(fx.edgeFlash(nowMs));
  }

  return {
    canvas,
    draw,
    resize,
    dispose(): void {
      ro?.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWinResize);
      fx.clear();
    },
  };
}
