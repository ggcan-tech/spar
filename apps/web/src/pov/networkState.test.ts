import { describe, expect, it } from "vitest";
import { createDuel, launchBall, stepDuel, type DuelState } from "./duel";
import { parseNetworkState } from "./networkState";
import { JOINT, solveBody } from "./body";

const launched = (): DuelState => {
  const state = createDuel();
  return launchBall(state, 0, {
    origin: { ...state.poses[0].rightHand },
    velocity: { x: 1, y: 6, z: 10 },
    spin: { x: 8, y: 4, z: 0 },
  });
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("authoritative POV state decoding", () => {
  it("carries detached impact events and rejects malformed or still-live impacts", () => {
    let state = launched();
    for (let i = 0; i < 600 && !state.events?.length; i++)
      state = stepDuel(state, state.poses);
    expect(state.events).toHaveLength(1);
    const decoded = parseNetworkState(state)!;
    expect(decoded.events).toEqual(state.events);
    state.events![0].position.x = NaN;
    expect(parseNetworkState(state)).toBeNull();
    expect(Number.isFinite(decoded.events![0].position.x)).toBe(true);
    const future = clone(decoded);
    future.events![0].at = future.time + 1;
    expect(parseNetworkState(future)).toBeNull();
    const duplicate = clone(decoded);
    duplicate.events!.push(duplicate.events![0]);
    expect(parseNetworkState(duplicate)).toBeNull();
    const live = launched();
    live.events = [
      { id: 1, at: 0, target: 1, kind: "hit", position: { x: 0, y: 1, z: -8 } },
    ];
    expect(parseNetworkState(live)).toBeNull();
    const legacy = createDuel();
    delete legacy.events;
    expect(parseNetworkState(legacy)?.events).toEqual([]);
  });
  it("accepts initial, launched and genuinely stepped simulation snapshots", () => {
    expect(parseNetworkState(createDuel())).toEqual(createDuel());
    let state = launched();
    for (let i = 0; i < 720; i++) {
      expect(parseNetworkState(JSON.parse(JSON.stringify(state)))).toEqual(
        state,
      );
      state = stepDuel(state, state.poses);
    }
    expect(state.misses + state.hits).toBeGreaterThan(0);
  });
  it("returns a canonical deep copy and discards extra properties", () => {
    const source = { ...launched(), injected: "ignored" };
    const parsed = parseNetworkState(source)!;
    source.poses[0].head.y = 2;
    source.balls[0].velocity.x = 17;
    source.hp[0] = 0;
    expect(parsed.poses[0].head.y).toBe(1.65);
    expect(parsed.balls[0].velocity.x).toBe(1);
    expect(parsed.hp[0]).toBe(5);
    expect(parsed).not.toHaveProperty("injected");
  });
  it.each([null, [], true, 1, "state", {}, { time: 0 }])(
    "rejects malformed top-level input %j",
    (value) => {
      expect(parseNetworkState(value)).toBeNull();
    },
  );
  it("rejects nonfinite numbers instead of letting them enter rendering/physics", () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      const a = launched();
      a.time = n;
      expect(parseNetworkState(a)).toBeNull();
      const b = launched();
      b.balls[0].velocity.z = n;
      expect(parseNetworkState(b)).toBeNull();
      const c = launched();
      c.previous[1].leftHand.x = n;
      expect(parseNetworkState(c)).toBeNull();
    }
  });
  it("validates time and cooldowns without inventing a short match-duration cap", () => {
    const state = createDuel();
    state.time = 7 * 24 * 60 * 60;
    state.cooldown = [state.time + 1, state.time];
    expect(parseNetworkState(state)).not.toBeNull();
    state.time++;
    expect(parseNetworkState(state)).toBeNull();
    const bad = createDuel();
    bad.cooldown[0] = 1.1;
    expect(parseNetworkState(bad)).toBeNull();
    bad.cooldown[0] = -1;
    expect(parseNetworkState(bad)).toBeNull();
  });
  it("requires exact two-player tuples and valid current and previous poses", () => {
    for (const key of ["poses", "previous", "hp", "cooldown"]) {
      const state: Record<string, unknown> = { ...createDuel(), [key]: [] };
      expect(parseNetworkState(state)).toBeNull();
      state[key] = [1, 2, 3];
      expect(parseNetworkState(state)).toBeNull();
    }
    const outside = createDuel();
    outside.poses[0].root.x = 0.61;
    expect(parseNetworkState(outside)).toBeNull();
    const old = createDuel();
    old.previous = clone(old.previous);
    old.previous[1].head.y = 30;
    expect(parseNetworkState(old)).toBeNull();
  });
  it("rejects sparse tuples rather than allowing every() to skip missing values", () => {
    for (const key of ["hp", "cooldown", "poses", "previous"]) {
      expect(
        parseNetworkState({ ...createDuel(), [key]: new Array(2) }),
      ).toBeNull();
    }
  });
  it("rejects illegal HP, counters, owner and noninteger IDs", () => {
    for (const hp of [-1, 1.5, 6]) {
      const s = createDuel();
      s.hp[0] = hp;
      expect(parseNetworkState(s)).toBeNull();
    }
    for (const hits of [-1, 0.5, 1]) {
      const s = createDuel();
      s.hits = hits;
      expect(parseNetworkState(s)).toBeNull();
    }
    const wrongOwner = launched();
    (wrongOwner.balls[0] as unknown as { owner: number }).owner = 2;
    expect(parseNetworkState(wrongOwner)).toBeNull();
    for (const id of [0, 1.2, 2, Number.MAX_SAFE_INTEGER + 1]) {
      const s = launched();
      s.balls[0].id = id;
      expect(parseNetworkState(s)).toBeNull();
    }
  });
  it("rejects duplicate ball IDs, oversize arrays and overlong messages", () => {
    const duplicate = launched();
    duplicate.nextId = 3;
    duplicate.balls.push(clone(duplicate.balls[0]));
    expect(parseNetworkState(duplicate)).toBeNull();
    const many = launched();
    many.nextId = 66;
    many.balls = Array.from({ length: 65 }, (_, i) => ({
      ...clone(many.balls[0]),
      id: i + 1,
    }));
    expect(parseNetworkState(many)).toBeNull();
    const text = createDuel();
    text.message = "a".repeat(301);
    expect(parseNetworkState(text)).toBeNull();
  });
  it("enforces current ball lifetime, radius, position, speed and spin envelopes", () => {
    const mutate = (fn: (s: DuelState) => void) => {
      const s = launched();
      fn(s);
      expect(parseNetworkState(s)).toBeNull();
    };
    mutate((s) => {
      s.balls[0].age = 1;
    }); // A ball cannot predate state time.
    mutate((s) => {
      s.time = 10;
      s.balls[0].age = 6;
    });
    mutate((s) => {
      s.balls[0].radius = 10;
    });
    mutate((s) => {
      s.balls[0].position.x = 1e5;
    });
    mutate((s) => {
      s.balls[0].velocity.z = 30;
    });
    mutate((s) => {
      s.balls[0].spin.y = 101;
    });
  });
  it("fails closed for throwing getters and null vectors", () => {
    const trapped = Object.defineProperty({}, "time", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => parseNetworkState(trapped)).not.toThrow();
    expect(parseNetworkState(trapped)).toBeNull();
    const bad = launched();
    (bad.balls[0] as unknown as { spin: null }).spin = null;
    expect(parseNetworkState(bad)).toBeNull();
  });
  it("carries an optional skeleton and rejects a malformed one outright", () => {
    const state = createDuel();
    state.poses[1].body = solveBody(state.poses[1]);
    const decoded = parseNetworkState(clone(state))!;
    expect(decoded.poses[1].body).toEqual(state.poses[1].body);
    expect(decoded.poses[0].body).toBeUndefined();
    // Detached from the input: later edits to the message cannot reach the state.
    state.poses[1].body[JOINT.NOSE].x = 0.5;
    expect(decoded.poses[1].body![JOINT.NOSE].x).toBe(0);
    const short = clone(state);
    short.poses[1].body!.pop();
    expect(parseNetworkState(short)).toBeNull();
    const garbage = clone(state) as unknown as {
      poses: { body: unknown }[];
    };
    garbage.poses[1].body = "skeleton";
    expect(parseNetworkState(garbage)).toBeNull();
    const far = clone(state);
    far.poses[1].body![JOINT.L_KNEE].z = 40;
    expect(parseNetworkState(far)).toBeNull();
    const hole = clone(state) as unknown as { poses: { body: unknown[] }[] };
    hole.poses[1].body[JOINT.R_ANKLE] = null;
    expect(parseNetworkState(hole)).toBeNull();
  });
});
