import { JOINT } from "../pov/body";
import { dist, p2, type Edge, type FlatPose, type P2, type Side } from "./body";
import { launchAngle, launchSpeed } from "./flight";
import { SLING } from "./tune";

/**
 * The body slingshot, read from every pose (DUEL.md 1.3).
 *
 * 1. Nock: hands together at the chest.
 * 2. Draw: the sling arm goes out to the side, toward the opponent in the game;
 *    the other hand pulls back toward the chin. Power is how far apart the hands are.
 * 3. Hold: hands steady for 0.3 s, trunk slow.
 * 4. Let go: flick the pulling hand back. The hands jump 10 cm further apart
 *    within 0.15 s while the sling wrist stays put against its shoulder.
 *
 * Direction and power come from the 150 ms that end at the last pose before the
 * hands began to separate, never from inside the flick: a sloppy flick never
 * changes the shot. A flick without a held draw fires nothing (a fake). Every
 * refused flick says why.
 */
export interface SlingSetup {
  /** The sling arm (the one held out). */
  side: Side;
  /** The player's natural "point at them" hand line, degrees. */
  level: number;
  /** Hand distance at the player's full draw, metres. */
  fullDraw: number;
  /** The sling arm's length in the picture when held out to the side, metres. */
  armLen: number;
  measured: boolean;
}
export const defaultSetup = (side: Side): SlingSetup => ({
  side,
  level: SLING.ownLevel,
  fullDraw: 0.72,
  armLen: 0.5,
  measured: false,
});

export type SlingState = "down" | "nocked" | "drawing" | "ready";
export type Refusal = "settle" | "sling moved" | "point to your side" | "pull further";

export interface SlingShot {
  /** When the release was read: motion clock and capture clock, ms. */
  t: number;
  cap: number;
  handLine: number;
  angle: number;
  power: number;
  speed: number;
  release: "flick" | "still";
  /** From raising the sling (the nock) to this read, ms. */
  raisedMs: number;
  /** From the hands beginning to separate to this read, ms. */
  readMs: number;
  /** The sling hand where it was held, metres against the hips. */
  hand: P2;
}
export interface SlingRead {
  state: SlingState;
  handLine: number | null;
  /** The launch angle a release now would give, degrees. */
  angle: number | null;
  /** Hand distance against the full draw. */
  draw: number;
  /** The sling arm's length in the picture against its set-up length. */
  sideOn: number;
  steady: boolean;
  /** Trunk speed, metres a second. */
  trunk: number;
  /** How far the sling wrist moved against its shoulder over the last flick window, metres. */
  slingMove: number;
  edge: Edge | null;
  /** The sling hand is near the picture's edge. */
  glow: boolean;
  /** A sling arm is up (for the arm-tiredness line). */
  armUp: boolean;
  /** A standing hint while drawing. */
  hint: Refusal | null;
  /** How far through the hold, 0–1 (1: ready to flick). */
  holdK: number;
  /** The checklist: sling arm out to the side, other hand pulled back. */
  armOut: boolean;
  pulled: boolean;
  shot: SlingShot | null;
  refused: { reason: Refusal; gate: string } | null;
  /** A draw ended without a shot, and why. */
  cancelled: string | null;
}

interface Sample {
  t: number;
  cap: number;
  d: number;
  line: number | null;
  /** Sling wrist against its own shoulder. */
  rel: P2;
  sling: P2;
  pull: P2;
  root: P2;
  arm: number;
  power: number;
}

const deg = (r: number) => (r * 180) / Math.PI;

export interface SlingOptions {
  /** "flick" (default) or "still": a full draw held still fires (opt-in). */
  release?: "flick" | "still";
  /** "line" (default): direction from the hand line. "height": the fallback if players point at the screen. */
  aim?: "line" | "height";
}

/** Which arm is held out to the side, near level, if exactly one is. */
export function armHeldOut(pose: FlatPose): Side | null {
  const out = (side: Side) => {
    const L = side === "left";
    const s = pose.j[L ? JOINT.L_SHOULDER : JOINT.R_SHOULDER],
      w = pose.j[L ? JOINT.L_WRIST : JOINT.R_WRIST];
    const seen = Math.min(pose.w[L ? JOINT.L_WRIST : JOINT.R_WRIST], pose.w[L ? JOINT.L_SHOULDER : JOINT.R_SHOULDER]) >= 0.5;
    const dx = (w.x - s.x) * (L ? -1 : 1);
    return seen && dx > 0.28 && Math.abs(deg(Math.atan2(w.y - s.y, dx))) < 45;
  };
  const l = out("left"),
    r = out("right");
  return l && !r ? "left" : r && !l ? "right" : null;
}

