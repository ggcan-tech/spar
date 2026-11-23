import { useEffect, useState } from 'react';
import type { Stance } from '@spar/protocol';
import type { DrillPrompt } from '../input/drill';
import './movement-demo.css';

export interface MovementDemoProps {
  prompt: DrillPrompt;
  stance?: Stance;
}

type Point = [number, number];
const mix = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const points = (...p: Point[]) => p.map((v) => v.join(',')).join(' ');

/** A mirrored movement illustration, not a biomechanical technique assessment. */
export function MovementDemo({ prompt, stance = 'orthodox' }: MovementDemoProps) {
  const [amount, setAmount] = useState(1);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let start = performance.now();
    let last = 0;
    const draw = (now: number) => {
      if (now - last > 32) {
        // Time to observe guard, a controlled move, then a deliberate return.
        const phase = ((now - start) % 2800) / 2800;
        const p = phase < .2 ? 0 : phase < .5 ? (phase - .2) / .3 : phase < .68 ? 1 : phase < .94 ? 1 - (phase - .68) / .26 : 0;
        setAmount(p * p * (3 - 2 * p));
        last = now;
      }
      frame = requestAnimationFrame(draw);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      start = performance.now();
      if (reduced.matches) setAmount(1);
      else frame = requestAnimationFrame(draw);
    };
    restart();
    reduced.addEventListener('change', restart);
    return () => { cancelAnimationFrame(frame); reduced.removeEventListener('change', restart); };
  }, [prompt.type]);

  const type = prompt.type;
  const leadLeft = stance === 'orthodox';
  const activeLeft = type === 'JAB' || type.startsWith('LEAD_') ? leadLeft : !leadLeft;
  const side = activeLeft ? -1 : 1;
  const stepX = type === 'STEP_L' ? -38 * amount : type === 'STEP_R' ? 38 * amount : 0;
  const slipX = type === 'SLIP_L' ? -25 * amount : type === 'SLIP_R' ? 25 * amount : 0;
  const dip = type === 'DUCK' ? 26 * amount : 0;
  const scale = type === 'STEP_IN' ? 1 + .14 * amount : type === 'STEP_OUT' ? 1 - .14 * amount : 1;
  const isPunch = prompt.cls === 'punch';
  const shoulder = (left: boolean): Point => [160 + (left ? -24 : 24) + slipX * .65, 95 + dip];
  const elbow = (left: boolean): Point => [160 + (left ? -39 : 39) + slipX * .4, 128 + dip];
  const hand = (left: boolean): Point => [160 + (left ? -23 : 23) + slipX, 77 + dip];
  const arm = (left: boolean) => {
    let e = elbow(left);
    let h = hand(left);
    if (isPunch && left === activeLeft) {
      if (type.endsWith('HOOK')) {
        e = mix(e, [160 + side * 57, 85], amount);
        h = mix(h, [160 - side * 14, 77], amount);
      } else if (type.endsWith('UPPER')) {
        // A bent arm travels upward from the ribs; avoid depicting a straight lift.
        h = mix([160 + side * 25, 130], [160 + side * 12, 63], amount);
        e = mix(e, [160 + side * 34, 112], amount);
      } else {
        e = mix(e, [160 + side * 22, 84], amount);
        h = mix(h, [160 + side * 4, 55], amount);
      }
    }
    if (type === 'GUARD_HIGH') h = mix([160 + (left ? -35 : 35), 143], h, amount);
    return <g key={String(left)}>
      <polyline className={`movement-demo__limb ${isPunch && left === activeLeft ? 'movement-demo__limb--active' : ''}`} points={points(shoulder(left), e, h)} />
      <circle cx={h[0]} cy={h[1]} r={isPunch && left === activeLeft && (type === 'JAB' || type === 'CROSS') ? 10 + 5 * amount : 10} className={isPunch && left === activeLeft ? 'movement-demo__glove--active' : 'movement-demo__glove'} />
    </g>;
  };
  const frontHand = leadLeft ? 'left' : 'right';
  return <div className="movement-demo">
    <div className="movement-demo__visual">
      <svg viewBox="0 0 320 265" role="img" aria-label={`Mirrored demonstration: ${prompt.instruction ?? prompt.label}`}>
        <ellipse cx="160" cy="235" rx="107" ry="18" className="movement-demo__floor" />
        <path d="M160 32V243 M55 235H265" className="movement-demo__axis" />
        <text x="22" y="24" className="movement-demo__label">YOUR LEFT</text>
        <text x="298" y="24" textAnchor="end" className="movement-demo__label">YOUR RIGHT</text>
        <g transform={`translate(${stepX} 0) translate(160 235) scale(${scale}) translate(-160 -235)`}>
          <polyline points={points([133, 235], [138, 184 + dip * .4], [146 + slipX * .15, 153 + dip], [174 + slipX * .15, 153 + dip], [183, 184 + dip * .4], [191, 235])} className="movement-demo__limb" />
          <path d={`M${136 + slipX * .65} ${95 + dip} L${146 + slipX * .15} ${153 + dip} L${174 + slipX * .15} ${153 + dip} L${184 + slipX * .65} ${95 + dip} Z`} className="movement-demo__torso" />
          <circle cx={160 + slipX} cy={65 + dip} r="20" className="movement-demo__head" />
          {arm(true)}{arm(false)}
        </g>
        {prompt.cls === 'step' && <text x="160" y="260" textAnchor="middle" className="movement-demo__direction">{type === 'STEP_IN' ? 'TOWARD CAMERA ↑' : type === 'STEP_OUT' ? 'AWAY FROM CAMERA ↓' : type === 'STEP_L' ? '← MOVE YOUR WHOLE BODY' : 'MOVE YOUR WHOLE BODY →'}</text>}
      </svg>
      <span className="movement-demo__caption">Mirror view · copy the movement</span>
    </div>
    <div className="movement-demo__copy">
      <span className="movement-demo__eyebrow">WATCH · TRY · RETURN</span>
      <p className="movement-demo__instruction">{prompt.instruction ?? prompt.label}</p>
      {isPunch && <p className="movement-demo__hand">Your front hand is your <strong>{frontHand}</strong>. Your back hand is your <strong>{leadLeft ? 'right' : 'left'}</strong>.</p>}
      <p className="movement-demo__cue">{prompt.cue}</p>
      <span className="movement-demo__note">Movement guide · recognition is not a technique score</span>
    </div>
  </div>;
}
