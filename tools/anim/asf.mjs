// Reads CMU motion capture files: an ASF skeleton and an AMC motion, both
// plain text. Works out where every joint is in every frame (forward
// kinematics). No dependencies.
//
// The files measure length in inches divided by the skeleton's own
// `:units length` (0.45 for these), so both matter for metres.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where the downloaded CMU files are kept. */
export const SOURCE_DIR = join(HERE, "source", "cmu");
/** The trials were recorded at this many frames a second. */
export const SOURCE_FPS = 120;
const INCH = 0.0254;
const RAD = Math.PI / 180;

// ── Small 3×3 matrix helpers (row-major arrays of nine) ─────────────────────
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
  a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
  a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
  a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
  a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
  a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
  a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const transpose = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const apply = (a, v) => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];
/** Turn about x, then y, then z, all in degrees: the order these files use. */
function euler(x, y, z) {
  const cx = Math.cos(x * RAD), sx = Math.sin(x * RAD);
  const cy = Math.cos(y * RAD), sy = Math.sin(y * RAD);
  const cz = Math.cos(z * RAD), sz = Math.sin(z * RAD);
  return [
    cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
    cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
    -sy, sx * cy, cx * cy,
  ];
}

/**
 * The skeleton: each bone's rest direction, length, own axes and which angles
 * a motion file gives for it; and which bone hangs from which.
 */
export function parseAsf(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let section = "";
  let unit = 1;
  const bones = new Map();
  const parent = new Map();
  let bone = null;
  let inHierarchy = false;
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith(":")) {
      section = line.split(/\s+/)[0].slice(1);
      continue;
    }
    const words = line.split(/\s+/);
    if (section === "units" && words[0] === "length") unit = Number(words[1]);
    else if (section === "bonedata") {
      if (words[0] === "begin") bone = { name: "", direction: [0, 0, 0], length: 0, axis: [0, 0, 0], dof: [] };
      else if (words[0] === "end") {
        bones.set(bone.name, bone);
        bone = null;
      } else if (bone) {
        if (words[0] === "name") bone.name = words[1];
        else if (words[0] === "direction") bone.direction = words.slice(1, 4).map(Number);
        else if (words[0] === "length") bone.length = Number(words[1]);
        else if (words[0] === "axis") bone.axis = words.slice(1, 4).map(Number);
        else if (words[0] === "dof") bone.dof = words.slice(1);
      }
    } else if (section === "hierarchy") {
      if (words[0] === "begin") inHierarchy = true;
      else if (words[0] === "end") inHierarchy = false;
      else if (inHierarchy) for (const child of words.slice(1)) parent.set(child, words[0]);
    }
  }
  // File units to metres.
  const scale = INCH / unit;
  // Parents before children, so one pass over the list places every joint.
  const order = [];
  const visit = (name) => {
    order.push(name);
    for (const [child, p] of parent) if (p === name) visit(child);
  };
  for (const [child, p] of parent) if (p === "root") visit(child);
  const list = order.map((name) => {
    const b = bones.get(name);
    const c = euler(b.axis[0], b.axis[1], b.axis[2]);
    return {
      name,
      parent: parent.get(name),
      offset: b.direction.map((d) => d * b.length * scale),
      length: b.length * scale,
      c,
      cInv: transpose(c),
      dof: b.dof,
    };
  });
  return { scale, bones: list };
}

/** The motion: for each frame, the numbers given for each bone. */
export function parseAmc(text) {
  const frames = [];
  let frame = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(":")) continue;
    if (/^\d+$/.test(line)) {
      frame = new Map();
      frames.push(frame);
      continue;
    }
    if (!frame) continue;
    const words = line.split(/\s+/);
    frame.set(words[0], words.slice(1).map(Number));
  }
  return frames;
}

/**
 * Where every joint is in one frame, in metres, in the recording's own axes
 * (y up; a person in the rest pose faces +z with their left at +x).
 * `root` is the pelvis; every other name is the far end of that bone, so
 * "lhumerus" is the left elbow and "lradius" the left wrist.
 */
export function jointsOf(skeleton, frame) {
  const root = frame.get("root");
  const out = { root: [root[0] * skeleton.scale, root[1] * skeleton.scale, root[2] * skeleton.scale] };
  const turn = { root: euler(root[3], root[4], root[5]) };
  for (const b of skeleton.bones) {
    const values = frame.get(b.name);
    let rx = 0, ry = 0, rz = 0;
    if (values) b.dof.forEach((d, i) => {
      if (d === "rx") rx = values[i];
      else if (d === "ry") ry = values[i];
      else if (d === "rz") rz = values[i];
    });
    const local = mul(mul(b.c, euler(rx, ry, rz)), b.cInv);
    const world = mul(turn[b.parent], local);
    turn[b.name] = world;
    const from = out[b.parent];
    const by = apply(world, b.offset);
    out[b.name] = [from[0] + by[0], from[1] + by[1], from[2] + by[2]];
  }
  // Which way the head and the pelvis face: their own +z.
  out.headFacing = apply(turn.head, [0, 0, 1]);
  out.rootFacing = apply(turn.root, [0, 0, 1]);
  return out;
}

/** One trial, read whole: `readTrial("13_17")` finds its skeleton by the number before the underscore. */
export function readTrial(name, dir = SOURCE_DIR) {
  const subject = name.split("_")[0];
  const skeleton = parseAsf(readFileSync(join(dir, `${subject}.asf`), "utf8"));
  const frames = parseAmc(readFileSync(join(dir, `${name}.amc`), "utf8"));
  return { name, skeleton, frames: frames.map((f) => jointsOf(skeleton, f)) };
}

/**
 * The check on the reader: the greatest change in any bone's length over a
 * trial, as a share of that length. A correct reader gives almost nothing.
 */
export function boneLengthSpread(trial) {
  let worst = 0;
  for (const b of trial.skeleton.bones) {
    if (b.length < 1e-6) continue;
    let low = Infinity, high = -Infinity;
    for (const f of trial.frames) {
      const a = f[b.parent], c = f[b.name];
      const d = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      low = Math.min(low, d);
      high = Math.max(high, d);
    }
    worst = Math.max(worst, (high - low) / b.length, Math.abs(high - b.length) / b.length);
  }
  return worst;
}

/** The trials that were downloaded. */
export const TRIALS = ["13_17", "13_18", "14_01", "14_02", "14_03", "15_13", "17_10"];
