import { describe, expect, it } from 'vitest';
import { createGestureEngine, calibrate, synth } from '../src';
import { isPunch, PUNCH_KINDS } from './helpers';

describe('shape evidence', () => {
  it('does not call a fast downward arm extension a jab', () => {
    const fig = synth.FIGURE;
    const reachDown = synth.animate(450, t => {
      const p = synth.neutralPose(fig);
      const amount = t <= 150 ? synth.ease(t / 150) : 1 - synth.ease((t - 150) / 300);
      const start = synth.guardWrist(fig, 'L');
      p.wrist.L = { x: start.x, y: start.y + 2 * amount, z: start.z };
      return p;
    });
    const engine = createGestureEngine(calibrate(synth.calibrationClip()));
    const events = synth.sequence([synth.guard(600), reachDown, synth.guard(600)]).flatMap(f => engine.push(f));
    expect(events.filter(isPunch)).toEqual([]);
  });

  it.each([24, 30, 60])('recognizes explicit straight, hook and upper trajectories at %s fps', fps => {
    for (const kind of PUNCH_KINDS) {
      const engine = createGestureEngine(calibrate(synth.calibrationClip({ fps })));
      const frames = synth.sequence([synth.guard(600, { fps }), synth.punch(kind, 'orthodox', { fps }), synth.guard(600, { fps })], fps);
      const events = frames.flatMap(f => engine.push(f)).filter(isPunch);
      expect(events.map(e => e.type), kind).toEqual([kind]);
    }
  });
});
