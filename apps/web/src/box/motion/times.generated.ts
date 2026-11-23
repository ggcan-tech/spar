// Written by tools/anim/build.mjs from the recorded clips. Do not edit: run the build again.
// Seconds. load: first movement to the fist leaving. strike: the fist leaving to contact.
// home: contact to the hand back in the guard. seen: how long before the fist leaves the
// body's movement stands out from the boxer's own bounce (three times its usual size).

/** The mean of the kept takes of each kind. */
export const KIND_TIMES = {
  "jab": {
    "load": 0.23,
    "strike": 0.192,
    "home": 0.454,
    "seen": 0.071,
    "takes": 2
  },
  "cross": {
    "load": 0.134,
    "strike": 0.2,
    "home": 0.421,
    "seen": 0,
    "takes": 2
  },
  "hook": {
    "load": 0.296,
    "strike": 0.244,
    "home": 0.55,
    "seen": 0.136,
    "takes": 4
  },
  "uppercut": {
    "load": 0.41,
    "strike": 0.3,
    "home": 0.715,
    "seen": 0.212,
    "takes": 4
  },
  "body": {
    "load": 0.15,
    "strike": 0.183,
    "home": 0.364,
    "seen": 0.046,
    "takes": 4
  }
} as const;

/** Each kept take of a single punch. */
export const CLIP_TIMES = {
  "jab_a": {
    "kind": "jab",
    "hand": "lead",
    "level": "head",
    "load": 0.217,
    "strike": 0.208,
    "home": 0.483,
    "seen": 0.025
  },
  "jab_b": {
    "kind": "jab",
    "hand": "lead",
    "level": "head",
    "load": 0.242,
    "strike": 0.175,
    "home": 0.425,
    "seen": 0.117
  },
  "cross_a": {
    "kind": "cross",
    "hand": "rear",
    "level": "head",
    "load": 0.175,
    "strike": 0.183,
    "home": 0.442,
    "seen": 0
  },
  "cross_b": {
    "kind": "cross",
    "hand": "rear",
    "level": "head",
    "load": 0.092,
    "strike": 0.217,
    "home": 0.4,
    "seen": 0
  },
  "hook_lead_a": {
    "kind": "hook",
    "hand": "lead",
    "level": "head",
    "load": 0.333,
    "strike": 0.358,
    "home": 0.567,
    "seen": 0.267
  },
  "hook_lead_b": {
    "kind": "hook",
    "hand": "lead",
    "level": "head",
    "load": 0.292,
    "strike": 0.192,
    "home": 0.525,
    "seen": 0.067
  },
  "hook_rear_a": {
    "kind": "hook",
    "hand": "rear",
    "level": "head",
    "load": 0.25,
    "strike": 0.233,
    "home": 0.583,
    "seen": 0
  },
  "hook_rear_b": {
    "kind": "hook",
    "hand": "rear",
    "level": "head",
    "load": 0.308,
    "strike": 0.192,
    "home": 0.525,
    "seen": 0.208
  },
  "upper_lead_a": {
    "kind": "uppercut",
    "hand": "lead",
    "level": "head",
    "load": 0.442,
    "strike": 0.333,
    "home": 0.617,
    "seen": 0.417
  },
  "upper_lead_b": {
    "kind": "uppercut",
    "hand": "lead",
    "level": "head",
    "load": 0.433,
    "strike": 0.342,
    "home": 0.5,
    "seen": 0.408
  },
  "upper_rear_a": {
    "kind": "uppercut",
    "hand": "rear",
    "level": "head",
    "load": 0.358,
    "strike": 0.258,
    "home": 0.875,
    "seen": 0.025
  },
  "upper_rear_b": {
    "kind": "uppercut",
    "hand": "rear",
    "level": "head",
    "load": 0.408,
    "strike": 0.267,
    "home": 0.867,
    "seen": 0
  },
  "body_lead_straight_a": {
    "kind": "body",
    "hand": "lead",
    "level": "body",
    "load": 0.208,
    "strike": 0.183,
    "home": 0.467,
    "seen": 0.033
  },
  "body_rear_straight_a": {
    "kind": "body",
    "hand": "rear",
    "level": "body",
    "load": 0.167,
    "strike": 0.175,
    "home": 0.475,
    "seen": 0.1
  },
  "body_lead_hook_a": {
    "kind": "body",
    "hand": "lead",
    "level": "body",
    "load": 0.058,
    "strike": 0.242,
    "home": 0.333,
    "seen": 0
  },
  "body_rear_hook_a": {
    "kind": "body",
    "hand": "rear",
    "level": "body",
    "load": 0.167,
    "strike": 0.133,
    "home": 0.183,
    "seen": 0.05
  }
} as const;

/** Every punch found in the recordings, kept or not: how many, and the middle value of each time. */
export const FOUND_TIMES = {
  "jab": {
    "count": 88,
    "load": 0.217,
    "strike": 0.192,
    "home": 0.425,
    "seen": 0.042
  },
  "cross": {
    "count": 64,
    "load": 0.2,
    "strike": 0.208,
    "home": 0.483,
    "seen": 0.042
  },
  "hook": {
    "count": 15,
    "load": 0.325,
    "strike": 0.217,
    "home": 0.575,
    "seen": 0.067
  },
  "uppercut": {
    "count": 30,
    "load": 0.417,
    "strike": 0.258,
    "home": 0.608,
    "seen": 0.167
  },
  "body": {
    "count": 28,
    "load": 0.325,
    "strike": 0.192,
    "home": 0.483,
    "seen": 0.067
  }
} as const;

/** The kept steps: how long each takes and how far it goes. */
export const STEP_TIMES = {
  "step_in_a": {
    "seconds": 0.333,
    "metres": 0.342
  },
  "step_in_b": {
    "seconds": 0.25,
    "metres": 0.165
  },
  "step_out_a": {
    "seconds": 0.267,
    "metres": 0.277
  },
  "step_out_b": {
    "seconds": 0.217,
    "metres": 0.181
  }
} as const;

/** The kept combinations: seconds from each contact to the next. */
export const COMBO_GAPS = {
  "combo_jab_cross": [
    0.208
  ],
  "combo_jab_cross_jab": [
    0.192,
    0.25
  ],
  "combo_cross_jab": [
    0.258
  ],
  "combo_cross_jab_cross": [
    0.283,
    0.333
  ],
  "combo_upper_rear_upper_lead": [
    0.483
  ],
  "combo_body_lead_hook_upper_rear": [
    0.283
  ],
  "combo_jab_jab": [
    0.3
  ]
} as const;
