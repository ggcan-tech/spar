import * as T from "three";
import { twoBone } from "../pov/body";
import type { Vec3 } from "../pov/physics";
import type { AttackKind } from "./boxer";
import type { BoxView } from "./game";
import {
  DISTANCE,
  foePose,
  foeToWorld,
  headForFoe,
  meToWorld,
} from "./opponentPose";
import type { Hand, PunchShape } from "./punch";
import { CONTACT_S, hitKick, reactionOf } from "./reaction";

/**
 * The ring in first person: the opponent at arm's length and a bit, the
 * player's own gloves at the bottom of the view, and what a hit looks like.
 * A prototype mannequin, lit and built to be read from across a room.
 */
export const BOX_FOV = 64;
/**
 * The view is tipped so the top of the opponent's head sits this far under
 * the top edge, as a share of the picture's height. Standing at its distance
 * that shows it head to feet, with the canvas between: how much of its legs
 * is in the picture is how near it is, which is the only way range can be
 * seen on a flat screen. The tip is kept between these limits, radians.
 */
const HEAD_ROOM = 0.12,
  PITCH = { most: -0.384, least: 0.14, easeS: 0.12 },
  /** Looking down at a floored opponent: this much, whatever the view was doing. */
  LOOK_DOWN = -0.6;
/** Own glove: out to the target, a held instant, back. Milliseconds. */
const PUNCH_OUT = CONTACT_S * 1000,
  PUNCH_HOLD = 70,
  PUNCH_BACK = 170;
/**
 * The lit glove's colour says what answers the punch: move the head for a
 * straight one, get under a hook, block a body shot. A second way to read it,
 * never the only one.
 */
const ANSWER: Record<AttackKind, string> = {
  jab: "#ffe9a8",
  cross: "#ffe9a8",
  hook: "#7ad0ff",
  body: "#9dff8a",
};

