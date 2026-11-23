import * as T from "three";
import { twoBone } from "../../pov/body";
import type { Vec3 } from "../../pov/physics";
import { DISTANCE, meToWorld } from "../opponentPose";
import type { PunchShape } from "../punch";
import type { RealView } from "./game";
import type { Level, Third } from "./rules";

/**
 * The ring in first person for the real exchange. The same ring and the same
 * figure as the first build's scene, drawn by different rules:
 *
 * - Nothing on the opponent lights up or glows. Its body is the tell.
 * - The player's arms are their real arms: shoulder, elbow, wrist and glove
 *   where the body really has them (real/body3d.ts), at their true distance
 *   from the eye. A punch is not played: the glove goes out because the arm
 *   went out, and as far. Close to the face a glove is faint, and it goes
 *   see-through where it would hide the opponent: one eye cannot see round it.
 *   (With no body, as in the first build's way, the gloves are two points
 *   drawn a fixed way out in their direction from the eye.)
 * - A clean punch moves the opponent and throws sweat, and no more: no
 *   flash, no ring, no word. Being hit moves the view by the kind of punch,
 *   within fixed limits, and dims the picture for two frames. No red.
 * - The clock is a board in the hall, where a real one hangs.
 *
 * The opponent's body arrives as a pose in its own frame with the distance it
 * stands at; how that pose was made (a formula, or recorded motion) is not
 * this file's business.
 */
/**
 * How much the view takes in from top to bottom, degrees. At real punching
 * range the opponent is an arm's length away: a narrow view would be all
 * face. This is wide enough to keep its shoulders, arms and hips in the
 * picture there, as a boxer's own eyes do.
 */
export const STAGE_FOV = 78;
/** The top of the opponent's head sits this far under the top edge; the tip stays inside these limits, radians. */
const HEAD_ROOM = 0.12,
  PITCH = { most: -0.384, least: 0.14, easeS: 0.12 },
  LOOK_DOWN = -0.6;
/** Own glove on a punch: out to the target, a held instant, back. Milliseconds. */
const PUNCH_OUT = 50,
  PUNCH_HOLD = 60,
  PUNCH_BACK = 170;
/** How far from the eye the player's gloves are drawn at rest, metres. */
const GLOVE_OUT = 0.74;
/**
 * What being hit does to the view, at full size: metres and radians. Reached
 * in a frame or two and gone within a quarter of a second.
 */
const KICK: Record<"jab" | "cross" | "hook" | "body" | "uppercut", { back: number; across: number; down: number; pitch: number; yaw: number; roll: number }> = {
  jab: { back: 0.03, across: 0, down: 0, pitch: 0.026, yaw: 0, roll: 0 },
  cross: { back: 0.06, across: 0, down: 0, pitch: 0.052, yaw: 0, roll: 0.01 },
  hook: { back: 0, across: 0.08, down: 0, pitch: 0, yaw: 0.105, roll: 0.07 },
  body: { back: 0, across: 0, down: 0.04, pitch: -0.052, yaw: 0, roll: 0 },
  uppercut: { back: 0.03, across: 0, down: -0.02, pitch: 0.09, yaw: 0, roll: 0 },
};
/** Whatever is added to the view by the game is kept inside these. */
const LIMIT = { roll: 0.087, pitch: 0.105, yaw: 0.14, travel: 0.1 };

