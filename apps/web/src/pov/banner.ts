/**
 * The few words that fill the stage. The player stands across the room and
 * cannot read a line of small text, so each state the player must act on gets
 * at most three large words and a colour. Everything else (depth tracking,
 * brief holds, filter states) stays in the playtest notes.
 *
 * selectBanner decides what applies now; the latch stops the stage flickering
 * between messages when the facts change from frame to frame.
 */
export type BannerTone =
  "setup" | "ready" | "turn" | "warn" | "paused" | "over";
export interface Banner {
  text: string;
  /** A smaller line under the words. */
  sub?: string;
  tone: BannerTone;
  /** Higher replaces lower at once. */
  tier: number;
  /** Shown for this long, then cleared, while its cause persists. */
  ttlMs?: number;
}
export interface BannerFacts {
  camera: "off" | "starting" | "live";
  /** A body is in the picture at all. */
  bodySeen: boolean;
  /** Parts setup still needs to see, e.g. ["hips"]. */
  missing: string[];
  calibrating: boolean;
  calibrated: boolean;
  /** 0–1. */
  progress: number;
  /** The round was started and not paused by the player. */
  running: boolean;
  /** The body is tracked. */
  valid: boolean;
  gate: "idle" | "get-in-place" | "counting" | "live" | null;
  /** null while the round is on; otherwise who won. */
  result: "won" | "lost" | null;
  ownsBall: boolean;
  /** The throwing hand is up and the ring is showing. */
  aiming: boolean;
  /** Tap mode: the ball is thrown by touching the screen, not by the arm. */
  tap?: boolean;
  /** Tap mode's line under YOUR BALL, if not the default. */
  tapSub?: string;
  /** The throwing hand is not in the picture. */
  handLost: boolean;
  /** Close to an edge of the camera's view. */
  nearEdge: boolean;
  /** A message from the match server that blocks play, if any. */
  network?: string | null;
  /** Why the camera could not start, when it could not. */
  problem?: CameraProblem | null;
  /** Where the body sits in the picture during setup. */
  framing?: Framing;
  /** A throw that just failed to register, and why. */
  hint?: "too-soft" | "hand-low" | null;
  /** Seconds left to throw, when the shot clock is running. */
  clock?: number | null;
  /** The round in one line, shown with the result. */
  summary?: string;
  /** The camera's picture is too dark to track in. */
  dim?: boolean;
  /** What is being loaded, while the camera starts. */
  loading?: string;
}

const TIER = { warn: 1, turn: 2, block: 4, over: 5 } as const;

/** What went wrong starting the camera, in the terms the banner uses. */
export type CameraProblem =
  | "denied"
  | "not-found"
  | "in-use"
  | "insecure-context"
  | "unsupported"
  | "model"
  | "unknown";
const PROBLEM: Record<CameraProblem, [string, string]> = {
  denied: [
    "CAMERA BLOCKED",
    "Allow the camera for this page, then press Enable camera",
  ],
  "in-use": [
    "CAMERA BUSY",
    "Close other apps or tabs using the camera, then try again",
  ],
  "not-found": ["NO CAMERA", "No camera was found on this device"],
  "insecure-context": [
    "CAMERA BLOCKED",
    "Open this page over https or on localhost",
  ],
  unsupported: ["NO CAMERA", "This browser cannot use the camera"],
  model: [
    "TRACKING DID NOT LOAD",
    "Check the connection, then press Enable camera",
  ],
  unknown: ["CAMERA ERROR", "Press Enable camera to try again"],
};

/** Where the body sits in the camera's picture, in the player's own terms. */
export type Framing =
  "no-body" | "come-closer" | "step-back" | "move-left" | "move-right" | "ok";
/**
 * `shoulderX` is the middle of the shoulders across the picture, 0 at the
 * image's left edge. The picture is not mirrored, so the image's left is the
 * player's right. `span` is shoulder width in image heights. Thresholds are
 * starting values; they need a real camera to tune.
 */
export function framingOf(
  shoulderX: number | null,
  span: number | null,
): Framing {
  if (shoulderX === null || span === null || !Number.isFinite(shoulderX))
    return "no-body";
  if (shoulderX < 0.3) return "move-left";
  if (shoulderX > 0.7) return "move-right";
  if (span < 0.07) return "come-closer";
  if (span > 0.45) return "step-back";
  return "ok";
}

