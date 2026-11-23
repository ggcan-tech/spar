import type { MatchView, SimEvent } from '@spar/protocol';
import { COLORS, FONT, STAGE_W, clamp, punchLabel, withAlpha, type Vec } from './theme';
import { punchHand, type Hand } from './pose';

export interface FxAnchors {
  oppHead: Vec;
  oppBody: Vec;
  oppWrists: Record<Hand, Vec>;
  oppGloveR: number;
  /** Where "things that happen to you" are shown (lower-middle of the stage). */
  local: Vec;
}

export interface FxNames {
  local: string;
  opponent: string;
}

export interface FxContext {
  view: MatchView;
  localPlayer: 0 | 1;
  anchors: FxAnchors;
  names: FxNames;
  nowMs: number;
}

interface FloatText {
  text: string;
  x: number;
  y: number;
  vy: number;
  born: number;
  life: number;
  color: string;
  size: number;
  weight: number;
  italic: boolean;
  pop: number;
}

type ParticleKind = 'spark' | 'flash' | 'arc' | 'swoosh' | 'ring';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  color: string;
  a0?: number;
  a1?: number;
}

interface Shake {
  amp: number;
  born: number;
  life: number;
  seed: number;
}

export interface Card {
  title: string;
  sub?: string;
  color: string;
  life: number;
}

interface LiveCard extends Card {
  born: number;
}

export interface Fx {
  handleEvent(e: SimEvent, c: FxContext): void;
  /** Drop expired items. Call once per frame before drawing. */
  update(nowMs: number): void;
  /** Particles/flashes in stage space (draw over the shadow, under the HUD). */
  drawWorld(ctx: CanvasRenderingContext2D, nowMs: number): void;
  /** Floating texts + cards (draw over the HUD). */
  drawOverlay(ctx: CanvasRenderingContext2D, nowMs: number): void;
  shake(nowMs: number): Vec;
  /** 0..1 strength of the red edge flash (you got hit). */
  edgeFlash(nowMs: number): number;
  /** 0..1 remaining stun wobble for a fighter. */
  wobble(who: 0 | 1, nowMs: number): number;
  showCard(card: Card, nowMs: number): void;
  text(text: string, x: number, y: number, o?: Partial<Omit<FloatText, 'text' | 'x' | 'y' | 'born'>>): void;
  clear(): void;
}

const MAX_TEXTS = 24;
const MAX_PARTICLES = 160;

