import type { MatchView } from '@spar/protocol';
import { COLORS, FONT, MONO, clamp, damp, fmtClock, lerp, rangeZone, withAlpha } from './theme';

export interface HudNames {
  local: string;
  opponent: string;
}

export interface HudStats {
  rttMs: number;
  rollbackFrames: number;
  framesAhead?: number;
}

export interface HudArgs {
  view: MatchView;
  localPlayer: 0 | 1;
  names: HudNames;
  nowMs: number;
  dtMs: number;
  stalled: boolean;
  stats?: HudStats;
}

export interface Hud {
  draw(ctx: CanvasRenderingContext2D, a: HudArgs): void;
}

const HP_MAX = 1000;
const STAMINA_MAX = 1000;
const STAMINA_LOW = 300;

const BAR = { y: 34, h: 26, localX0: 60, localX1: 700, oppX0: 900, oppX1: 1540 } as const;
const STAMINA = { y: 68, h: 8 } as const;
const PIPS_Y = 96;
const CENTER = { x0: 700, x1: 900, y0: 16, y1: 108 } as const;
const RANGE = { x0: 560, x1: 1040, y: 852, h: 6 } as const;

interface BarOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  frac: number;
  ghost: number;
  color: string;
  rtl: boolean;
  ticks?: boolean;
}

function drawBar(ctx: CanvasRenderingContext2D, o: BarOpts): void {
  const r = Math.min(6, o.h / 2);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(o.x, o.y, o.w, o.h, r);
  ctx.fillStyle = COLORS.fill;
  ctx.fill();
  ctx.clip();

  const fillW = o.w * clamp(o.frac, 0, 1);
  const ghostW = o.w * clamp(o.ghost, 0, 1);
  const startX = (w: number) => (o.rtl ? o.x + o.w - w : o.x);
  if (ghostW > fillW) {
    ctx.fillStyle = withAlpha('#ffffff', 0.55);
    ctx.fillRect(startX(ghostW), o.y, ghostW, o.h);
  }
  const g = ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h);
  g.addColorStop(0, withAlpha('#ffffff', 0.18));
  g.addColorStop(0.5, withAlpha('#ffffff', 0));
  g.addColorStop(1, withAlpha('#000000', 0.25));
  ctx.fillStyle = o.color;
  ctx.fillRect(startX(fillW), o.y, fillW, o.h);
  ctx.fillStyle = g;
  ctx.fillRect(startX(fillW), o.y, fillW, o.h);
  if (o.ticks) {
    ctx.fillStyle = withAlpha('#000000', 0.35);
    for (const t of [0.25, 0.5, 0.75]) ctx.fillRect(o.x + o.w * t - 1, o.y, 2, o.h);
  }
  ctx.restore();
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(o.x, o.y, o.w, o.h, r);
  ctx.stroke();
}

