import { describe, expect, it } from "vitest";
import type { DuelEvent } from "./duel";
import { approach, createSoundDirector, type SoundFacts } from "./soundCues";

const facts = (over: Partial<SoundFacts> = {}): SoundFacts => ({
  me: 0,
  calibrated: true,
  active: true,
  running: true,
  ownsBall: false,
  windup: false,
  released: null,
  events: [],
  hp: [5, 5],
  ...over,
});
const event = (
  id: number,
  kind: DuelEvent["kind"],
  target: 0 | 1,
): DuelEvent => ({ id, kind, target, position: { x: 0, y: 1, z: 0 }, at: 0 });
const kinds = (cues: { kind: string }[]) => cues.map((c) => c.kind);

describe("which sound plays when", () => {
  it("says nothing on the first snapshot and nothing while nothing changes", () => {
    const director = createSoundDirector();
    expect(director.update(facts({ ownsBall: true }))).toEqual([]);
    expect(director.update(facts({ ownsBall: true }))).toEqual([]);
  });

  it("marks setup locking once", () => {
    const director = createSoundDirector();
    director.update(
      facts({ calibrated: false, active: false, running: false }),
    );
    expect(
      kinds(director.update(facts({ active: false, running: false }))),
    ).toEqual(["setup-locked"]);
    expect(director.update(facts({ active: false, running: false }))).toEqual(
      [],
    );
  });

  it("plays each ball's outcome exactly once, named from the player's side", () => {
    const director = createSoundDirector();
    director.update(facts());
    const hitMe = [event(1, "hit", 0)];
    expect(
      kinds(director.update(facts({ events: hitMe, hp: [4, 5] }))),
    ).toEqual(["hit-self"]);
    // The event stays in the state for 0.7 s; it must not sound again.
    expect(director.update(facts({ events: hitMe, hp: [4, 5] }))).toEqual([]);
    expect(
      kinds(
        director.update(facts({ events: [event(2, "hit", 1)], hp: [4, 4] })),
      ),
    ).toEqual(["hit-opponent"]);
    expect(
      kinds(
        director.update(facts({ events: [event(3, "floor", 0)], hp: [4, 4] })),
      ),
    ).toEqual(["dodged"]);
    expect(
      kinds(
        director.update(facts({ events: [event(4, "out", 1)], hp: [4, 4] })),
      ),
    ).toEqual(["missed"]);
  });

  it("announces the ball arriving, the opponent winding up and a throw leaving", () => {
    const director = createSoundDirector();
    director.update(facts());
    expect(kinds(director.update(facts({ ownsBall: true })))).toEqual([
      "your-ball",
    ]);
    expect(director.update(facts({ ownsBall: true }))).toEqual([]);
    expect(director.update(facts({ released: 5.5 }))).toEqual([
      { kind: "release", power: 5.5 },
    ]);
    expect(kinds(director.update(facts({ windup: true })))).toEqual(["windup"]);
    expect(director.update(facts({ windup: true }))).toEqual([]);
  });

  it("marks tracking lost and back only during a round", () => {
    const director = createSoundDirector();
    director.update(facts());
    expect(kinds(director.update(facts({ active: false })))).toEqual([
      "tracking-lost",
    ]);
    expect(kinds(director.update(facts()))).toEqual(["tracking-back"]);
    // Pausing is the player's own action, not a tracking failure.
    expect(director.update(facts({ active: false, running: false }))).toEqual(
      [],
    );
  });

  it("re-announces a ball the player already held when play resumes", () => {
    const director = createSoundDirector();
    director.update(facts({ ownsBall: true, active: false }));
    expect(kinds(director.update(facts({ ownsBall: true })))).toEqual([
      "tracking-back",
      "your-ball",
    ]);
  });

  it("ends the round once and starts fresh for the next one", () => {
    const director = createSoundDirector();
    director.update(facts({ hp: [5, 1] }));
    const last = [event(9, "hit", 1)];
    expect(
      kinds(
        director.update(facts({ events: last, hp: [5, 0], active: false })),
      ),
    ).toEqual(["hit-opponent", "round-won"]);
    expect(
      director.update(facts({ events: last, hp: [5, 0], active: false })),
    ).toEqual([]);
    const lost = createSoundDirector();
    lost.update(facts({ hp: [1, 5] }));
    expect(
      kinds(lost.update(facts({ events: [event(9, "hit", 0)], hp: [0, 5] }))),
    ).toContain("round-lost");
    // New round: ball ids start again from 1 and must be heard again.
    director.update(facts({ hp: [5, 5] }));
    expect(
      kinds(
        director.update(facts({ events: [event(1, "hit", 0)], hp: [4, 5] })),
      ),
    ).toEqual(["hit-self"]);
  });
});

describe("approach sound", () => {
  it("rises from silent at the far end to full at the head, panned to the ball's side", () => {
    const head = { x: 0, z: 0 };
    expect(approach({ x: 0, z: 8 }, head, 8).closeness).toBe(0);
    expect(approach({ x: 0, z: 4 }, head, 8).closeness).toBeCloseTo(0.5);
    expect(approach({ x: 0, z: 0 }, head, 8).closeness).toBe(1);
    expect(approach({ x: 0.3, z: 2 }, head, 8).pan).toBeCloseTo(0.5);
    expect(approach({ x: -3, z: 2 }, head, 8).pan).toBe(-1);
  });
});
