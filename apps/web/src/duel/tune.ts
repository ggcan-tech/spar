/**
 * Every number the duel plays by, in one place. Taken from the tuning table of
 * docs/production/DUEL.md (section 9), which is the single source of truth:
 * when the two disagree, change this file to match it. Almost all are guesses
 * to be changed by play; the few measured on the founder's recording say so.
 *
 * Units: metres, seconds (as ms where named so), degrees where named so.
 * The field is a flat side view: x along the line of fire (screen right is +x),
 * y up from the floor.
 */
export const FIELD = {
  /** Lane middles: the left lane at -laneMiddle, the right at +laneMiddle. */
  laneMiddle: 1.6,
  /** Each lane is this wide, centred on its middle: ±0.5 m around the home spot. */
  laneWidth: 1.0,
  /** A low wall in the middle of the gap. */
  wallHeight: 2.0,
  wallThick: 0.08,
  /** Shown across the screen. */
  viewWidth: 4.6,
  /** Shown from the floor to here; higher lobs get an edge marker. */
  viewHeight: 2.6,
  /** The standard figure: one tracker unit (shoulders 0.4 units apart) is this many metres, for everyone. */
  figureUnit: 0.95,
  /** The standard figure's standing hip height, metres (one unit). */
  hipHeight: 0.95,
} as const;

/** Hit zones, drawn and judged the same (DUEL.md 1.8, 9.2). */
export const ZONES = {
  /** Head disc radius, centred this far above the nose point. */
  headRadius: 0.08,
  headAboveNose: 0.03,
  /** Chest plate: width, height, and its top this far under the shoulder line. */
  chestWide: 0.3,
  chestTall: 0.32,
  chestBelowShoulders: 0.02,
  ball: 0.07,
  /** Head 2, chest 1. */
  damage: { head: 2, chest: 1 } as const,
  /** Within this of a zone with no hit: a close call. */
  closeCall: 0.12,
  /** Rule D: the pose captured this long after the touch must overlap too. Per device later. */
  ruleDMs: 80,
  /** After a hit: cannot be hit again for this long. */
  safeAfterHitMs: 1000,
  /** Both hit within this: both lose hearts. */
  sameMomentMs: 100,
} as const;

/** The body slingshot (DUEL.md 1.3, 9.3). */
export const SLING = {
  /** Hands this near each other, metres, at the chest: nocked. */
  nockHands: 0.16,
  /** The sling arm must show at least this share of its set-up length (pointing to the side, not at the screen). */
  sideOn: 0.85,
  /** Hands steady within this, metres, for `holdMs`: ready to let go. */
  steady: 0.045,
  holdMs: 300,
  /** The trunk slower than this while holding, metres a second. */
  trunkStill: 0.5,
  /** A flick: the hands this much further apart, metres, within `snapMs`. */
  snap: 0.1,
  snapMs: 150,
  /** During a flick the sling wrist may move at most this, metres, against its own shoulder. */
  slingStill: 0.12,
  /** Direction and power come from this window, ending at the last pose before the hands separate. */
  aimWindowMs: 150,
  /**
   * Launch angle = base + gain × (hand line − own level), held between min and max, degrees.
   * DUEL.md says 40–65°. Built on the standard figure (sling hand about 1.4 m up, 0.87 m
   * from the wall), a 40° ball at full power meets the 2.0 m wall, so a natural point
   * would always hit the wall. 50° is the flattest that clears it at full power from a
   * natural point; the fastest ball to a head is then about 1.2 s and the slowest lob
   * about 1.6 s (arena.test.ts).
   */
  angleBase: 50,
  angleGain: 1.0,
  angleMin: 50,
  angleMax: 66,
  /** A natural "point at them", before set-up measures it, degrees. */
  ownLevel: -5,
  /** Power is the hand distance against the player's own full draw; under this share, no shot. */
  powerMin: 0.3,
  /** Launch speed from the least to the full draw, metres a second. */
  speedMin: 2.3,
  speedMax: 3.3,
  /** The sling arm dropped this far below the player's level cancels the draw, degrees. */
  dropCancel: 35,
  /** Stillness release (opt-in): a full draw held this still this long fires. */
  stillFireMs: 600,
  /** The first set-up shot fires on stillness if no flick comes within this. */
  setupStillAfterMs: 20_000,
  /** Sling hand this near the picture edge: glow. */
  edgeGlow: 0.15,
  /** What the shooter sees of the path: the first quarter second. */
  stubS: 0.25,
} as const;

/** Flight (DUEL.md 1.6, 9.4). */
export const FLIGHT = {
  gravity: 3.5,
  /** Fan bands by launch angle, degrees: under `flat` is flat, under `middle` middle, else high. */
  fanFlat: 55,
  fanMiddle: 60,
} as const;

/** The two-ball economy and rounds (DUEL.md 1.5, 1.9, 9.5, 9.7). */
export const RULES = {
  balls: 2,
  /** Each ball held has this clock; at zero it drops on its holder as a slow lob. */
  clockMs: 5000,
  selfLobS: 1.2,
  /** A landed ball becomes the receiver's after this, or at once if their trunk comes this near. */
  pickupMs: 800,
  pickupNear: 0.25,
  /** A ball that misses both lanes goes to the one it was thrown at after this. */
  strayMs: 1000,
  /** Two held: at least this between your two releases. */
  secondGapMs: 1000,
  hearts: 4,
  /** The lanes lose `squeezeStep` at their back edge at each of these times, seconds. */
  squeezeAt: [40, 50],
  squeezeStep: 0.15,
  roundEndS: 75,
  roundsToWin: 2,
  restS: 20,
} as const;

/** The training bots (DUEL.md 11, step 3). */
export const BOT = {
  /** The perfect defender reads a ball this long after it appears. */
  wallReadMs: 300,
  /** Median trunk speed sideways, metres a second; ducks go down at this. */
  trunkSpeed: 0.6,
  duckSpeed: 0.8,
  /** How long a bot takes from picking up a ball to letting it go, seconds (Coach). */
  aimS: [1.2, 3.2],
} as const;