export function createSlingReader(initial: SlingSetup, options: SlingOptions = {}) {
  let setup = { ...initial };
  let release = options.release ?? "flick";
  let aim = options.aim ?? "line";
  let state: SlingState = "down";
  let history: Sample[] = [];
  /** Sling arm lengths seen held out near level: the player's own reach, until set-up measures it. */
  let armsSeen: number[] = [];
  const armRef = () => {
    if (setup.measured) return setup.armLen;
    if (armsSeen.length < 8) return Math.min(setup.armLen, 0.42);
    const sorted = [...armsSeen].sort((a, b) => a - b);
    return Math.max(0.3, Math.min(0.7, sorted[Math.floor(sorted.length * 0.9)]));
  };
  let raisedAt = 0,
    readyAt = -Infinity,
    readySince = -Infinity,
    /** Hand distance while last ready: separation is measured from it. */
    readyD = 0,
    quietUntil = -Infinity,
    rearm = false;
  const idx = () => {
    const L = setup.side === "left";
    return {
      S: L ? JOINT.L_SHOULDER : JOINT.R_SHOULDER,
      Sw: L ? JOINT.L_WRIST : JOINT.R_WRIST,
      P: L ? JOINT.R_WRIST : JOINT.L_WRIST,
      Ps: L ? JOINT.R_SHOULDER : JOINT.L_SHOULDER,
      Pe: L ? JOINT.R_ELBOW : JOINT.L_ELBOW,
      dir: L ? -1 : 1,
      e: L ? 0 : 1,
    };
  };
  function sampleOf(pose: FlatPose): Sample & { seen: boolean; chest: boolean } {
    const i = idx();
    const S = pose.j[i.S],
      Sw = pose.j[i.Sw],
      P = pose.j[i.P];
    const d = dist(Sw, P);
    const along = (Sw.x - P.x) * i.dir;
    let line: number | null = along > 0.05 ? deg(Math.atan2(Sw.y - P.y, along)) : null;
    let power = d / setup.fullDraw;
    if (aim === "height") {
      // Elevation from the sling wrist's height above its shoulder; power from the pulling elbow drawn out to its side.
      line = setup.level + deg(Math.asin(Math.max(-1, Math.min(1, (Sw.y - S.y) / Math.max(0.2, setup.armLen)))));
      // A guess until the probe measures it: an arm pointed at the screen looks about three quarters as long.
      const spread = (pose.j[i.Pe].x - pose.j[i.Ps].x) * -i.dir;
      power = Math.max(Math.max(0, spread) / 0.3, d / (setup.fullDraw * 0.75));
    }
    const shoulderY = (pose.j[JOINT.L_SHOULDER].y + pose.j[JOINT.R_SHOULDER].y) / 2;
    const atChest = (q: P2) => q.y > shoulderY - 0.38 && q.y < shoulderY + 0.18 && Math.abs(q.x) < 0.32;
    return {
      t: pose.t,
      cap: pose.cap,
      d,
      line,
      rel: p2(Sw.x - S.x, Sw.y - S.y),
      sling: Sw,
      pull: P,
      root: pose.root,
      arm: dist(Sw, S),
      power,
      seen: Math.min(pose.w[i.Sw], pose.w[i.P], pose.w[i.S]) >= 0.5 && !pose.held,
      chest: atChest(Sw) && atChest(P),
    };
  }
  /** The newest sample at or before t. */
  const before = (t: number) => {
    for (let k = history.length - 1; k >= 0; k--) if (history[k].t <= t) return history[k];
    return history[0];
  };
  function trunkSpeed(): number {
    const now = history[history.length - 1];
    const then = before(now.t - 100);
    if (!then || then === now) return 0;
    return dist(now.root, then.root) / Math.max(0.03, (now.t - then.t) / 1000);
  }
  /** How long, ms, the hands have stayed steady up to now. */
  function steadyLen(): number {
    const now = history[history.length - 1];
    if (!now) return 0;
    let dMin = Infinity,
      dMax = -Infinity,
      sx = [Infinity, -Infinity],
      sy = [Infinity, -Infinity];
    let since = now.t;
    for (let k = history.length - 1; k >= 0; k--) {
      const h = history[k];
      dMin = Math.min(dMin, h.d);
      dMax = Math.max(dMax, h.d);
      sx = [Math.min(sx[0], h.rel.x), Math.max(sx[1], h.rel.x)];
      sy = [Math.min(sy[0], h.rel.y), Math.max(sy[1], h.rel.y)];
      if (dMax - dMin > SLING.steady || sx[1] - sx[0] > SLING.steady || sy[1] - sy[0] > SLING.steady) break;
      since = h.t;
    }
    return now.t - since;
  }
  function steadyFor(ms: number): boolean {
    const now = history[history.length - 1];
    if (!now || history[0].t > now.t - ms) return false;
    let dMin = Infinity,
      dMax = -Infinity,
      sx = [Infinity, -Infinity],
      sy = [Infinity, -Infinity],
      px = [Infinity, -Infinity],
      py = [Infinity, -Infinity];
    for (let k = history.length - 1; k >= 0 && history[k].t >= now.t - ms; k--) {
      const h = history[k];
      dMin = Math.min(dMin, h.d);
      dMax = Math.max(dMax, h.d);
      sx = [Math.min(sx[0], h.rel.x), Math.max(sx[1], h.rel.x)];
      sy = [Math.min(sy[0], h.rel.y), Math.max(sy[1], h.rel.y)];
      px = [Math.min(px[0], h.pull.x - h.sling.x), Math.max(px[1], h.pull.x - h.sling.x)];
      py = [Math.min(py[0], h.pull.y - h.sling.y), Math.max(py[1], h.pull.y - h.sling.y)];
    }
    const s = SLING.steady;
    return dMax - dMin <= s && sx[1] - sx[0] <= s && sy[1] - sy[0] <= s && px[1] - px[0] <= s * 1.4 && py[1] - py[0] <= s * 1.4;
  }
  function aimFrom(sepT: number): { line: number; power: number; hand: P2 } | null {
    const win = history.filter((h) => h.t <= sepT && h.t >= sepT - SLING.aimWindowMs && h.line !== null);
    if (!win.length) return null;
    const line = win.reduce((a, h) => a + (h.line as number), 0) / win.length;
    const power = win.reduce((a, h) => a + h.power, 0) / win.length;
    const last = win[win.length - 1];
    return { line, power, hand: last.sling };
  }
  const blank = (s: Sample, trunk: number, edge: Edge | null): SlingRead => {
    const draw = s.power;
    const glow = !!edge && (edge.side < SLING.edgeGlow || edge.top < SLING.edgeGlow);
    return {
      state,
      handLine: s.line,
      angle: s.line === null ? null : launchAngle(s.line, setup.level),
      draw,
      sideOn: s.arm / armRef(),
      steady: false,
      holdK: 0,
      armOut: false,
      pulled: false,
      trunk,
      slingMove: 0,
      edge,
      glow,
      armUp: state !== "down" || s.sling.y > -0.05,
      hint: null,
      shot: null,
      refused: null,
      cancelled: null,
    };
  };
  return {
    setup: () => setup,
    state: () => state,
    configure(next: Partial<SlingSetup>, o: SlingOptions = {}) {
      setup = { ...setup, ...next };
      if (o.release) release = o.release;
      if (o.aim) aim = o.aim;
      if (next.side) {
        state = "down";
        history = [];
      }
    },
    reset() {
      state = "down";
      history = [];
      readyAt = readySince = quietUntil = -Infinity;
    },
    update(pose: FlatPose): SlingRead {
      const s = sampleOf(pose);
      history.push(s);
      while (history.length > 2 && history[0].t < s.t - 1500) history.shift();
      const trunk = trunkSpeed();
      const edge = pose.edges[idx().e];
      const out = blank(s, trunk, edge);
      const was = state;
      if (!s.seen) {
        // A sling wrist the camera lost cancels a draw; it never fires one.
        if (state === "drawing" || state === "ready") out.cancelled = "lost";
        state = "down";
        out.state = state;
        return out;
      }
      const i = idx();
      // The checklist, shown to the player while they learn the sling.
      const armOutNow = (s.sling.x - pose.j[i.S].x) * i.dir > 0.22 && s.sling.y > pose.j[i.S].y - 0.3;
      const pulledNow = (s.sling.x - s.pull.x) * i.dir > 0.3 && s.power >= SLING.powerMin;
      out.armOut = armOutNow;
      out.pulled = pulledNow;
      // After a shot held still, the hands must move out of the draw before the next one.
      if (!armOutNow || !pulledNow) rearm = false;
      if (armOutNow && Math.abs(s.rel.y) < 0.18) {
        armsSeen.push(s.arm);
        if (armsSeen.length > 300) armsSeen.shift();
      }
      if (state === "down") {
        if (s.d < SLING.nockHands && s.chest) {
          state = "nocked";
          raisedAt = s.t;
        } else if (armOutNow && pulledNow && s.t >= quietUntil && !rearm) {
          // Straight into the draw pose: no nock needed.
          state = "drawing";
          raisedAt = s.t;
        }
      } else if (state === "nocked") {
        if (s.d > SLING.nockHands + 0.06 && (s.sling.x - s.pull.x) * i.dir > 0.05) state = "drawing";
        else if (!s.chest && s.d < SLING.nockHands) state = "down";
        else if (s.sling.y < -0.15 && s.pull.y < -0.15) state = "down";
      }
      if (state === "drawing" || state === "ready") {
        // Out to the side, at the length the player's own arm reaches: not hanging, not pointed at the screen.
        const outSide = (s.sling.x - pose.j[i.S].x) * i.dir;
        const armed = aim === "height" ? s.sling.y > pose.j[i.S].y - 0.3 : outSide >= 0.6 * armRef() && s.arm >= SLING.sideOn * armRef() && s.sling.y > pose.j[i.S].y - 0.3;
        if (s.d < SLING.nockHands) {
          state = "nocked";
          out.cancelled = "hands together";
        } else if ((s.line !== null && s.line < setup.level - SLING.dropCancel) || s.sling.y < pose.j[i.S].y - 0.3) {
          state = "down";
          out.cancelled = "arm dropped";
        } else if (s.sling.x * i.dir < -0.12) {
          // The sling hand on the far side of the body: the camera has swapped the wrists, or the arms crossed.
          state = "down";
          out.cancelled = "arms crossed";
        } else {
          const held = steadyLen();
          const steady = held >= SLING.holdMs && steadyFor(SLING.holdMs) && trunk <= SLING.trunkStill;
          out.steady = steady;
          out.holdK = armed && s.power >= SLING.powerMin && trunk <= SLING.trunkStill ? Math.min(1, held / SLING.holdMs) : 0;
          if (!armed && s.power >= SLING.powerMin) out.hint = "point to your side";
          if (armed && steady && s.power >= SLING.powerMin) {
            if (state !== "ready") readySince = s.t;
            state = "ready";
            readyAt = s.t;
            readyD = s.d;
          } else if (state === "ready" && !steady) state = "drawing";
          // The release: a flick, read once.
          const then = before(s.t - SLING.snapMs);
          const growth = s.d - then.d;
          const recentlyReady = readyAt >= s.t - SLING.snapMs - 150;
          // The sling arm going out is the draw, not a flick: both hands move apart, the sling hand most.
          const drawing = !recentlyReady && dist(s.rel, then.rel) >= SLING.slingStill;
          if (release === "flick" && !drawing && s.t >= quietUntil && growth >= SLING.snap && dist(s.pull, then.pull) >= SLING.snap * 0.8) {
            quietUntil = s.t + 300;
            // The last pose before the hands began to separate.
            let sep = then;
            for (let k = history.length - 1; k >= 0; k--) {
              const h = history[k];
              if (h.t > s.t) continue;
              if (h.d <= Math.max(readyD, then.d) + 0.02) {
                sep = h;
                break;
              }
            }
            const slingMove = dist(s.rel, sep.rel);
            const pullMove = dist(s.pull, sep.pull);
            out.slingMove = slingMove;
            // Read early in the flick: a sling hand already moving most of what the pulling hand moves is thrown, not held.
            const thrown = slingMove >= SLING.slingStill || (slingMove >= SLING.slingStill / 2 && slingMove >= 0.6 * pullMove);
            const aimed = aimFrom(sep.t);
            const sepArmed = aim === "height" || (sep.arm >= SLING.sideOn * armRef() && sep.rel.x * i.dir >= 0.6 * armRef());
            if (!(readyAt >= sep.t - 120)) out.refused = { reason: "settle", gate: "no steady hold before the flick" };
            else if (thrown) out.refused = { reason: "sling moved", gate: `sling wrist moved ${Math.round(slingMove * 100)} cm` };
            else if (!sepArmed) out.refused = { reason: "point to your side", gate: "sling arm short in the picture" };
            else if (!aimed || launchSpeed(aimed.power) === null) out.refused = { reason: "pull further", gate: "draw under 30%" };
            else {
              out.shot = {
                t: s.t,
                cap: s.cap,
                handLine: aimed.line,
                angle: launchAngle(aimed.line, setup.level),
                power: Math.min(1, aimed.power),
                speed: launchSpeed(aimed.power)!,
                release: "flick",
                raisedMs: s.t - raisedAt,
                readMs: s.t - sep.t,
                hand: aimed.hand,
              };
            }
            state = "down";
          } else if (release === "still" && state === "ready" && s.t - readySince >= SLING.stillFireMs && s.power >= 0.85) {
            const aimed = aimFrom(s.t);
            if (aimed && launchSpeed(aimed.power) !== null) {
              out.shot = {
                t: s.t,
                cap: s.cap,
                handLine: aimed.line,
                angle: launchAngle(aimed.line, setup.level),
                power: Math.min(1, aimed.power),
                speed: launchSpeed(aimed.power)!,
                release: "still",
                raisedMs: s.t - raisedAt,
                readMs: 0,
                hand: aimed.hand,
              };
              state = "down";
              rearm = true;
            }
          }
        }
      }
      out.state = state;
      out.armUp = state !== "down" || s.sling.y > -0.05;
      if (was !== "down" && state === "down" && !out.shot && !out.refused && !out.cancelled && was !== "nocked") out.cancelled = "dropped";
      return out;
    },
  };
}
export type SlingReader = ReturnType<typeof createSlingReader>;