export function createBoxScene(canvas: HTMLCanvasElement) {
  const renderer = new T.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new T.Scene();
  scene.background = new T.Color("#080c12");
  scene.fog = new T.Fog("#080c12", 7, 22);
  const camera = new T.PerspectiveCamera(BOX_FOV, 1, 0.03, 60);
  camera.rotation.order = "YXZ";
  scene.add(new T.HemisphereLight("#d5e8ff", "#20160f", 0.85));
  const key = new T.DirectionalLight("#fff1d8", 2.8);
  key.position.set(1.4, 5.5, 1.6);
  key.target.position.set(0, 1.1, -DISTANCE);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 3;
  key.shadow.camera.bottom = -3;
  scene.add(key, key.target);
  const rim = new T.PointLight("#6fe3e0", 14, 9);
  rim.position.set(-2.2, 2.6, -DISTANCE - 2);
  const warm = new T.PointLight("#ff9c62", 10, 9);
  warm.position.set(2.4, 2.4, -DISTANCE - 1.6);
  scene.add(rim, warm);

  const materials: T.Material[] = [];
  const geometries: T.BufferGeometry[] = [];
  const mat = (color: string, roughness = 0.6, metalness = 0.05) => {
    const m = new T.MeshStandardMaterial({ color, roughness, metalness });
    materials.push(m);
    return m;
  };
  const keep = <G extends T.BufferGeometry>(g: G) => {
    geometries.push(g);
    return g;
  };
  const centre = -DISTANCE / 2;
  const add = (mesh: T.Mesh, cast = true, receive = false) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    scene.add(mesh);
    return mesh;
  };
  // ── The ring ─────────────────────────────────────────────────────────────
  const canvasMat = mat("#c9d2d8", 0.95);
  const floor = add(new T.Mesh(keep(new T.BoxGeometry(6.6, 0.3, 6.6)), canvasMat), false, true);
  floor.position.set(0, -0.15, centre);
  const apron = add(new T.Mesh(keep(new T.BoxGeometry(7.4, 0.28, 7.4)), mat("#12202b", 0.9)), false, true);
  apron.position.set(0, -0.17, centre);
  const mark = add(
    new T.Mesh(
      keep(new T.RingGeometry(0.95, 1.02, 48)),
      new T.MeshBasicMaterial({ color: "#8fa3b0", transparent: true, opacity: 0.55 }),
    ),
    false,
  );
  materials.push(mark.material as T.Material);
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(0, 0.004, centre);
  // Seams across the canvas every half metre: with the opponent's feet they
  // give the eye a ruler for how far away it stands.
  const seamMat = new T.MeshBasicMaterial({ color: "#5d6b75", transparent: true, opacity: 0.32 });
  materials.push(seamMat);
  const seamGeo = keep(new T.PlaneGeometry(6.2, 0.014));
  for (let z = -0.5; z >= -4.6; z -= 0.5) {
    const seam = add(new T.Mesh(seamGeo, seamMat), false);
    seam.rotation.x = -Math.PI / 2;
    seam.position.set(0, 0.003, z);
  }
  // A soft dark patch under each of its feet: where it stands, even when the light's shadow is faint.
  const blobMat = new T.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.34, depthWrite: false });
  materials.push(blobMat);
  const blobGeo = keep(new T.CircleGeometry(0.13, 20));
  const blobs = [0, 1].map(() => {
    const blob = add(new T.Mesh(blobGeo, blobMat), false);
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = 1;
    return blob;
  });
  const postGeo = keep(new T.CylinderGeometry(0.07, 0.07, 1.55, 12));
  const ropeGeo = keep(new T.CylinderGeometry(0.022, 0.022, 6.2, 8));
  const corners = [
    [-3.1, -3.1, "#d7263d"],
    [3.1, -3.1, "#2f7fd8"],
    [-3.1, 3.1, "#e8e4da"],
    [3.1, 3.1, "#e8e4da"],
  ] as const;
  for (const [x, z, color] of corners) {
    const post = add(new T.Mesh(postGeo, mat(color, 0.5)));
    post.position.set(x, 0.775, centre + z);
  }
  const ropeMats = [mat("#e8e4da", 0.6), mat("#d7263d", 0.6), mat("#e8e4da", 0.6)];
  // The ropes behind the opponent: they shake when it goes down.
  const farRopes: { mesh: T.Mesh; y: number }[] = [];
  [0.5, 0.9, 1.3].forEach((y, i) => {
    for (const [x, z, turn] of [
      [0, -3.1, true],
      [0, 3.1, true],
      [-3.1, 0, false],
      [3.1, 0, false],
    ] as const) {
      const rope = add(new T.Mesh(ropeGeo, ropeMats[i]), false);
      rope.position.set(x, y, centre + z);
      rope.rotation.set(turn ? 0 : Math.PI / 2, 0, turn ? Math.PI / 2 : 0);
      if (turn && z < 0) farRopes.push({ mesh: rope, y });
    }
  });
  // The hall beyond the ropes: dark, with points of light where a crowd would be.
  const lights = new Float32Array(360 * 3);
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 360; i++) {
    const angle = random() * Math.PI * 2,
      radius = 7 + random() * 6;
    lights[i * 3] = Math.cos(angle) * radius;
    lights[i * 3 + 1] = 0.8 + random() * 4.5;
    lights[i * 3 + 2] = centre + Math.sin(angle) * radius;
  }
  const hallGeo = keep(new T.BufferGeometry());
  hallGeo.setAttribute("position", new T.BufferAttribute(lights, 3));
  const hallMat = new T.PointsMaterial({
    color: "#ffd9a8",
    size: 0.09,
    transparent: true,
    opacity: 0.55,
    fog: false,
  });
  materials.push(hallMat);
  scene.add(new T.Points(hallGeo, hallMat));
  const rig = add(new T.Mesh(keep(new T.BoxGeometry(3.2, 0.12, 3.2)), new T.MeshBasicMaterial({ color: "#fff6e6" })), false);
  materials.push(rig.material as T.Material);
  rig.position.set(0, 5.6, centre);

  // ── Parts ────────────────────────────────────────────────────────────────
  const sphereGeo = keep(new T.SphereGeometry(1, 24, 16));
  const tubeGeo = keep(new T.CylinderGeometry(0.8, 1, 1, 12));
  const up = new T.Vector3(0, 1, 0);
  const vec = (p: Vec3) => new T.Vector3(p.x, p.y, p.z);
  const ball = (m: T.Material, x: number, y = x, z = x) => {
    const mesh = add(new T.Mesh(sphereGeo, m));
    mesh.scale.set(x, y, z);
    return mesh;
  };
  const tube = (m: T.Material) => add(new T.Mesh(tubeGeo, m));
  /** A tube from `a` (the wide end) to `b`. */
  const link = (mesh: T.Mesh, a: T.Vector3, b: T.Vector3, r: number) => {
    const d = b.clone().sub(a);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(r, Math.max(0.001, d.length()), r);
    mesh.quaternion.setFromUnitVectors(up, d.normalize());
  };
  /**
   * A skin stretched over elliptical rings, redrawn every frame: the trunk is
   * wide and shallow like a chest, not a can, and a turn of the shoulders shows
   * as the wide chest going narrow. Each ring has its centre, the spine's
   * direction there, which way is across the body, and its two half-sizes.
   */
  interface Ring {
    c: T.Vector3;
    d: T.Vector3;
    a: T.Vector3;
    rx: number;
    rz: number;
  }
  const SEG = 14;
  const loft = (material: T.Material, count: number, cap: boolean) => {
    const position = new Float32Array((count * SEG + (cap ? 1 : 0)) * 3);
    const index: number[] = [];
    for (let r = 0; r < count - 1; r++)
      for (let k = 0; k < SEG; k++) {
        const a = r * SEG + k,
          b = r * SEG + ((k + 1) % SEG);
        index.push(a, b, a + SEG, b, b + SEG, a + SEG);
      }
    if (cap) {
      const top = (count - 1) * SEG;
      for (let k = 0; k < SEG; k++) index.push(top + k, top + ((k + 1) % SEG), count * SEG);
    }
    const geometry = keep(new T.BufferGeometry());
    const attribute = new T.BufferAttribute(position, 3);
    attribute.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute("position", attribute);
    geometry.setIndex(index);
    const mesh = add(new T.Mesh(geometry, material));
    mesh.frustumCulled = false;
    const front = new T.Vector3();
    return {
      mesh,
      /** `rise` lifts the middle of the cap along the spine. */
      set(rings: Ring[], rise = 0) {
        rings.forEach((ring, r) => {
          front.crossVectors(ring.d, ring.a);
          for (let k = 0; k < SEG; k++) {
            const angle = (k / SEG) * Math.PI * 2;
            const x = Math.cos(angle) * ring.rx,
              z = Math.sin(angle) * ring.rz;
            position.set(
              [ring.c.x + ring.a.x * x + front.x * z, ring.c.y + ring.a.y * x + front.y * z, ring.c.z + ring.a.z * x + front.z * z],
              (r * SEG + k) * 3,
            );
          }
        });
        if (cap) {
          const last = rings[rings.length - 1];
          position.set([last.c.x + last.d.x * rise, last.c.y + last.d.y * rise, last.c.z + last.d.z * rise], count * SEG * 3);
        }
        attribute.needsUpdate = true;
        geometry.computeVertexNormals();
      },
    };
  };
  // Cold, dark trunks: on this figure red means gloves, and only gloves light up.
  const skin = mat("#c8906f", 0.7),
    trunks = mat("#1c2a4a", 0.6),
    dark = mat("#151b21", 0.7),
    white = mat("#f1ede4", 0.5);
  const flashable = [skin, trunks];
  // A soft disc of light behind the glove that is about to punch: seen even
  // when the glove itself is half behind a shoulder.
  const haloCanvas = document.createElement("canvas");
  haloCanvas.width = haloCanvas.height = 64;
  const haloContext = haloCanvas.getContext("2d");
  if (haloContext) {
    const fade = haloContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    fade.addColorStop(0, "rgba(255,255,255,1)");
    fade.addColorStop(0.35, "rgba(255,255,255,0.55)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    haloContext.fillStyle = fade;
    haloContext.fillRect(0, 0, 64, 64);
  }
  const haloTexture = new T.CanvasTexture(haloCanvas);
  const haloMat = new T.SpriteMaterial({
    map: haloTexture,
    blending: T.AdditiveBlending,
    transparent: true,
    opacity: 0,
    depthTest: false,
    fog: false,
  });
  materials.push(haloMat);
  const halo = new T.Sprite(haloMat);
  halo.renderOrder = 7;
  scene.add(halo);
  // Sweat off a landed punch.
  const DROPS = 40;
  const dropAt = new Float32Array(DROPS * 3).fill(-99);
  const dropGo = new Float32Array(DROPS * 3);
  const dropLife = new Float32Array(DROPS);
  const dropGeo = keep(new T.BufferGeometry());
  dropGeo.setAttribute("position", new T.BufferAttribute(dropAt, 3));
  const dropMat = new T.PointsMaterial({
    color: "#e9f6ff",
    size: 0.018,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  materials.push(dropMat);
  const drops = new T.Points(dropGeo, dropMat);
  drops.frustumCulled = false;
  scene.add(drops);
  let dropNext = 0;
  // The opponent's gloves light up as a punch is shown, so each has its own material.
  const gloveMats = [mat("#d7263d", 0.35), mat("#d7263d", 0.35)];
  const foe = {
    head: new T.Group(),
    neck: tube(skin),
    // Hips, waist and shoulders; then the shorts and their white band over the hips.
    trunk: loft(skin, 3, true),
    belt: loft(trunks, 2, false),
    band: loft(white, 2, false),
    arms: [0, 1].map((i) => ({
      shoulder: ball(skin, 0.085, 0.07, 0.08),
      upper: tube(skin),
      elbow: ball(skin, 0.05),
      fore: tube(skin),
      cuff: tube(white),
      glove: ball(gloveMats[i], 0.098, 0.108, 0.125),
    })),
    legs: [0, 1].map(() => ({ thigh: tube(trunks), shin: tube(skin), foot: ball(dark, 0.06, 0.045, 0.12) })),
  };
  {
    const skull = new T.Mesh(sphereGeo, skin);
    skull.scale.set(0.105, 0.128, 0.115);
    skull.castShadow = true;
    const hair = new T.Mesh(sphereGeo, dark);
    hair.scale.set(0.108, 0.075, 0.118);
    hair.position.set(0, 0.07, -0.012);
    const brow = new T.Mesh(keep(new T.BoxGeometry(0.13, 0.014, 0.02)), dark);
    brow.position.set(0, 0.04, 0.103);
    const eyes = [-1, 1].map((side) => {
      const eye = new T.Mesh(sphereGeo, dark);
      eye.scale.setScalar(0.013);
      eye.position.set(side * 0.04, 0.012, 0.108);
      return eye;
    });
    const nose = new T.Mesh(sphereGeo, skin);
    nose.scale.set(0.016, 0.03, 0.02);
    nose.position.set(0, -0.015, 0.118);
    const mouth = new T.Mesh(keep(new T.BoxGeometry(0.05, 0.008, 0.01)), dark);
    mouth.position.set(0, -0.062, 0.1);
    foe.head.add(skull, hair, brow, ...eyes, nose, mouth);
    scene.add(foe.head);
  }
  // The player's own gloves and sleeves.
  const sleeve = mat("#123a44", 0.7);
  const mine = [0, 1].map(() => {
    // Each glove has its own material: it dulls as breath runs out, and its
    // cuff lights when that glove's block is being counted.
    const gloveMat = mat("#35c9c2", 0.35),
      cuffMat = mat("#f1ede4", 0.5);
    return {
      gloveMat,
      cuffMat,
      glove: ball(gloveMat, 0.088, 0.098, 0.115),
      cuff: tube(cuffMat),
      fore: tube(sleeve),
      upper: tube(sleeve),
      at: new T.Vector3(),
      placed: false,
      punch: null as null | { at: number; to: T.Vector3; shape: PunchShape },
    };
  });
  for (const m of mine)
    for (const part of [m.glove, m.cuff, m.fore, m.upper]) part.castShadow = false;
  const full = new T.Color("#35c9c2"),
    spent = new T.Color("#5a7f86");
  // Where a punch lands: a ring that opens, and a flash of light.
  const burstGeo = keep(new T.RingGeometry(0.7, 1, 28));
  const bursts = [0, 1, 2, 3].map(() => {
    const material = new T.MeshBasicMaterial({
      color: "#fff3c4",
      transparent: true,
      opacity: 0,
      depthTest: false,
      side: T.DoubleSide,
      blending: T.AdditiveBlending,
      fog: false,
    });
    materials.push(material);
    const mesh = new T.Mesh(burstGeo, material);
    mesh.renderOrder = 8;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, at: -Infinity, size: 0.2 };
  });
  const spark = new T.PointLight("#fff0c0", 0, 3);
  scene.add(spark);
  let burstNext = 0;
  let flashAt = -Infinity,
    shakeAt = -Infinity,
    shake = 0,
    pushAt = -Infinity,
    push = 0;
  let kick: { at: number; kind: AttackKind; side: number; damage: number } | null = null;
  /** What a punch did, drawn when the glove gets there rather than when it was read. */
  const due: {
    at: number;
    blocked: boolean;
    hand: Hand;
    shape: PunchShape;
    target: "head" | "body";
    power: number;
    counter: boolean;
  }[] = [];
  let lookDown = 0;
  /** How far the view is tipped, radians; eased toward what keeps its head just under the top edge. */
  let pitch = -0.3;
  /** The player on the canvas, eased: a knockdown, and the knockout that ends it. */
  let myFall = 0;
  /** When the opponent last went down: the ropes shake and the hall flares. */
  let floorAt = -Infinity;
  /** When the fight was first seen to be over: the rules' clock stops there, the knocked-out opponent's fall does not. */
  let endedAt = -1;
  /** The moment a punch fixed its aim: the lit glove flares once. */
  let aimedId = -1,
    aimAt = -Infinity;
  let width = 0,
    height = 0;
  const eye = new T.Vector3(0, 1.65, 0);
  let lastNow = -Infinity;

  function render(view: BoxView, now: number) {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (w !== width || h !== height) {
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      // On a screen held upright the view is widened until a hook drawn back
      // out wide is still inside it: the width a laptop shows is kept.
      camera.fov = Math.min(
        95,
        (2 * Math.atan(Math.tan((BOX_FOV * Math.PI) / 360) * Math.max(1, 1.3 / camera.aspect)) * 180) / Math.PI,
      );
    }
    const dt = Math.max(0, Math.min(0.1, (now - lastNow) / 1000));
    lastNow = now;
    const fight = view.fight;
    // ── The opponent's pose ───────────────────────────────────────────────
    const foeState = fight.foe;
    // A knockout ends the fight and stops its clock on the punch that did it.
    // The fall is drawn on from there, slow at first as any knockdown is.
    if (!fight.over) endedAt = -1;
    else if (endedAt < 0) endedAt = now;
    const since0 = fight.over && foeState.phase === "out" ? (now - endedAt) / 1000 : 0;
    const x0 = Math.min(1, since0 / 1.1);
    const time =
      fight.time + (since0 < 1.1 ? 0.2 * since0 + 0.88 * (x0 ** 3 - x0 ** 4 / 2) : 0.66 + since0 - 1.1);
    const incoming = foeState.attack;
    const blocking =
      incoming !== null &&
      (incoming.kind === "body" ? view.guard.low > 0 : view.guard.high > 0);
    // Aimed at where the lens is, not at where the head is measured.
    const pose = foePose(
      foeState,
      time,
      time + view.lead,
      headForFoe({ ...view.head, z: view.head.z * 0.5 }),
      blocking,
    );
    // A punch that fixes its aim part-way through its showing marks the moment.
    const aimed = incoming && !incoming.feint && incoming.aim !== null && incoming.aimAfter > 0.05 ? incoming.id : -1;
    if (aimed !== aimedId) {
      if (aimed >= 0) aimAt = now;
      aimedId = aimed;
    }
    // The finishing punch is felt at twice the size.
    const floored0 = foeState.phase === "down" || foeState.phase === "out";
    const struckNow = foeState.struck && floored0 ? { ...foeState.struck, damage: foeState.struck.damage * 2 } : foeState.struck;
    const react = reactionOf(struckNow, time);
    // Offsets in its own frame, to the ring's: sideways is mirrored.
    const moved = (p: Vec3, by: Vec3, k = 1) =>
      vec(foeToWorld({ x: p.x + by.x * k, y: p.y + by.y * k, z: p.z + by.z * k }));
    // A punch taken on its guard rocks the gloves back toward its face and apart.
    const rock = foeState.guarded
      ? (() => {
          const t = fight.time - foeState.guarded.at - CONTACT_S;
          return t > 0 && t < 0.3 ? (t / 0.05) * Math.exp(1 - t / 0.05) : 0;
        })()
      : 0;
    const world = {
      head: moved(pose.head, react.head),
      chest: moved(pose.chest, react.chest),
      hips: vec(foeToWorld(pose.hips)),
      shoulders: pose.shoulders.map((p) => moved(p, react.chest)),
      gloves: pose.gloves.map((p, i) =>
        moved(p, { x: (i ? 1 : -1) * 0.03 * rock, y: -react.gloves, z: -0.06 * rock }),
      ),
    };
    // ── Events ────────────────────────────────────────────────────────────
    for (const e of view.events) {
      if (e.kind === "landed" || e.kind === "blocked")
        due.push({
          at: now + PUNCH_OUT,
          blocked: e.kind === "blocked",
          hand: e.hand,
          shape: e.shape,
          target: e.target,
          power: e.kind === "landed" ? e.power : 1,
          counter: e.kind === "landed" && e.counter,
        });
      if (e.kind === "blocked") {
        // The glove stops on its guard, short of the face.
        const m = mine[e.hand === "left" ? 0 : 1];
        if (m.punch) {
          m.punch.to.copy(world.gloves[e.hand === "left" ? 1 : 0]);
          m.punch.to.z += 0.17;
        }
      } else if (e.kind === "hit-me") {
        // The opponent's left hand arrives on the player's right.
        kick = { at: now, kind: e.attack, side: e.hand === "left" ? 1 : -1, damage: e.damage };
      } else if (e.kind === "blocked-me") {
        shakeAt = now;
        shake = 0.01;
      } else if (e.kind === "foe-down") floorAt = now;
    }
    // The ring answers a knockdown: the far ropes shake and the hall flares.
    const since = (now - floorAt) / 1000;
    const shook = since >= 0 && since < 1.5 ? 0.02 * Math.sin(40 * since) * Math.exp(-4 * since) : 0;
    for (const rope of farRopes) rope.mesh.position.y = rope.y + shook;
    const flare = since >= 0 && since < 2 ? Math.exp(-3 * since) : 0;
    hallMat.opacity = 0.55 + 0.45 * flare;
    hallMat.size = 0.09 * (1 + 0.8 * flare);
    while (due.length && due[0].at <= now) {
      const e = due.shift()!;
      const at = e.blocked
        ? world.gloves[e.hand === "left" ? 1 : 0].clone()
        : e.target === "head"
          ? world.head.clone()
          : world.hips.clone().lerp(world.chest, 0.45);
      at.z += 0.1;
      const burst = bursts[burstNext++ % bursts.length];
      burst.mesh.position.copy(at);
      burst.at = now;
      burst.size = e.blocked ? 0.12 : 0.16 + 0.3 * (e.power - 0.85) + (e.counter ? 0.14 : 0);
      burst.mesh.material.color.set(e.blocked ? "#cfe6ff" : e.counter ? "#ffd36b" : "#fff3c4");
      if (!e.blocked) {
        flashAt = now;
        shakeAt = now;
        shake = 0.004 + 0.012 * (e.power - 0.85) + (e.counter ? 0.006 : 0);
        pushAt = now;
        push = 0.03 + 0.13 * (e.power - 0.85) + (e.counter ? 0.02 : 0);
        spark.position.copy(at);
        // Sweat flies the way the punch was going.
        const along = e.shape === "hook" ? (e.hand === "left" ? 1 : -1) : 0;
        for (let i = 0; i < 10; i++) {
          const d = dropNext++ % DROPS;
          dropAt.set([at.x, at.y, at.z], d * 3);
          dropGo.set(
            [along * (1.5 + random() * 2) + (random() - 0.5) * 1.6, 0.8 + random() * 1.6, -(1 + random() * 2.2) * (along ? 0.3 : 1)],
            d * 3,
          );
          dropLife[d] = 0.3;
        }
      }
    }
    // ── The view ──────────────────────────────────────────────────────────
    const target = meToWorld({ x: view.head.x, y: view.head.y, z: view.head.z * 0.5 });
    const ease = 1 - Math.exp(-dt / 0.025);
    eye.x += (target.x - eye.x) * ease;
    eye.y += (target.y - eye.y) * ease;
    eye.z += (target.z - eye.z) * ease;
    camera.position.copy(eye);
    // Tip the view so the top of its head sits just under the top edge.
    {
      const top = world.head.y + 0.13;
      const away = Math.max(0.3, Math.hypot(world.head.x - eye.x, world.head.z - eye.z));
      const up = Math.atan2(top - eye.y, away);
      const half = (camera.fov * Math.PI) / 360;
      const want = up - Math.atan((1 - 2 * HEAD_ROOM) * Math.tan(half));
      const to = Math.max(PITCH.most, Math.min(PITCH.least, want));
      pitch += (to - pitch) * (1 - Math.exp(-dt / PITCH.easeS));
    }
    camera.rotation.set(pitch, 0, 0);
    // Being hit moves the view by the kind of punch, its weight and its side.
    if (kick) {
      const k = hitKick(kick.kind, kick.side, kick.damage, now - kick.at);
      camera.position.z += k.back;
      camera.position.x += k.across;
      camera.position.y -= k.down;
      camera.rotation.x += k.pitch;
      camera.rotation.y += k.yaw;
      camera.rotation.z = k.roll;
    }
    // Landing one carries the view a little way into it.
    const into = Math.max(0, 1 - (now - pushAt) / 140);
    if (into > 0) camera.position.z -= push * into * into;
    const rattle = Math.max(0, 1 - (now - shakeAt) / 130) * shake;
    if (rattle > 0) {
      camera.position.x += Math.sin(now * 0.9) * rattle;
      camera.position.y += Math.cos(now * 1.3) * rattle;
    }
    // The opponent down: look at it. Eased, and held while it lies there.
    const floored = fight.foe.phase === "down" || fight.foe.phase === "out";
    lookDown += ((floored ? 1 : 0) - lookDown) * (1 - Math.exp(-dt / (floored ? 0.16 : 0.2)));
    if (lookDown > 0.002) {
      camera.rotation.x += (LOOK_DOWN - pitch) * lookDown;
      camera.position.y += 0.05 * lookDown;
    }
    // A knocked-down player sees the lights, and so does one who is counted out.
    const lyingMe = fight.me.down || (fight.over?.winner === 1 && fight.over.how === "ko");
    myFall += ((lyingMe ? 1 : 0) - myFall) * (1 - Math.exp(-dt / 0.16));
    if (myFall > 0.002) {
      camera.position.y -= 0.9 * myFall;
      camera.rotation.x += 0.75 * myFall;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    // ── The opponent ──────────────────────────────────────────────────────
    const flash = Math.max(0, 1 - (now - flashAt) / 110);
    // Made to miss, it glows gold for as long as it is open: hit it now.
    const gold = pose.open * (0.28 + 0.1 * Math.sin(now / 60));
    for (const m of flashable) {
      m.emissive.set(flash > 0.05 ? "#ffffff" : "#ffc63d");
      m.emissiveIntensity = Math.max(0.9 * flash, flash > 0.05 ? 0 : gold);
    }
    spark.intensity = 9 * flash;
    foe.head.position.copy(world.head);
    // It watches the player, tipping back as it goes down; a punch turns its head.
    const face = new T.Vector3(eye.x, world.head.y + (eye.y - world.head.y) * 0.4, eye.z);
    // Turned gradually toward the lights as it falls, not switched.
    foe.head.lookAt(face.lerp(new T.Vector3(world.head.x, 6, world.head.z + 0.5), pose.fallen));
    foe.head.rotateY(react.yaw);
    foe.head.rotateX(-react.pitch);
    foe.head.rotateZ(react.roll);
    const neckBase = world.chest.clone().lerp(world.head, 0.35);
    link(foe.neck, neckBase, world.head, 0.058);
    // The trunk: the hips turn a third as far as the shoulders, the waist two thirds.
    const spine = world.chest.clone().sub(world.hips).normalize();
    const shouldersAcross = world.shoulders[1].clone().sub(world.shoulders[0]).normalize();
    const ring = (at: number, twist: number, rx: number, rz: number): Ring => {
      // Its right is the ring's -x; kept square to the spine.
      const a = new T.Vector3(-1, 0, 0).lerp(shouldersAcross, twist);
      a.addScaledVector(spine, -a.dot(spine)).normalize();
      return { c: world.hips.clone().addScaledVector(spine, at), d: spine, a, rx, rz };
    };
    const chestAt = world.chest.distanceTo(world.hips);
    foe.trunk.set(
      [ring(0, 0.3, 0.16, 0.11), ring(chestAt * 0.48, 0.65, 0.15, 0.1), ring(chestAt + 0.03, 1, 0.21, 0.115)],
      0.05,
    );
    foe.belt.set([ring(-0.13, 0.15, 0.172, 0.125), ring(0.09, 0.3, 0.168, 0.118)]);
    foe.band.set([ring(0.085, 0.3, 0.172, 0.122), ring(0.125, 0.35, 0.169, 0.119)]);
    foe.arms.forEach((arm, i) => {
      // World x is mirrored from the opponent's own, so its left arm bends toward world +x.
      const side = i === 0 ? 1 : -1;
      const shoulder = world.shoulders[i],
        glove = world.gloves[i];
      const wrist = glove.clone().lerp(shoulder, 0.1);
      // Which way the elbow goes is part of the pose: it says which punch.
      const pole = pose.poles[i];
      const bend = twoBone(shoulder, wrist, 0.3, 0.28, { x: -pole.x, y: pole.y, z: pole.z });
      void side;
      const elbow = vec(bend);
      arm.shoulder.position.copy(shoulder);
      link(arm.upper, shoulder, elbow, 0.062);
      arm.elbow.position.copy(elbow);
      link(arm.fore, elbow, wrist, 0.052);
      link(arm.cuff, wrist.clone().lerp(elbow, 0.22), wrist, 0.06);
      arm.glove.position.copy(glove);
      arm.glove.quaternion.setFromUnitVectors(
        new T.Vector3(0, 0, 1),
        glove.clone().sub(elbow).normalize(),
      );
      // The glove that is about to punch heats toward white as it is drawn
      // back, steady once thrown, with a soft light behind it.
      const loaded = pose.loading?.glove === i ? pose.loading : null;
      const heat = loaded ? loaded.amount : 0;
      gloveMats[i].emissive.set(loaded ? ANSWER[loaded.kind] : "#000000");
      gloveMats[i].emissiveIntensity =
        heat * (0.4 + 1.2 * heat) * (loaded?.thrown ? 1 : 0.85 + 0.15 * Math.sin(now / 45));
      arm.glove.scale.set(0.098, 0.108, 0.125).multiplyScalar(1 + 0.3 * heat);
      if (loaded) {
        // The instant its aim is fixed the light flares once: from here, moving makes it miss.
        const lock = Math.max(0, 1 - (now - aimAt) / 140);
        halo.position.copy(glove);
        halo.scale.setScalar(0.5 * (0.6 + 0.4 * heat) * (1 + 0.9 * lock));
        haloMat.color.set(ANSWER[loaded.kind]);
        haloMat.opacity = Math.min(1, 0.75 * heat + 0.5 * lock);
      }
    });
    if (!pose.loading) haloMat.opacity = Math.max(0, haloMat.opacity - dt / 0.06);
    foe.legs.forEach((leg, i) => {
      const side = i === 0 ? 1 : -1;
      const hip = world.hips.clone().add(new T.Vector3(side * 0.1, -0.04, 0));
      // The feet go with a lunge, the front one most: the legs do not stretch.
      const foot = vec(
        foeToWorld({ x: -side * 0.15, y: 0.05, z: 0.02 + (i ? 0.08 : -0.08) + pose.lunge * (i ? 0.8 : 0.3) }),
      );
      if (pose.fallen > 0) foot.lerp(new T.Vector3(side * 0.2, 0.06, -DISTANCE + 0.42), pose.fallen);
      // Standing, the knees bend toward the player; lying, they bend up.
      const knee = vec(
        twoBone(hip, foot, 0.5, 0.48, { x: side * (0.1 + 0.2 * pose.fallen), y: pose.fallen, z: 1 - 0.8 * pose.fallen }),
      );
      link(leg.thigh, hip, knee, 0.095);
      link(leg.shin, knee, foot, 0.06);
      leg.foot.position.copy(foot);
      blobs[i].position.set(foot.x, 0.004, foot.z);
    });
    // ── The player's gloves ───────────────────────────────────────────────
    for (const p of view.punches) {
      const chin = world.head.clone();
      chin.y -= 0.07;
      const to = (
        p.target === "body" ? world.hips.clone().lerp(world.chest, 0.45) : p.shape === "uppercut" ? chin : world.head.clone()
      ).clone();
      to.z += 0.13;
      mine[p.hand === "left" ? 0 : 1].punch = { at: now, to, shape: p.shape };
    }
    const breath = Math.max(0, Math.min(1, view.breath));
    mine.forEach((m, i) => {
      const side = i === 0 ? -1 : 1;
      const hand = view.hands[i];
      // The real guard is under the chin, below what a screen can show: the
      // gloves are drawn up into the bottom of the view, and move from there.
      const rel = hand
        ? { x: hand.x - view.head.x, y: hand.y - view.head.y, z: hand.z - view.head.z }
        : { x: side * 0.2, y: -0.75, z: 0.1 };
      // Out of breath, the gloves sag and tremble.
      const tired = breath < 0.2 ? 1 - breath / 0.2 : 0;
      const home = new T.Vector3(
        rel.x * 1.9,
        // A low block stays in the picture.
        Math.max(-0.27, rel.y * 0.9 - 0.07) - 0.04 * tired + 0.003 * tired * Math.sin(now / 26),
        -(0.44 + Math.max(0, rel.z) * 0.8),
      ).applyMatrix4(camera.matrixWorld);
      if (!m.placed) {
        m.at.copy(home);
        m.placed = true;
      } else m.at.lerp(home, 1 - Math.exp(-dt / 0.03));
      const shown = m.at.clone();
      let out = 0,
        squash = 0;
      if (m.punch) {
        const t = now - m.punch.at;
        out =
          t < PUNCH_OUT
            ? 1 - (1 - t / PUNCH_OUT) ** 2
            : t < PUNCH_OUT + PUNCH_HOLD
              ? 1
              : Math.max(0, 1 - (t - PUNCH_OUT - PUNCH_HOLD) / PUNCH_BACK);
        if (t >= PUNCH_OUT + PUNCH_HOLD + PUNCH_BACK) m.punch = null;
        else {
          shown.lerp(m.punch.to, out);
          // A hook comes round from the side; an uppercut comes up from below.
          const arc = Math.sin(Math.PI * Math.min(1, out)) * (1 - out * 0.5);
          if (m.punch.shape === "hook") shown.x += side * 0.22 * arc;
          else if (m.punch.shape === "uppercut") shown.y -= 0.16 * arc;
          // Flattened against what it hits, for an instant.
          squash = t >= PUNCH_OUT && t < PUNCH_OUT + 40 ? 1 : 0;
        }
      }
      // The arm comes from a shoulder just below the picture. At rest it is two
      // bones, the forearm rising from the bottom edge; thrown, it is one line
      // from the shoulder to the glove, and the shoulder goes with it.
      const anchor = new T.Vector3(side * 0.24, -0.4, 0.05 - 0.35 * out).applyMatrix4(camera.matrixWorld);
      const wrist = shown.clone().lerp(anchor, 0.12);
      const elbow = vec(
        twoBone(anchor, wrist, 0.3, 0.3, new T.Vector3(side * 0.6, -1, 0.3).transformDirection(camera.matrixWorld)),
      ).lerp(anchor.clone().lerp(wrist, 0.5), out);
      m.glove.position.copy(shown);
      m.glove.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), shown.clone().sub(elbow).normalize());
      m.glove.scale
        .set(0.078, 0.088, 0.105)
        .multiplyScalar(1 + 0.3 * out)
        .multiply(new T.Vector3(1 + 0.25 * squash, 1 + 0.25 * squash, 1 - 0.3 * squash));
      link(m.cuff, wrist.clone().lerp(elbow, 0.25), wrist, 0.055);
      link(m.fore, elbow, wrist.clone().lerp(elbow, 0.25), 0.05);
      link(m.upper, anchor, elbow, 0.058);
      // Breath shows on the gloves; a glove whose block is counted lights at the cuff.
      m.gloveMat.color.copy(full).lerp(spent, 1 - breath);
      const counted =
        !m.punch && (view.guard.high > (i === 0 ? 0 : view.guard.high > 1 ? 0 : 1) || view.guard.low > (i === 0 ? 0 : view.guard.low > 1 ? 0 : 1));
      m.cuffMat.emissive.set("#dffcff");
      m.cuffMat.emissiveIntensity = counted ? 0.7 : 0;
      const visible = hand !== null || m.punch !== null;
      // Out of the way while either of them is on the canvas.
      for (const part of [m.glove, m.cuff, m.fore, m.upper])
        part.visible = visible && myFall < 0.3 && lookDown < 0.3;
    });
    // ── Sweat ─────────────────────────────────────────────────────────────
    for (let d = 0; d < DROPS; d++) {
      if (dropLife[d] <= 0) continue;
      dropLife[d] -= dt;
      if (dropLife[d] <= 0) {
        dropAt[d * 3 + 1] = -99;
        continue;
      }
      dropGo[d * 3 + 1] -= 9.8 * dt;
      for (let a = 0; a < 3; a++) dropAt[d * 3 + a] += dropGo[d * 3 + a] * dt;
    }
    (dropGeo.getAttribute("position") as T.BufferAttribute).needsUpdate = true;
    // ── Bursts ────────────────────────────────────────────────────────────
    for (const burst of bursts) {
      const age = (now - burst.at) / 200;
      if (age >= 1 || age < 0) {
        burst.mesh.visible = false;
        continue;
      }
      burst.mesh.visible = true;
      burst.mesh.quaternion.copy(camera.quaternion);
      burst.mesh.scale.setScalar(burst.size * (0.35 + 1.4 * Math.sqrt(age)));
      burst.mesh.material.opacity = 0.9 * (1 - age);
    }
    renderer.render(scene, camera);
  }

  return {
    render,
    setQuality(level: { pixelRatio: number; shadows: boolean }) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, level.pixelRatio));
      key.castShadow = level.shadows;
    },
    dispose() {
      haloTexture.dispose();
      for (const m of materials) m.dispose();
      for (const g of geometries) g.dispose();
      renderer.dispose();
      scene.clear();
    },
  };
}