export function selectBanner(f: BannerFacts): Banner | null {
  if (f.camera === "off") {
    if (!f.problem) return null;
    const [text, sub] = PROBLEM[f.problem];
    return { text, sub, tone: "warn", tier: TIER.block };
  }
  if (f.camera === "starting")
    return {
      text: "LOADING",
      sub: f.loading || undefined,
      tone: "setup",
      tier: TIER.block,
    };
  if (f.result)
    return {
      text: f.result === "won" ? "YOU WIN" : "YOU LOSE",
      sub:
        [f.summary, f.calibrated ? "Raise a hand to play again" : ""]
          .filter(Boolean)
          .join(" · ") || undefined,
      tone: "over",
      tier: TIER.over,
    };
  if (!f.calibrated) {
    // Off to one side of the picture, a dodge that way leaves it: say so
    // before setup settles on the spot.
    if (f.framing === "move-left" || f.framing === "move-right")
      return {
        text: f.framing === "move-left" ? "MOVE LEFT" : "MOVE RIGHT",
        sub: "Stand in the middle of the picture",
        tone: "setup",
        tier: TIER.block,
      };
    if (f.framing === "come-closer")
      return {
        text: "COME CLOSER",
        sub: "You are too small in the picture",
        tone: "setup",
        tier: TIER.block,
      };
    if (f.framing === "step-back")
      return {
        text: "STEP BACK",
        sub: "You are too close to the camera",
        tone: "setup",
        tier: TIER.block,
      };
    // Too dark to find the body: say that, not "step back".
    if (f.dim && !f.calibrating)
      return {
        text: "MORE LIGHT",
        sub: "The camera's picture is too dark to see you",
        tone: "warn",
        tier: TIER.block,
      };
    if (f.calibrating)
      return {
        text: "HOLD STILL",
        sub: `${Math.round(f.progress * 100)}%`,
        tone: "setup",
        tier: TIER.block,
      };
    return {
      text: "STEP BACK",
      sub:
        f.bodySeen && f.missing.length
          ? `Show your ${f.missing.join(" and ")}`
          : "Head to hips in view",
      tone: "setup",
      tier: TIER.block,
    };
  }
  if (f.network)
    return {
      text: "WAITING",
      sub: f.network,
      tone: "paused",
      tier: TIER.block,
    };
  if (!f.running)
    return {
      text: "RAISE A HAND",
      sub: "to start",
      tone: "ready",
      tier: TIER.block,
    };
  if (!f.valid)
    return {
      text: "PAUSED",
      sub: f.dim
        ? "The picture is too dark: add light"
        : "Step back into view",
      tone: "paused",
      tier: TIER.block,
    };
  if (f.gate === "get-in-place")
    return {
      text: "FIND YOUR SPOT",
      sub: "Stand in the middle and hold still",
      tone: "setup",
      tier: TIER.block,
    };
  // The count has its own large number.
  if (f.gate === "counting") return null;
  if (f.ownsBall) {
    // The last three seconds of the shot clock outrank the rest of the turn.
    if (f.clock !== null && f.clock !== undefined && f.clock <= 3)
      return {
        text: "THROW NOW",
        sub: String(Math.max(1, Math.ceil(f.clock))),
        tone: "warn",
        tier: TIER.turn + 1,
      };
    if (f.tap)
      return {
        text: "YOUR BALL",
        sub: f.tapSub ?? "Touch the screen where you want to hit them",
        tone: "turn",
        tier: TIER.turn,
      };
    if (f.hint)
      return {
        text: f.hint === "too-soft" ? "THROW HARDER" : "HAND HIGHER",
        sub:
          f.hint === "too-soft"
            ? "Like a real throw"
            : "Raise your hand above your waist first",
        tone: "warn",
        tier: TIER.turn + 1,
      };
    if (f.handLost)
      return { text: "SHOW YOUR HAND", tone: "turn", tier: TIER.turn };
    if (!f.aiming)
      return {
        text: "YOUR BALL",
        sub: "Raise your right hand",
        tone: "turn",
        tier: TIER.turn,
      };
    // Aiming: the ring is the message. Say it once, then get out of the way.
    return { text: "THROW", tone: "turn", tier: TIER.turn, ttlMs: 900 };
  }
  if (f.nearEdge)
    return { text: "BACK TO MIDDLE", tone: "warn", tier: TIER.warn };
  return null;
}

/** Shortest time a banner stays before an equal or lesser one may replace it. */
const HOLD_MS = 900;
/** How long a replacement must have applied before it is shown. */
const SETTLE_MS = 250;

export function createBannerLatch() {
  let shown: Banner | null = null,
    shownAt = -Infinity,
    expired: string | null = null,
    pending: Banner | null = null,
    pendingAt = -Infinity;
  const same = (a: Banner | null, b: Banner | null) =>
    a?.text === b?.text && a?.tone === b?.tone;
  return {
    reset() {
      shown = pending = null;
      expired = null;
      shownAt = pendingAt = -Infinity;
    },
    update(candidate: Banner | null, now: number): Banner | null {
      // A timed banner that has run out stays away until its cause changes.
      if (candidate?.text !== expired) expired = null;
      if (candidate && candidate.text === expired) candidate = null;
      if (same(candidate, shown)) {
        pending = null;
        if (shown && candidate) shown = candidate;
        if (shown?.ttlMs !== undefined && now - shownAt >= shown.ttlMs) {
          expired = shown.text;
          shown = null;
        }
        return shown;
      }
      if (!same(candidate, pending)) {
        pending = candidate;
        pendingAt = now;
      }
      const urgent = (candidate?.tier ?? 0) > (shown?.tier ?? 0);
      if (
        urgent ||
        !shown ||
        (now - shownAt >= HOLD_MS && now - pendingAt >= SETTLE_MS)
      ) {
        shown = candidate;
        shownAt = now;
        pending = null;
      }
      return shown;
    },
  };
}

/** The word for how a ball ended, from the local player's side. */
export function outcomeWord(
  kind: "hit" | "floor" | "out" | "catch",
  mine: boolean,
  /** The ball struck the head rather than the body. */
  head = false,
): string {
  // Where it landed on the player tells them what to move next time.
  if (kind === "hit")
    return mine
      ? head
        ? "HEAD HIT"
        : "BODY HIT"
      : head
        ? "HEADSHOT"
        : "GOT THEM";
  if (kind === "catch") return mine ? "CAUGHT!" : "THEY CAUGHT IT";
  return mine ? "DODGED" : "MISSED";
}