/**
 * Set-up: three full draws held still, pointing at the opponent the way that
 * feels natural. From them: the player's own level, full draw and arm length.
 */
export function createSlingSetup(side: Side) {
  const holds: { line: number; d: number; arm: number }[] = [];
  let acc: { line: number; d: number; arm: number }[] = [];
  let since = -Infinity;
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  return {
    holds: () => holds.length,
    /** Feed every pose; returns the measured set-up once three holds are in. */
    update(pose: FlatPose): SlingSetup | null {
      const L = side === "left";
      const S = pose.j[L ? JOINT.L_SHOULDER : JOINT.R_SHOULDER],
        Sw = pose.j[L ? JOINT.L_WRIST : JOINT.R_WRIST],
        P = pose.j[L ? JOINT.R_WRIST : JOINT.L_WRIST];
      const dir = L ? -1 : 1;
      const along = (Sw.x - P.x) * dir;
      const arm = dist(Sw, S),
        d = dist(Sw, P);
      const ok = along > 0.3 && arm > 0.3 && d > 0.45 && !pose.held;
      if (!ok) {
        acc = [];
        since = -Infinity;
        return null;
      }
      const line = deg(Math.atan2(Sw.y - P.y, along));
      acc.push({ line, d, arm });
      if (since === -Infinity) since = pose.t;
      // Steady: the last 0.5 s within 4 cm.
      while (acc.length > 40) acc.shift();
      const ds = acc.map((a) => a.d);
      if (Math.max(...ds) - Math.min(...ds) > 0.05) {
        acc = acc.slice(-3);
        since = pose.t;
        return null;
      }
      if (pose.t - since >= 500 && acc.length >= 8) {
        holds.push({ line: median(acc.map((a) => a.line)), d: median(ds), arm: median(acc.map((a) => a.arm)) });
        acc = [];
        since = Infinity;
      }
      if (holds.length >= 3)
        return {
          side,
          level: median(holds.map((h) => h.line)),
          fullDraw: median(holds.map((h) => h.d)),
          armLen: median(holds.map((h) => h.arm)),
          measured: true,
        };
      return null;
    },
    /** After a hold is taken, the hands must come in before the next one counts. */
    rearm(pose: FlatPose) {
      const L = side === "left";
      const d = dist(pose.j[L ? JOINT.L_WRIST : JOINT.R_WRIST], pose.j[L ? JOINT.R_WRIST : JOINT.L_WRIST]);
      if (d < 0.3) since = -Infinity;
    },
  };
}
