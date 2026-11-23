import type { Vec3 } from "../../pov/physics";
import { JOINT_COUNT, type Clip, type MotionKind, type MotionLevel, type MotionShape, type Pack, type PunchMark, type StanceHand } from "./types";

/**
 * The clip pack as `tools/anim/build.mjs` writes it, and its loader.
 *
 * A clip's frames are stored as base64 text of 16-bit whole numbers, three
 * to a point, eleven points to a frame, `unit` metres each. That keeps
 * thirty-odd clips near 200 KB.
 */
export const PACK_URL = "/box/anim/pack.json";

interface RawMark {
  kind: MotionKind;
  hand: StanceHand;
  level: MotionLevel;
  shape: MotionShape;
  events: { first: number; seen: number; launch: number; contact: number; guard: number };
  contact: { hand: number[]; aim: number[] };
}
/** A clip as it is in the file. A single punch carries its mark's fields itself; a combination has `parts`. */
export interface RawClip {
  id: string;
  kind: string;
  hand?: StanceHand;
  level?: MotionLevel;
  shape?: MotionShape;
  events?: Partial<RawMark["events"]> & { start?: number; end?: number };
  contact?: RawMark["contact"];
  source: string;
  from: number;
  to: number;
  mirrored: boolean;
  fps: number;
  frames: number;
  parts?: RawMark[];
  interrupt?: number[][];
  chain?: { from: number; to: number; next?: string[] };
  rate?: { load: number[]; strike: number[] };
  other?: string;
  loop?: boolean;
  bounce?: number;
  dir?: string;
  travel?: number;
  curve?: number[];
  data: string;
}
export interface RawPack {
  version: number;
  fps: number;
  unit: number;
  joints: string[];
  clips: unknown[];
}

const point = (p: number[]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });
const mark = (m: RawMark): PunchMark => ({
  kind: m.kind,
  hand: m.hand,
  level: m.level,
  shape: m.shape,
  events: { ...m.events },
  contact: { hand: point(m.contact.hand), aim: point(m.contact.aim) },
});

/** Base64 text to bytes, in a browser or in node. */
function bytesOf(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The file's contents as a pack ready to play. Throws if a clip's data is the wrong size. */
export function parsePack(raw: RawPack): Pack {
  if (raw.joints.length !== JOINT_COUNT) throw new Error("motion pack: unexpected joints");
  const clips = (raw.clips as RawClip[]).map((c): Clip => {
    const bytes = bytesOf(c.data);
    const count = c.frames * JOINT_COUNT * 3;
    if (bytes.length !== count * 2) throw new Error(`motion pack: ${c.id} has ${bytes.length} bytes, wanted ${count * 2}`);
    const view = new DataView(bytes.buffer);
    const data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = view.getInt16(i * 2, true) * raw.unit;
    const single = c.kind !== "guard" && c.kind !== "step" && c.kind !== "combo";
    const punches = c.parts ? c.parts.map(mark) : single && c.events && c.contact ? [mark(c as unknown as RawMark)] : [];
    const isStep = c.kind === "step" && c.events && c.curve;
    return {
      id: c.id,
      source: c.source,
      from: c.from,
      to: c.to,
      mirrored: c.mirrored,
      fps: c.fps,
      frames: c.frames,
      kind: c.kind as Clip["kind"],
      punches,
      step: isStep
        ? {
            dir: c.dir === "out" ? "out" : "in",
            start: c.events?.start ?? 0,
            end: c.events?.end ?? c.frames - 1,
            travel: c.travel ?? 0,
            curve: (c.curve ?? []).map((k) => k / 1000),
          }
        : null,
      loop: c.loop === true,
      bounce: c.bounce ?? 0,
      interrupt: (c.interrupt ?? []).map((s) => [s[0], s[1]] as [number, number]),
      chain: c.chain ? { from: c.chain.from, to: c.chain.to, next: c.chain.next ?? [] } : null,
      rate: {
        load: [c.rate?.load[0] ?? 0.6, c.rate?.load[1] ?? 1],
        strike: [c.rate?.strike[0] ?? 0.9, c.rate?.strike[1] ?? 1.1],
      },
      other: c.other === "busy" ? "busy" : "guard",
      data,
    };
  });
  return {
    fps: raw.fps,
    clips,
    byId: new Map(clips.map((c) => [c.id, c])),
    guards: clips.filter((c) => c.kind === "guard"),
  };
}

/** Fetch and parse the pack. The game calls this once, before the first bell. */
export async function loadPack(url: string = PACK_URL): Promise<Pack> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`motion pack: ${response.status} for ${url}`);
  return parsePack((await response.json()) as RawPack);
}