export function createFx(): Fx {
  const texts: FloatText[] = [];
  const particles: Particle[] = [];
  const shakes: Shake[] = [];
  const wobbleUntil: [number, number] = [0, 0];
  let edge: { born: number; life: number; strength: number } | null = null;
  let card: LiveCard | null = null;
  let lastNow = 0;

  function text(
    str: string,
    x: number,
    y: number,
    o: Partial<Omit<FloatText, 'text' | 'x' | 'y' | 'born'>> = {},
  ): void {
    texts.push({
      text: str,
      x,
      y,
      vy: o.vy ?? -40,
      born: lastNow,
      life: o.life ?? 900,
      color: o.color ?? COLORS.text,
      size: o.size ?? 40,
      weight: o.weight ?? 800,
      italic: o.italic ?? false,
      pop: o.pop ?? 1.4,
    });
    if (texts.length > MAX_TEXTS) texts.splice(0, texts.length - MAX_TEXTS);
  }

  function particle(p: Omit<Particle, 'born'>): void {
    particles.push({ ...p, born: lastNow });
    if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
  }

  function addShake(amp: number, life = 320): void {
    shakes.push({ amp, born: lastNow, life, seed: Math.random() * 100 });
    if (shakes.length > 6) shakes.shift();
  }

  function flash(at: Vec, color: string, size: number): void {
    particle({ kind: 'flash', x: at.x, y: at.y, vx: 0, vy: 0, life: 260, size, color });
    const n = 6 + Math.floor(size / 12);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 220 + Math.random() * 420;
      particle({
        kind: 'spark',
        x: at.x,
        y: at.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 120,
        life: 320 + Math.random() * 220,
        size: 2 + Math.random() * 3,
        color,
      });
    }
  }

  function sparks(at: Vec, color: string, n: number, spread = 240): void {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = spread * (0.5 + Math.random());
      particle({
        kind: 'spark',
        x: at.x + (Math.random() - 0.5) * 30,
        y: at.y + (Math.random() - 0.5) * 30,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 260 + Math.random() * 240,
        size: 1.5 + Math.random() * 2.5,
        color,
      });
    }
  }

  function swoosh(at: Vec, dir: number, color: string): void {
    for (let i = 0; i < 3; i++) {
      particle({
        kind: 'swoosh',
        x: at.x - dir * 20,
        y: at.y - 30 + i * 28,
        vx: dir * (600 + i * 120),
        vy: 0,
        life: 220,
        size: 60 + i * 10,
        color,
      });
    }
  }

  function anchorFor(c: FxContext, who: 0 | 1, part: 'head' | 'body' | 'hand', hand?: Hand): Vec {
    if (who === c.localPlayer) return c.anchors.local;
    if (part === 'body') return c.anchors.oppBody;
    if (part === 'hand' && hand) return c.anchors.oppWrists[hand];
    return c.anchors.oppHead;
  }

  function handleEvent(e: SimEvent, c: FxContext): void {
    lastNow = c.nowMs;
    const mine = e.who === c.localPlayer;
    const opp = (1 - e.who) as 0 | 1;
    switch (e.kind) {
      case 'HIT': {
        const dmg = e.damage ?? 0;
        const label = punchLabel(e.punch, e.body);
        if (mine) {
          const at = anchorFor(c, opp, e.body ? 'body' : 'head');
          flash(at, e.body ? COLORS.amber : COLORS.white, 26 + dmg * 0.25);
          addShake(3 + dmg * 0.06);
          text(`${label} ${dmg}`, at.x, at.y - 60, { size: 38 + dmg * 0.12, color: COLORS.text });
        } else {
          edge = { born: c.nowMs, life: 380, strength: clamp(0.35 + dmg / 160, 0, 1) };
          addShake(6 + dmg * 0.1, 380);
          const at = c.anchors.local;
          flash(at, COLORS.red, 18 + dmg * 0.2);
          text(`${label} −${dmg}`, at.x, at.y - 40, { size: 40 + dmg * 0.12, color: COLORS.red });
        }
        break;
      }
      case 'COUNTER': {
        const at = anchorFor(c, opp, 'head');
        particle({ kind: 'ring', x: at.x, y: at.y, vx: 0, vy: 0, life: 420, size: 40, color: COLORS.gold });
        text('COUNTER!', at.x, at.y - 130, { size: 60, color: COLORS.gold, life: 1100, vy: -25 });
        break;
      }
      case 'BLOCK': {
        const at = anchorFor(c, opp, 'head');
        const guard = { x: at.x, y: at.y + 40 };
        sparks(guard, COLORS.grey, 10);
        text('BLOCK', guard.x, guard.y - 30, { size: 26, color: COLORS.grey, weight: 700, life: 600 });
        break;
      }
      case 'EVADE': {
        // who = the evader.
        const head = c.view.fighters[e.who].head;
        const label = head === 'DUCK' ? 'DUCK!' : head === 'SLIP_L' || head === 'SLIP_R' ? 'SLIP!' : 'EVADE!';
        const at = anchorFor(c, e.who, 'head');
        const dir = head === 'SLIP_L' ? -1 : 1;
        swoosh(at, dir, COLORS.cyan);
        text(label, at.x, at.y - 70, { size: 42, color: COLORS.cyan, italic: true, life: 750 });
        break;
      }
      case 'MISS': {
        const hand = punchHand(e.punch, c.view.fighters[e.who].stance) ?? 'L';
        const at = anchorFor(c, e.who, 'hand', hand);
        const dir = hand === 'L' ? 1 : -1;
        particle({
          kind: 'arc', x: at.x, y: at.y, vx: dir * 80, vy: -20, life: 280, size: mine ? 50 : 70,
          color: COLORS.grey, a0: dir > 0 ? -Math.PI * 0.9 : Math.PI * 0.1, a1: dir > 0 ? -Math.PI * 0.1 : Math.PI * 0.9,
        });
        break;
      }
      case 'STUN': {
        // who = the stunned fighter.
        const at = anchorFor(c, e.who, 'head');
        wobbleUntil[e.who] = c.nowMs + 520;
        text('STUNNED', at.x, at.y - 100, { size: 46, color: COLORS.amber, life: 900, vy: -20 });
        break;
      }
      case 'KNOCKDOWN': {
        // who = the fighter going down.
        addShake(16, 500);
        if (mine) edge = { born: c.nowMs, life: 600, strength: 1 };
        text('DOWN!', STAGE_W / 2, 360, {
          size: 110, color: mine ? COLORS.red : COLORS.gold, life: 1400, vy: -12, pop: 1.8,
        });
        break;
      }
      case 'GET_UP': {
        const at = anchorFor(c, e.who, 'head');
        text('UP!', at.x, at.y - 90, { size: 64, color: COLORS.green, life: 900 });
        break;
      }
      case 'BELL': {
        if (e.detail === 'START' || c.view.state === 'FIGHTING') {
          showCard({ title: 'FIGHT!', color: COLORS.red, life: 900 }, c.nowMs);
        }
        break;
      }
      case 'ROUND_END': {
        const done = c.view.scores[0].length;
        const idx = done - 1;
        if (idx < 0) break;
        const a = c.view.scores[c.localPlayer][idx];
        const b = c.view.scores[1 - c.localPlayer][idx];
        const color = a > b ? COLORS.gold : a < b ? COLORS.dim : COLORS.text;
        showCard(
          { title: `ROUND ${idx + 1}`, sub: `${c.names.local} ${a} — ${b} ${c.names.opponent}`, color, life: 2000 },
          c.nowMs,
        );
        break;
      }
      case 'MATCH_END': {
        addShake(10, 400);
        break;
      }
      case 'STEP':
        break;
    }
  }

  function showCard(next: Card, nowMs: number): void {
    card = { ...next, born: nowMs };
  }

  function update(nowMs: number): void {
    lastNow = nowMs;
    for (let i = texts.length - 1; i >= 0; i--) if (nowMs - texts[i].born > texts[i].life) texts.splice(i, 1);
    for (let i = particles.length - 1; i >= 0; i--) {
      if (nowMs - particles[i].born > particles[i].life) particles.splice(i, 1);
    }
    for (let i = shakes.length - 1; i >= 0; i--) if (nowMs - shakes[i].born > shakes[i].life) shakes.splice(i, 1);
    if (edge && nowMs - edge.born > edge.life) edge = null;
    if (card && nowMs - card.born > card.life) card = null;
  }

  function drawWorld(ctx: CanvasRenderingContext2D, nowMs: number): void {
    for (const p of particles) {
      const t = clamp((nowMs - p.born) / p.life, 0, 1);
      const dt = (nowMs - p.born) / 1000;
      ctx.save();
      switch (p.kind) {
        case 'spark': {
          const x = p.x + p.vx * dt;
          const y = p.y + p.vy * dt + 900 * dt * dt * 0.5;
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - p.vx * 0.02, y - (p.vy + 900 * dt) * 0.02);
          ctx.stroke();
          break;
        }
        case 'flash': {
          const r = p.size * (0.6 + 1.8 * t);
          ctx.globalAlpha = (1 - t) * 0.9;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          g.addColorStop(0, withAlpha('#ffffff', 0.95));
          g.addColorStop(0.4, withAlpha(p.color, 0.7));
          g.addColorStop(1, withAlpha(p.color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = (1 - t) * 0.8;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 1.15, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'ring': {
          const r = p.size + 90 * t;
          ctx.globalAlpha = (1 - t) * 0.9;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 6 * (1 - t) + 1;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 16;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'arc': {
          const x = p.x + p.vx * dt;
          const y = p.y + p.vy * dt;
          ctx.globalAlpha = (1 - t) * 0.35;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(x, y, p.size * (0.8 + 0.6 * t), p.a0 ?? 0, p.a1 ?? Math.PI, false);
          ctx.stroke();
          break;
        }
        case 'swoosh': {
          const x = p.x + p.vx * dt;
          ctx.globalAlpha = (1 - t) * 0.6;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x, p.y);
          ctx.quadraticCurveTo(x - p.vx * 0.06, p.y - 8, x - p.vx * 0.12 - Math.sign(p.vx) * p.size, p.y);
          ctx.stroke();
          break;
        }
      }
      ctx.restore();
    }
  }

  function drawText(ctx: CanvasRenderingContext2D, ft: FloatText, nowMs: number): void {
    const age = nowMs - ft.born;
    const t = clamp(age / ft.life, 0, 1);
    const alpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    const popT = clamp(age / 140, 0, 1);
    const scale = ft.pop + (1 - ft.pop) * (1 - (1 - popT) * (1 - popT));
    const y = ft.y + ft.vy * (age / 1000);
    ctx.save();
    ctx.translate(ft.x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.font = `${ft.italic ? 'italic ' : ''}${ft.weight} ${ft.size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, ft.size * 0.14);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(ft.text, 0, 0);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, 0, 0);
    ctx.restore();
  }

  function drawCard(ctx: CanvasRenderingContext2D, c: LiveCard, nowMs: number): void {
    const age = nowMs - c.born;
    const t = clamp(age / c.life, 0, 1);
    const inT = clamp(age / 160, 0, 1);
    const scale = 0.85 + 0.15 * (1 - (1 - inT) * (1 - inT));
    const alpha = t > 0.85 ? (1 - t) / 0.15 : 1;
    const w = c.sub ? 720 : 480;
    const h = c.sub ? 190 : 140;
    ctx.save();
    ctx.translate(STAGE_W / 2, 300);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = withAlpha(COLORS.panel, 0.92);
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 3;
    ctx.shadowColor = c.color;
    ctx.shadowBlur = 30;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.color;
    ctx.font = `900 ${c.sub ? 72 : 84}px ${FONT}`;
    ctx.fillText(c.title, 0, c.sub ? -28 : 2);
    if (c.sub) {
      ctx.fillStyle = COLORS.text;
      ctx.font = `700 34px ${FONT}`;
      ctx.fillText(c.sub, 0, 46);
    }
    ctx.restore();
  }

  function drawOverlay(ctx: CanvasRenderingContext2D, nowMs: number): void {
    for (const ft of texts) drawText(ctx, ft, nowMs);
    if (card) drawCard(ctx, card, nowMs);
  }

  function shake(nowMs: number): Vec {
    let x = 0;
    let y = 0;
    for (const s of shakes) {
      const t = clamp((nowMs - s.born) / s.life, 0, 1);
      const k = s.amp * (1 - t) * (1 - t);
      x += k * Math.sin(nowMs * 0.097 + s.seed);
      y += k * Math.cos(nowMs * 0.083 + s.seed * 1.7);
    }
    return { x, y };
  }

  function edgeFlash(nowMs: number): number {
    if (!edge) return 0;
    const t = clamp((nowMs - edge.born) / edge.life, 0, 1);
    return edge.strength * (1 - t);
  }

  function wobble(who: 0 | 1, nowMs: number): number {
    const remain = wobbleUntil[who] - nowMs;
    return remain <= 0 ? 0 : clamp(remain / 520, 0, 1);
  }

  return {
    handleEvent,
    update,
    drawWorld,
    drawOverlay,
    shake,
    edgeFlash,
    wobble,
    showCard,
    text,
    clear(): void {
      texts.length = 0;
      particles.length = 0;
      shakes.length = 0;
      edge = null;
      card = null;
      wobbleUntil[0] = wobbleUntil[1] = 0;
    },
  };
}
