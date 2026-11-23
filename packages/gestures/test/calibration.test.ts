import { describe, expect, it } from 'vitest';
import { calibrate, defaultCalibration, synth } from '../src/index';
import { FPS, SIGMA } from './helpers';

describe('calibrate', () => {
  it('recovers armLen within 10% of the figure reach and detects an orthodox stance', () => {
    const cal = calibrate(synth.withNoise(synth.calibrationClip({ fps: FPS }), SIGMA, 5));
    expect(cal.stance).toBe('orthodox');
    expect(Math.abs(cal.armLen.lead - synth.ARM_LEN) / synth.ARM_LEN).toBeLessThan(0.1);
    expect(Math.abs(cal.armLen.rear - synth.ARM_LEN) / synth.ARM_LEN).toBeLessThan(0.1);
    expect(cal.shoulderWBaseline).toBeCloseTo(synth.FIGURE.sw, 2);
    expect(cal.chinY).toBeCloseTo(synth.FIGURE.nose.y + 0.25, 1);
    expect(cal.neutralNoseBodyY).toBeCloseTo(synth.FIGURE.nose.y, 1);
    expect(cal.neutralNoseX).toBeCloseTo(0, 1);
    expect(cal.auto).toBe(false);
  });

  it('detects a southpaw stance from the closer shoulder', () => {
    const cal = calibrate(synth.withNoise(synth.calibrationClip({ fps: FPS, stance: 'southpaw' }), SIGMA, 6));
    expect(cal.stance).toBe('southpaw');
    expect(Math.abs(cal.armLen.lead - synth.ARM_LEN) / synth.ARM_LEN).toBeLessThan(0.1);
  });

  it('honours an explicit stance', () => {
    const cal = calibrate(synth.calibrationClip({ fps: FPS }), 'southpaw');
    expect(cal.stance).toBe('southpaw');
  });

  it('falls back to the default reach when no extension was seen', () => {
    const cal = calibrate(synth.guard(1000, { fps: FPS }));
    expect(cal.armLen.lead).toBe(defaultCalibration().armLen.lead);
  });

  it('defaultCalibration is usable and auto-baselines', () => {
    const cal = defaultCalibration('southpaw');
    expect(cal.stance).toBe('southpaw');
    expect(cal.auto).toBe(true);
    expect(cal.armLen.lead).toBeCloseTo(2.2, 5);
  });
});
