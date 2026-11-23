import { BIT, PUNCH_MASK, type InputBits } from '@spar/protocol';

/** Local control study, not a network protocol or a physical ball simulation. */
export type Lane = -1 | 0 | 1;
export interface Ball { id: number; lane: Lane; low: boolean; born: number; arrives: number }
export interface DodgeState {
  frame: number; seed: number; hp: number; rivalHp: number; lane: Lane; duck: boolean;
  rivalLane: Lane; incoming: Ball[]; outgoing: Ball[]; nextId: number;
  nextRivalMove: number; nextRivalShot: number; nextShot: number;
  shots: number; hits: number; dodges: number; received: number;
  feedback: string; feedbackUntil: number; over: boolean;
}
export const DODGE_FRAMES = 60 * 60;
export const FLIGHT_FRAMES = 60;
export const SHOT_COOLDOWN = 42;
export function newDodge(seed = 8026): DodgeState {
  return { frame: 0, seed: seed || 1, hp: 8, rivalHp: 8, lane: 0, duck: false,
    rivalLane: 0, incoming: [], outgoing: [], nextId: 1, nextRivalMove: 110,
    nextRivalShot: 80, nextShot: 0, shots: 0, hits: 0, dodges: 0, received: 0,
    feedback: 'Move. Read. Release.', feedbackUntil: 120, over: false };
}
function random(s: DodgeState): number {
  let n = s.seed; n ^= n << 13; n ^= n >>> 17; n ^= n << 5;
  s.seed = n >>> 0; return s.seed / 4294967296;
}
export function stepDodge(previous: DodgeState, input: InputBits): DodgeState {
  if (previous.over) return previous;
  const s = { ...previous, frame: previous.frame + 1,
    incoming: previous.incoming.map(b => ({ ...b })), outgoing: previous.outgoing.map(b => ({ ...b })) };
  s.lane = input & BIT.SLIP_L ? -1 : input & BIT.SLIP_R ? 1 : 0;
  s.duck = !!(input & BIT.DUCK);
  const say = (message: string) => { s.feedback = message; s.feedbackUntil = s.frame + 45; };
  if (s.frame >= s.nextRivalMove) {
    const lanes: Lane[] = [-1, 0, 1];
    s.rivalLane = lanes[Math.floor(random(s) * lanes.length)];
    s.nextRivalMove = s.frame + 90 + Math.floor(random(s) * 60);
  }
  if (s.frame >= s.nextRivalShot) {
    // Aim at the visible current position, then commit. No homing or future-input access.
    s.incoming.push({ id: s.nextId++, lane: s.lane, low: s.duck, born: s.frame, arrives: s.frame + FLIGHT_FRAMES });
    s.nextRivalShot = s.frame + 95;
  }
  if ((input & PUNCH_MASK) && s.frame >= s.nextShot) {
    s.outgoing.push({ id: s.nextId++, lane: s.lane, low: false, born: s.frame, arrives: s.frame + 35 });
    s.nextShot = s.frame + SHOT_COOLDOWN; s.shots++;
  }
  for (const b of s.incoming.filter(b => b.arrives <= s.frame)) {
    if (b.lane === s.lane && b.low === s.duck) {
      s.hp = Math.max(0, s.hp - 1); s.received++; say('Caught in the lane');
    } else { s.dodges++; say('Clean escape'); }
  }
  for (const b of s.outgoing.filter(b => b.arrives <= s.frame)) {
    if (b.lane === s.rivalLane) {
      s.rivalHp = Math.max(0, s.rivalHp - 1); s.hits++; say('Clean hit');
    } else say('Rival moved away');
  }
  s.incoming = s.incoming.filter(b => b.arrives > s.frame);
  s.outgoing = s.outgoing.filter(b => b.arrives > s.frame);
  s.over = s.hp === 0 || s.rivalHp === 0 || s.frame >= DODGE_FRAMES;
  return s;
}

export function dodgeResult(s: DodgeState): 'win' | 'loss' | 'draw' {
  return s.hp > s.rivalHp ? 'win' : s.hp < s.rivalHp ? 'loss' : 'draw';
}