export function createRealStage(canvas: HTMLCanvasElement) {
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
  const camera = new T.PerspectiveCamera(STAGE_FOV, 1, 0.03, 60);
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
    // Each arm has its own sleeve: close to the eye it is faint, so that one's own arm is never a wall.
    const foreMat = sleeve.clone(),
      upperMat = sleeve.clone();
    foreMat.transparent = upperMat.transparent = true;
    materials.push(foreMat, upperMat);
    return {
      gloveMat,
      cuffMat,
      foreMat,
      upperMat,
      glove: ball(gloveMat, 0.088, 0.098, 0.115),
      cuff: tube(cuffMat),
      fore: tube(foreMat),
      upper: tube(upperMat),
      at: new T.Vector3(),
      placed: false,
      punch: null as null | { at: number; to: T.Vector3; shape: PunchShape },
    };
  });
  for (const m of mine)
    for (const part of [m.glove, m.cuff, m.fore, m.upper]) part.castShadow = false;
  const full = new T.Color("#35c9c2"),
    spent = new T.Color("#5a7f86");
  // The real arms as last drawn: [shoulder, elbow, wrist, glove] for each, eased a hundredth of a second so thirty poses a second do not step.
  const drawnArm: (T.Vector3[] | null)[] = [null, null];
  // The player's gloves go see-through where they would hide the opponent, with a rim that stays solid.
  const rimGeo = keep(new T.RingGeometry(0.9, 1, 28));
  const rims = mine.map((m) => {
    m.gloveMat.transparent = true;
    m.cuffMat.transparent = true;
    const material = new T.MeshBasicMaterial({ color: "#bff5f0", transparent: true, opacity: 0, depthTest: false, side: T.DoubleSide, fog: false });
    materials.push(material);
    const rim = new T.Mesh(rimGeo, material);
    rim.renderOrder = 9;
    scene.add(rim);
    return rim;
  });
  // The player as a figure, seen only when the corner shows a punch again from the side.
  const ghostBody = mat("#6f8792", 0.8),
    ghostGlove = mat("#35c9c2", 0.4);
  const self = {
    head: ball(ghostBody, 0.105, 0.128, 0.115),
    neck: tube(ghostBody),
    trunk: tube(ghostBody),
    arms: [0, 1].map(() => ({ upper: tube(ghostBody), fore: tube(ghostBody), glove: ball(ghostGlove, 0.098, 0.108, 0.125) })),
    legs: [0, 1].map(() => ({ thigh: tube(ghostBody), shin: tube(ghostBody), foot: ball(ghostBody, 0.06, 0.045, 0.12) })),
  };
  const selfParts = [self.head, self.neck, self.trunk, ...self.arms.flatMap((a) => [a.upper, a.fore, a.glove]), ...self.legs.flatMap((l) => [l.thigh, l.shin, l.foot])];
  for (const part of selfParts) part.visible = false;
  // A light from behind and above the opponent: its head and shoulder line stand out against the dark hall.
  const back = new T.DirectionalLight("#dff1ff", 1.5);
  back.position.set(0, 3.4, -DISTANCE - 2.6);
  back.target.position.set(0, 1.4, -DISTANCE + 0.6);
  scene.add(back, back.target);
  // A fast glove leaves two faint copies of itself where it has just been: a hook can be followed.
  const ghostMats = [0.25, 0.12].map((opacity) => {
    const material = new T.MeshBasicMaterial({ color: "#d7263d", transparent: true, opacity, depthWrite: false });
    materials.push(material);
    return material;
  });
  const ghosts = [0, 1].map(() =>
    ghostMats.map((material) => {
      const mesh = new T.Mesh(sphereGeo, material);
      mesh.scale.set(0.098, 0.108, 0.125);
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    }),
  );
  const trail: T.Vector3[][] = [[], []];
  // The clock, on a board in the hall beside the opponent's head.
  const boardCanvas = document.createElement("canvas");
  boardCanvas.width = 512;
  boardCanvas.height = 208;
  const boardPen = boardCanvas.getContext("2d");
  const boardTexture = new T.CanvasTexture(boardCanvas);
  boardTexture.colorSpace = T.SRGBColorSpace;
  const boardMat = new T.MeshBasicMaterial({ map: boardTexture, fog: false });
  materials.push(boardMat);
  const board = new T.Mesh(keep(new T.PlaneGeometry(1.5, 0.61)), boardMat);
  board.position.set(1.95, 1.9, -DISTANCE - 3.3);
  scene.add(board);
  let boardText = "";
  const writeBoard = (clock: string, under: string) => {
    if (!boardPen || `${clock}|${under}` === boardText) return;
    boardText = `${clock}|${under}`;
    boardPen.fillStyle = "#0b1218";
    boardPen.fillRect(0, 0, 512, 208);
    boardPen.strokeStyle = "#3b4a55";
    boardPen.lineWidth = 6;
    boardPen.strokeRect(3, 3, 506, 202);
    boardPen.fillStyle = "#ffd98a";
    boardPen.textAlign = "center";
    boardPen.textBaseline = "middle";
    boardPen.font = "700 128px system-ui, sans-serif";
    boardPen.fillText(clock, 256, under ? 86 : 108);
    if (under) {
      boardPen.fillStyle = "#b9c7c1";
      boardPen.font = "600 40px system-ui, sans-serif";
      boardPen.fillText(under, 256, 172);
    }
    boardTexture.needsUpdate = true;
  };
  /** A punch of the player's that got through: sweat when the glove gets there. */
  const landed: { at: number; level: Level; third: Third; hook: number; weight: number; point?: T.Vector3; go?: T.Vector3 }[] = [];
  /** Where each of the player's gloves last met the opponent, and which way it was going: sweat flies from there, that way. */
  const metAt: ({ at: number; point: T.Vector3; go: T.Vector3 } | null)[] = [null, null];
  /** Being hit: when, what by, from which side, how hard; a second one soon after adds to it and never restarts it. */
  let kick: { at: number; kind: keyof typeof KICK; side: number; size: number } | null = null;
  let dimAt = -Infinity,
    knockAt = -Infinity,
    nudgeAt = -Infinity,
    pushAt = -Infinity;
  let lookDown = 0,
    pitch = -0.3,
    myFall = 0,
    floorAt = -Infinity,
    width = 0,
    height = 0,
    lastNow = -Infinity;
  const eye = new T.Vector3(0, 1.65, 0);
  const ndc = new T.Vector3();
  /** Where a point is in the picture (-1 to 1 each way), and how large a ball of `radius` there looks. */
  const seen = (at: T.Vector3, radius: number) => {
    ndc.copy(at).project(camera);
    const away = Math.max(0.05, at.distanceTo(camera.position));
    return { x: ndc.x, y: ndc.y, r: radius / away / Math.tan((camera.fov * Math.PI) / 360), front: ndc.z < 1 };
  };

  function render(view: RealView, now: number) {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (w !== width || h !== height) {
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      // On a screen held upright the view is widened to keep the width a laptop shows.
      camera.fov = Math.min(
        95,
        (2 * Math.atan(Math.tan((STAGE_FOV * Math.PI) / 360) * Math.max(1, 1.3 / camera.aspect)) * 180) / Math.PI,
      );
    }
    const dt = Math.max(0, Math.min(0.1, (now - lastNow) / 1000));
    lastNow = now;
    const bout = view.bout;
    const pose = view.pose,
      react = view.react,
      rock = view.rock,
      distance = view.distance;
    // The opponent's own frame to the ring's: it stands `distance` in front of the player, facing them.
    const toWorld = (p: Vec3): Vec3 => ({ x: -p.x, y: p.y, z: -distance + p.z });
    const moved = (p: Vec3, by: Vec3) => vec(toWorld({ x: p.x + by.x, y: p.y + by.y, z: p.z + by.z }));
    const world = {
      head: moved(pose.head, react.head),
      chest: moved(pose.chest, react.chest),
      hips: vec(toWorld(pose.hips)),
      shoulders: pose.shoulders.map((p) => moved(p, react.chest)),
      // A punch taken on its guard rocks the gloves back toward its face and apart.
      gloves: pose.gloves.map((p, i) => moved(p, { x: (i ? 1 : -1) * 0.03 * rock, y: -react.gloves, z: -0.06 * rock })),
    };
    /** Where one of the player's punches is going: head or body, and which third as they see it. */
    const zone = (level: Level, third: Third, shape: PunchShape) => {
      const across = third === "left" ? -1 : third === "right" ? 1 : 0;
      const at = level === "body" ? world.hips.clone().lerp(world.chest, 0.45) : world.head.clone();
      at.x += across * (level === "body" ? 0.1 : 0.07);
      if (level === "head" && shape === "uppercut") at.y -= 0.07;
      at.z += 0.13;
      return at;
    };
    // ── What happened ─────────────────────────────────────────────────────
    for (const p of view.sent) mine[p.hand === "left" ? 0 : 1].punch = { at: now, to: zone(p.level, p.third, p.shape), shape: p.shape };
    for (const tch of view.touches) {
      const i = tch.hand === "left" ? 0 : 1;
      const was = drawnArm[i]?.[3];
      const point = new T.Vector3(tch.at.x, tch.at.y, -tch.at.z);
      metAt[i] = { at: now, point, go: was ? point.clone().sub(was).normalize() : new T.Vector3(0, 0, -1) };
      // Glove on glove: a knock where it happened.
      if (tch.what === "glove" || tch.what === "arm") pushAt = now;
    }
    for (const e of view.events) {
      if (e.kind === "mine") {
        const m = mine[e.hand === "left" ? 0 : 1];
        const met = metAt[e.hand === "left" ? 0 : 1];
        if (e.outcome === "clean" || e.outcome === "partly")
          landed.push({
            // Real contact is now, where the glove is; a sent glove gets there a moment later.
            at: met && now - met.at < 200 ? now : now + PUNCH_OUT,
            level: e.level,
            third: e.third,
            hook: e.shape === "hook" ? (e.hand === "left" ? 1 : -1) : 0,
            weight: Math.min(1, e.damage / 3),
            ...(met && now - met.at < 200 ? { point: met.point, go: met.go } : {}),
          });
        else if (e.outcome === "gloves" && m.punch) {
          // The glove stops on its guard, short of the face.
          m.punch.to.copy(world.gloves[e.hand === "left" ? 1 : 0]);
          m.punch.to.z += 0.17;
        }
      } else if (e.kind === "down" && e.who === "foe" && !e.standing) floorAt = now;
    }
    // Its punches arriving, as they are to be seen: with the picture when the outcome was certain, else when it was settled.
    for (const e of view.shown) {
      if (e.kind === "its") {
        // The opponent's left hand arrives on the player's right.
        const side = e.hand === "left" ? 1 : -1;
        if (e.outcome === "clean" || e.outcome === "partly") {
          const kind = e.level === "body" ? "body" : e.shape === "hook" ? "hook" : e.shape === "uppercut" ? "uppercut" : e.code === "j" ? "jab" : "cross";
          const size = (e.outcome === "clean" ? 1 : 0.5) * Math.max(0.6, Math.min(1.3, e.damage / 2.4));
          // A second one inside the first adds to it and does not start it again.
          if (kick && now - kick.at < 260) kick.size = Math.min(1.6, kick.size + 0.6 * size);
          else kick = { at: now, kind, side, size };
          if (e.outcome === "clean") dimAt = now;
        } else if (e.outcome === "gloves") {
          knockAt = now;
          nudgeAt = now;
        }
      }
    }
    // The ring answers a knockdown: the far ropes shake and the hall flares.
    const since = (now - floorAt) / 1000;
    const shook = since >= 0 && since < 1.5 ? 0.02 * Math.sin(40 * since) * Math.exp(-4 * since) : 0;
    for (const rope of farRopes) rope.mesh.position.y = rope.y + shook;
    const flare = since >= 0 && since < 2 ? Math.exp(-3 * since) : 0;
    hallMat.opacity = 0.55 + 0.45 * flare;
    hallMat.size = 0.09 * (1 + 0.8 * flare);
    // A punch that got through: sweat, the way it was going, when the glove gets there. Nothing else.
    while (landed.length && landed[0].at <= now) {
      const e = landed.shift()!;
      const at = e.point ? e.point.clone() : e.level === "head" ? world.head.clone() : world.hips.clone().lerp(world.chest, 0.45);
      if (!e.point) at.z += 0.1;
      pushAt = now;
      const count = 6 + Math.round(10 * e.weight);
      for (let i = 0; i < count; i++) {
        const d = dropNext++ % DROPS;
        dropAt.set([at.x, at.y, at.z], d * 3);
        // The way the fist was going, when that is known.
        if (e.go)
          dropGo.set([e.go.x * (1.5 + random() * 2) + (random() - 0.5) * 1.4, 0.8 + random() * 1.4 + e.go.y, e.go.z * (1 + random() * 2) + (random() - 0.5) * 0.8], d * 3);
        else
          dropGo.set(
            [e.hook * (1.5 + random() * 2) + (random() - 0.5) * 1.6, 0.8 + random() * 1.6, -(1 + random() * 2.2) * (e.hook ? 0.3 : 1)],
            d * 3,
          );
        dropLife[d] = 0.3;
      }
    }
    // ── The view ──────────────────────────────────────────────────────────
    // It follows the player's real head one to one: the one true cue for depth a flat screen has.
    // With a real body the eye is the eye: a step toward the screen is a step toward the opponent, whole.
    const target = meToWorld(view.me ? view.me.head : { x: view.head.x, y: view.head.y, z: view.head.z * 0.5 });
    const ease = 1 - Math.exp(-dt / 0.025);
    eye.x += (target.x - eye.x) * ease;
    eye.y += (target.y - eye.y) * ease;
    eye.z += (target.z - eye.z) * ease;
    camera.position.copy(eye);
    const again = view.replay;
    {
      // Tipped so the top of its head sits just under the top edge: its feet are then in the picture.
      const top = world.head.y + 0.13;
      const away = Math.max(0.3, Math.hypot(world.head.x - eye.x, world.head.z - eye.z));
      const up = Math.atan2(top - eye.y, away);
      const half = (camera.fov * Math.PI) / 360;
      const want = up - Math.atan((1 - 2 * HEAD_ROOM) * Math.tan(half));
      const to = Math.max(PITCH.most, Math.min(PITCH.least, want));
      pitch += (to - pitch) * (1 - Math.exp(-dt / PITCH.easeS));
    }
    camera.rotation.set(pitch, 0, 0);
    // Being hit: by the kind of punch and its side, full in a frame or two, gone in a quarter second, inside fixed limits.
    let added = { back: 0, across: 0, down: 0, pitch: 0, yaw: 0, roll: 0 };
    if (kick) {
      const ms = now - kick.at;
      if (ms > 260) kick = null;
      else {
        const k = (ms < 25 ? ms / 25 : (1 - (ms - 25) / 235) ** 2) * kick.size;
        const c = KICK[kick.kind];
        added = { back: c.back * k, across: -kick.side * c.across * k, down: c.down * k, pitch: c.pitch * k, yaw: kick.side * c.yaw * k, roll: kick.side * c.roll * k };
      }
    }
    // A punch taken on the gloves nudges the view and no more; landing one carries it a finger's width in.
    const nudge = Math.max(0, 1 - (now - nudgeAt) / 90);
    added.back += 0.01 * nudge;
    added.pitch += 0.009 * nudge;
    const into = Math.max(0, 1 - (now - pushAt) / 70);
    added.back -= 0.015 * into * into;
    const cap = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
    camera.position.z += cap(added.back, LIMIT.travel);
    camera.position.x += cap(added.across, LIMIT.travel);
    camera.position.y -= cap(added.down, LIMIT.travel);
    camera.rotation.x += cap(added.pitch, LIMIT.pitch);
    camera.rotation.y += cap(added.yaw, LIMIT.yaw);
    camera.rotation.z = cap(added.roll, LIMIT.roll);
    // The picture dims for two frames on a clean hit and comes back within a sixth of a second. No red.
    const dimMs = now - dimAt;
    const dim = dimMs < 34 ? 1 : Math.max(0, 1 - (dimMs - 34) / 150);
    renderer.toneMappingExposure = 1.15 * (1 - 0.45 * dim);
    // The opponent on the canvas: look at it.
    const floored = bout.foe.down !== null && !bout.foe.down.standing;
    lookDown += ((floored ? 1 : 0) - lookDown) * (1 - Math.exp(-dt / (floored ? 0.16 : 0.2)));
    if (lookDown > 0.002) {
      camera.rotation.x += (LOOK_DOWN - pitch) * lookDown;
      camera.position.y += 0.05 * lookDown;
    }
    // A player on the canvas sees the lights, and so does one who is stopped.
    const lyingMe =
      (bout.me.down !== null && !bout.me.down.standing) || (bout.over?.winner === "foe" && bout.over.how === "stoppage");
    myFall += ((lyingMe ? 1 : 0) - myFall) * (1 - Math.exp(-dt / 0.16));
    if (myFall > 0.002) {
      camera.position.y -= 0.9 * myFall;
      camera.rotation.x += 0.75 * myFall;
    }
    // The corner shows a punch again: from the side, level with the shoulders, both figures in the picture.
    const selfHead = again ? vec(meToWorld({ x: again.head.x, y: again.head.y, z: 0 })) : null;
    if (again) {
      // Aimed low, so the heads and gloves sit in the upper half and the corner's words lie over the legs.
      camera.position.set(2.5 / Math.min(1, camera.aspect / 1.2), 1.36, -distance / 2 + 0.25);
      camera.rotation.set(0, 0, 0);
      camera.lookAt(0, 0.86, -distance / 2);
      renderer.toneMappingExposure = 1.15;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    // ── The clock ─────────────────────────────────────────────────────────
    {
      const left = Math.max(0, Math.ceil(view.clock - 0.001));
      writeBoard(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, bout.rounds > 1 ? `ROUND ${bout.round} OF ${bout.rounds}` : "");
    }
    // ── The opponent ──────────────────────────────────────────────────────
    foe.head.position.copy(world.head);
    // It watches the player, tipping back as it goes down; a punch turns its head.
    const face = selfHead ? selfHead.clone() : new T.Vector3(eye.x, world.head.y + (eye.y - world.head.y) * 0.4, eye.z);
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
      const shoulder = world.shoulders[i],
        glove = world.gloves[i];
      const wrist = glove.clone().lerp(shoulder, 0.1);
      // Which way the elbow goes is part of the motion: it says which punch.
      const pole = pose.poles[i];
      const elbow = vec(twoBone(shoulder, wrist, 0.3, 0.28, { x: -pole.x, y: pole.y, z: pole.z }));
      arm.shoulder.position.copy(shoulder);
      link(arm.upper, shoulder, elbow, 0.062);
      arm.elbow.position.copy(elbow);
      link(arm.fore, elbow, wrist, 0.052);
      link(arm.cuff, wrist.clone().lerp(elbow, 0.22), wrist, 0.06);
      arm.glove.position.copy(glove);
      arm.glove.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), glove.clone().sub(elbow).normalize());
      arm.glove.scale.set(0.098, 0.108, 0.125);
      // Faster than four metres a second: two faint copies where it has just been.
      const past = trail[i];
      const speed = past.length && dt > 0 ? glove.distanceTo(past[0]) / dt : 0;
      ghosts[i].forEach((ghost, n) => {
        ghost.visible = speed > 4 && past.length > n && pose.fallen === 0;
        if (ghost.visible) {
          ghost.position.copy(past[n]);
          ghost.quaternion.copy(arm.glove.quaternion);
        }
      });
      past.unshift(glove.clone());
      if (past.length > 2) past.pop();
    });
    foe.legs.forEach((leg, i) => {
      const side = i === 0 ? 1 : -1;
      const hip = world.hips.clone().add(new T.Vector3(side * 0.1, -0.04, 0));
      // The feet go with a lunge, the front one most: the legs do not stretch.
      // Recorded motion brings its own feet: where the boxer's ankles really were, a little forward for the foot itself.
      const ankle = pose.feet?.[i];
      const foot = ankle
        ? vec(toWorld({ x: ankle.x, y: Math.max(0.05, ankle.y - 0.03), z: ankle.z + 0.05 }))
        : vec(toWorld({ x: -side * 0.15, y: 0.05, z: 0.02 + (i ? 0.08 : -0.08) + pose.lunge * (i ? 0.8 : 0.3) }));
      if (pose.fallen > 0) foot.lerp(new T.Vector3(side * 0.2, 0.06, -distance + 0.42), pose.fallen);
      // Standing, the knees bend toward the player; lying, they bend up.
      const knee = vec(
        twoBone(hip, foot, 0.5, 0.48, { x: side * (0.1 + 0.2 * pose.fallen), y: pose.fallen, z: 1 - 0.8 * pose.fallen }),
      );
      link(leg.thigh, hip, knee, 0.095);
      link(leg.shin, knee, foot, 0.06);
      leg.foot.position.copy(foot);
      blobs[i].position.set(foot.x, 0.004, foot.z);
    });
    // ── The player, as a figure, when a punch is shown again ───────────────
    for (const part of selfParts) part.visible = again !== null;
    if (again && selfHead) {
      const chest = new T.Vector3(selfHead.x * 0.6, selfHead.y - 0.27, 0.05);
      const hips = new T.Vector3(selfHead.x * 0.2, Math.min(0.98, chest.y - 0.38), 0.1);
      self.head.position.copy(selfHead);
      link(self.neck, chest.clone().lerp(selfHead, 0.35), selfHead, 0.058);
      link(self.trunk, hips, chest.clone().setY(chest.y + 0.04), 0.17);
      self.arms.forEach((arm, i) => {
        const side = i === 0 ? -1 : 1;
        const shoulder = new T.Vector3(chest.x + side * 0.19, chest.y + 0.02, chest.z);
        const hand = again.hands[i];
        // A hand the camera did not see hangs by the hip: it guarded nothing.
        const glove = hand ? vec(meToWorld(hand)) : new T.Vector3(shoulder.x + side * 0.05, hips.y - 0.05, -0.1);
        // No further than the arm is long.
        const reach = glove.clone().sub(shoulder);
        if (reach.length() > 0.6) glove.copy(shoulder).addScaledVector(reach.normalize(), 0.6);
        const wrist = glove.clone().lerp(shoulder, 0.1);
        const elbow = vec(twoBone(shoulder, wrist, 0.3, 0.28, { x: side * 0.3, y: -1, z: 0.2 }));
        link(arm.upper, shoulder, elbow, 0.062);
        link(arm.fore, elbow, wrist, 0.052);
        arm.glove.position.copy(glove);
        arm.glove.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), glove.clone().sub(elbow).normalize());
      });
      self.legs.forEach((leg, i) => {
        const side = i === 0 ? -1 : 1;
        const hip = hips.clone().add(new T.Vector3(side * 0.1, -0.04, 0));
        const foot = new T.Vector3(side * 0.15, 0.05, 0.12 + (i ? 0.1 : -0.1));
        const knee = vec(twoBone(hip, foot, 0.5, 0.48, { x: side * 0.1, y: 0, z: -1 }));
        link(leg.thigh, hip, knee, 0.095);
        link(leg.shin, knee, foot, 0.06);
        leg.foot.position.copy(foot);
      });
    }
    // ── The player's gloves ───────────────────────────────────────────────
    const breath = Math.max(0, Math.min(1, view.breath));
    // What a glove may be hiding: its head, its shoulders, its gloves.
    const hides = [
      seen(world.head, 0.13),
      seen(world.shoulders[0], 0.09),
      seen(world.shoulders[1], 0.09),
      seen(world.gloves[0], 0.11),
      seen(world.gloves[1], 0.11),
    ];
    // Taken on the gloves: they are knocked a hand's width toward the eye for a moment.
    const knock = Math.max(0, 1 - (now - knockAt) / 90);
    const real = view.me;
    if (real) {
      // The real arms. Nothing is played: each joint is where the body has it.
      const ease = 1 - Math.exp(-dt / 0.012);
      mine.forEach((m, i) => {
        const to = [real.shoulders[i], real.elbows[i], real.wrists[i], real.gloves[i]].map((p) => vec(meToWorld(p)));
        const at = drawnArm[i] && dt < 0.1 ? drawnArm[i]! : to.map((p) => p.clone());
        for (let n = 0; n < 4; n++) at[n].lerp(to[n], ease);
        drawnArm[i] = at;
        // The view has been moved by a hit: the arms go with the head they belong to.
        const moved = camera.position.clone().sub(eye);
        const [shoulder, elbow, wrist, glove] = at.map((p) => p.clone().add(moved));
        m.glove.position.copy(glove);
        m.glove.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), glove.clone().sub(elbow).normalize());
        m.glove.scale.set(0.085, 0.095, 0.11);
        link(m.cuff, wrist.clone().lerp(elbow, 0.25), wrist, 0.055);
        link(m.fore, elbow, wrist.clone().lerp(elbow, 0.25), 0.05);
        link(m.upper, shoulder, elbow, 0.058);
        m.gloveMat.color.copy(full).lerp(spent, 1 - breath);
        // Close to the face a glove is faint; out at arm's length it is solid. Where it would hide the opponent it is see-through, with a rim.
        const away = glove.distanceTo(camera.position);
        const near = Math.max(0, Math.min(1, (away - 0.28) / 0.3));
        const me = seen(glove, 0.095);
        const over = away < 0.62 && me.front && hides.some((o) => o.front && Math.hypot((o.x - me.x) * camera.aspect, o.y - me.y) < o.r + me.r * 0.8);
        const fade = 1 - Math.exp(-dt / 0.05);
        m.gloveMat.opacity += ((over ? 0.22 : 0.2 + 0.8 * near) - m.gloveMat.opacity) * fade;
        m.cuffMat.opacity = m.gloveMat.opacity;
        // The sleeve by how far its middle is from the eye: the upper arm is nearly always too near to be more than a hint.
        const faint = (a: T.Vector3, b: T.Vector3) => 0.08 + 0.92 * Math.max(0, Math.min(1, (a.clone().lerp(b, 0.5).distanceTo(camera.position) - 0.26) / 0.34));
        m.foreMat.opacity += (faint(elbow, wrist) - m.foreMat.opacity) * fade;
        m.upperMat.opacity += (faint(shoulder, elbow) * 0.6 - m.upperMat.opacity) * fade;
        const rim = rims[i];
        rim.position.copy(glove);
        rim.quaternion.copy(camera.quaternion);
        rim.scale.setScalar(0.1);
        // The rim marks a glove that is out in front of the opponent; one held by the face needs none.
        (rim.material as T.MeshBasicMaterial).opacity += ((over && away > 0.36 ? 0.85 : 0) - (rim.material as T.MeshBasicMaterial).opacity) * fade;
        const visible = real.seen[i] && myFall < 0.3 && lookDown < 0.3 && !again;
        for (const part of [m.glove, m.cuff, m.fore, m.upper, rim]) part.visible = visible;
      });
    } else
    mine.forEach((m, i) => {
      const side = i === 0 ? -1 : 1;
      const hand = view.hands[i];
      // In their true direction from the eye, a fixed way out: where the wrist really is, not lifted into view.
      const rel = hand
        ? { x: hand.x - view.head.x, y: hand.y - view.head.y, z: Math.max(0.12, hand.z - view.head.z) }
        : { x: side * 0.2, y: -0.5, z: 0.2 };
      const tired = breath < 0.2 ? 1 - breath / 0.2 : 0;
      const dir = new T.Vector3(rel.x, rel.y - 0.04 * tired, -rel.z).normalize();
      // Never under the bottom edge: a low block is still seen.
      const lowest = -Math.sin(Math.min(1.2, -pitch + ((camera.fov * Math.PI) / 360) * 0.82));
      if (dir.y < lowest) {
        dir.y = lowest;
        dir.normalize();
      }
      const home = eye.clone().addScaledVector(dir, GLOVE_OUT);
      home.y += 0.003 * tired * Math.sin(now / 26);
      if (knock > 0) home.addScaledVector(dir, -0.05 * knock);
      if (!m.placed) {
        m.at.copy(home);
        m.placed = true;
      } else if (hand) m.at.lerp(home, 1 - Math.exp(-dt / 0.02));
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
          squash = t >= PUNCH_OUT && t < PUNCH_OUT + 40 ? 1 : 0;
        }
      }
      // The arm comes from a shoulder just below the picture.
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
      m.foreMat.opacity = m.upperMat.opacity = 1;
      // Breath shows on the gloves.
      m.gloveMat.color.copy(full).lerp(spent, 1 - breath);
      // Where it would hide the opponent it goes see-through, with a solid rim: the player still knows where their glove is.
      const me = seen(shown, 0.095);
      const over = out < 0.5 && me.front && hides.some((o) => o.front && Math.hypot((o.x - me.x) * camera.aspect, o.y - me.y) < o.r + me.r * 0.8);
      const fade = 1 - Math.exp(-dt / 0.05);
      m.gloveMat.opacity += ((over ? 0.4 : 1) - m.gloveMat.opacity) * fade;
      m.cuffMat.opacity = m.gloveMat.opacity;
      const rim = rims[i];
      rim.position.copy(shown);
      rim.quaternion.copy(camera.quaternion);
      rim.scale.setScalar(0.1 * (1 + 0.3 * out));
      (rim.material as T.MeshBasicMaterial).opacity += ((over ? 0.85 : 0) - (rim.material as T.MeshBasicMaterial).opacity) * fade;
      const visible = (hand !== null || m.punch !== null) && myFall < 0.3 && lookDown < 0.3 && !again;
      for (const part of [m.glove, m.cuff, m.fore, m.upper, rim]) part.visible = visible;
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
    renderer.render(scene, camera);
  }

  return {
    render,
    setQuality(level: { pixelRatio: number; shadows: boolean }) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, level.pixelRatio));
      key.castShadow = level.shadows;
    },
    dispose() {
      boardTexture.dispose();
      for (const m of materials) m.dispose();
      for (const g of geometries) g.dispose();
      renderer.dispose();
      scene.clear();
    },
  };
}