export function createHud(): Hud {
  // Ghost values trail the real ones so a hit shows as a white chip that drains away.
  const ghostHp: [number, number] = [HP_MAX, HP_MAX];
  const shownSt: [number, number] = [STAMINA_MAX, STAMINA_MAX];

  function draw(ctx: CanvasRenderingContext2D, a: HudArgs): void {
    const { view, localPlayer, names, nowMs, dtMs } = a;
    const opp = (1 - localPlayer) as 0 | 1;
    const me = view.fighters[localPlayer];
    const them = view.fighters[opp];

    for (const i of [0, 1] as const) {
      const f = view.fighters[i];
      ghostHp[i] = f.hp >= ghostHp[i] ? f.hp : damp(ghostHp[i], f.hp, 260, dtMs);
      shownSt[i] = damp(shownSt[i], f.stamina, 80, dtMs);
    }

    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // ── names ──
    ctx.font = `800 22px ${FONT}`;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.fillText(names.local, BAR.localX0, 26);
    ctx.textAlign = 'right';
    ctx.fillText(names.opponent, BAR.oppX1, 26);

    // ── HP ──
    drawBar(ctx, {
      x: BAR.localX0, y: BAR.y, w: BAR.localX1 - BAR.localX0, h: BAR.h,
      frac: me.hp / HP_MAX, ghost: ghostHp[localPlayer] / HP_MAX, color: COLORS.red, rtl: false, ticks: true,
    });
    drawBar(ctx, {
      x: BAR.oppX0, y: BAR.y, w: BAR.oppX1 - BAR.oppX0, h: BAR.h,
      frac: them.hp / HP_MAX, ghost: ghostHp[opp] / HP_MAX, color: COLORS.blue, rtl: true, ticks: true,
    });
    ctx.font = `700 15px ${MONO}`;
    ctx.fillStyle = withAlpha('#ffffff', 0.85);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.max(0, me.hp)), BAR.localX1 - 8, BAR.y + 19);
    ctx.textAlign = 'left';
    ctx.fillText(String(Math.max(0, them.hp)), BAR.oppX0 + 8, BAR.y + 19);

    // ── stamina ──
    const stColor = (f: typeof me) => (f.stamina < STAMINA_LOW ? COLORS.amber : COLORS.green);
    const stAlpha = (f: typeof me) => (f.stamina < STAMINA_LOW ? 0.7 + 0.3 * Math.sin(nowMs / 110) : 1);
    ctx.globalAlpha = stAlpha(me);
    drawBar(ctx, {
      x: BAR.localX0, y: STAMINA.y, w: BAR.localX1 - BAR.localX0, h: STAMINA.h,
      frac: shownSt[localPlayer] / STAMINA_MAX, ghost: 0, color: stColor(me), rtl: false,
    });
    ctx.globalAlpha = stAlpha(them);
    drawBar(ctx, {
      x: BAR.oppX0, y: STAMINA.y, w: BAR.oppX1 - BAR.oppX0, h: STAMINA.h,
      frac: shownSt[opp] / STAMINA_MAX, ghost: 0, color: stColor(them), rtl: true,
    });
    ctx.globalAlpha = 1;
    ctx.font = `700 12px ${FONT}`;
    ctx.fillStyle = COLORS.dim;
    ctx.textAlign = 'left';
    ctx.fillText('STAMINA', BAR.localX0, STAMINA.y + 24);
    ctx.textAlign = 'right';
    ctx.fillText('STAMINA', BAR.oppX1, STAMINA.y + 24);

    // ── knockdown pips (this round) ──
    const pips = (x: number, dir: 1 | -1, n: number, color: string) => {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x + dir * (i * 20), PIPS_Y, 6, 0, Math.PI * 2);
        if (i < n) {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.strokeStyle = COLORS.border;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    };
    pips(BAR.localX0 + 90, 1, me.knockdowns, COLORS.red);
    pips(BAR.oppX1 - 90, -1, them.knockdowns, COLORS.blue);

    // ── centre: round + clock ──
    ctx.fillStyle = withAlpha(COLORS.panel, 0.9);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(CENTER.x0, CENTER.y0, CENTER.x1 - CENTER.x0, CENTER.y1 - CENTER.y0, 10);
    ctx.fill();
    ctx.stroke();
    const cx = (CENTER.x0 + CENTER.x1) / 2;
    ctx.textAlign = 'center';
    ctx.font = `800 17px ${FONT}`;
    ctx.fillStyle = COLORS.dim;
    const label =
      view.state === 'REST' ? 'REST' : view.state === 'OVER' ? 'FINAL' : `ROUND ${view.round}`;
    ctx.fillText(label, cx, CENTER.y0 + 26);
    ctx.font = `800 46px ${MONO}`;
    const urgent = view.state === 'FIGHTING' && view.clockSec <= 10;
    ctx.fillStyle = urgent ? (Math.sin(nowMs / 150) > 0 ? COLORS.red : COLORS.text) : COLORS.text;
    ctx.fillText(fmtClock(view.clockSec), cx, CENTER.y0 + 76);

    // ── counter-window flash ──
    let counterY = CENTER.y1 + 22;
    if (me.counterWindow > 0) {
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(nowMs / 40);
      ctx.fillStyle = COLORS.gold;
      ctx.font = `900 20px ${FONT}`;
      ctx.fillText('◆ COUNTER ◆', cx, counterY);
      ctx.globalAlpha = 1;
      counterY += 24;
    }
    if (them.counterWindow > 0) {
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(nowMs / 40);
      ctx.fillStyle = COLORS.blue;
      ctx.font = `800 15px ${FONT}`;
      ctx.fillText('THEY CAN COUNTER', cx, counterY);
      ctx.globalAlpha = 1;
    }

    // ── range meter ──
    const zone = rangeZone(view.range);
    ctx.fillStyle = COLORS.fill;
    ctx.beginPath();
    ctx.roundRect(RANGE.x0, RANGE.y - RANGE.h / 2, RANGE.x1 - RANGE.x0, RANGE.h, 3);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const gap = lerp(56, 440, clamp((view.range - 200) / 800, 0, 1));
    const mx = (RANGE.x0 + RANGE.x1) / 2;
    // zone bands around the centre
    const bandInside = lerp(56, 440, 100 / 800) / 2;
    const bandOut = lerp(56, 440, 500 / 800) / 2;
    ctx.fillStyle = withAlpha(COLORS.gold, 0.18);
    ctx.fillRect(mx - bandInside, RANGE.y - RANGE.h / 2, bandInside * 2, RANGE.h);
    ctx.fillStyle = withAlpha('#ffffff', 0.06);
    ctx.fillRect(RANGE.x0, RANGE.y - RANGE.h / 2, mx - bandOut - RANGE.x0, RANGE.h);
    ctx.fillRect(mx + bandOut, RANGE.y - RANGE.h / 2, RANGE.x1 - (mx + bandOut), RANGE.h);
    const glove = (x: number, color: string) => {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, RANGE.y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = withAlpha('#ffffff', 0.35);
      ctx.beginPath();
      ctx.arc(x - 4, RANGE.y - 4, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    glove(mx - gap / 2, COLORS.red);
    glove(mx + gap / 2, COLORS.blue);
    ctx.textAlign = 'center';
    ctx.font = `800 18px ${FONT}`;
    ctx.fillStyle = zone === 'INSIDE' ? COLORS.gold : zone === 'OUT' ? COLORS.dim : COLORS.text;
    ctx.fillText(zone, mx, RANGE.y - 22);
    ctx.font = `600 13px ${MONO}`;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(String(view.range), mx, RANGE.y + 30);

    // ── net stats / sync ──
    if (a.stats) {
      const ahead = a.stats.framesAhead;
      const parts = [a.stats.rttMs > 0 ? `Peer RTT ${Math.round(a.stats.rttMs)} ms` : 'Peer RTT pending', `RB ${a.stats.rollbackFrames}`];
      if (ahead !== undefined) parts.push(`${ahead >= 0 ? '+' : ''}${ahead}f`);
      ctx.textAlign = 'left';
      ctx.font = `600 14px ${MONO}`;
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(parts.join(' · '), BAR.localX0, 878);
    }
    if (a.stalled) {
      const x = BAR.oppX1 - 78;
      const y = 122;
      ctx.fillStyle = withAlpha(COLORS.panel, 0.9);
      ctx.strokeStyle = COLORS.amber;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x, y, 78, 24, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = Math.sin(nowMs / 140) > 0 ? COLORS.amber : withAlpha(COLORS.amber, 0.3);
      ctx.beginPath();
      ctx.arc(x + 14, y + 12, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.amber;
      ctx.font = `800 13px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('SYNC', x + 26, y + 17);
    }
    ctx.restore();
  }

  return { draw };
}
