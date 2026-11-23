import * as T from "three";
import {
  COURT_DISTANCE,
  localPoint,
  worldPoint,
  type DuelState,
  type PlayerPose,
} from "./duel";
import type { Vec3 } from "./physics";
import type { Shot } from "./cameraRig";
import { BODY, JOINT, bodyOf } from "./body";
import { createFootPlanter } from "./footPlant";
import { VIEW_MODEL, keepInView, palm as palmOf } from "./viewModel";
import { rebound, stepDeadBall } from "./deadBall";
import type { BallState } from "./physics";

export interface FingerVisual {
  side: "Left" | "Right";
  points: Vec3[];
}
/** Turning rate drawn on a ball thrown without measured spin, radians a second. */
const BACKSPIN = 38;
/** The aim ring is the size of what it stands for: a ball centre inside it hits the torso. */
const AIM_RADIUS = 0.35;
/** Smallest the ring may appear, as a share of the view's height. */
const AIM_MIN_SHARE = 0.09;
/** How long a ball takes to fly to the hand of the player who gets it next. */
const HANDOVER_MS = 450;
/** Length of the player's own forearm as drawn in first person. */
const FOREARM = 0.27;
/** How far the first-person view is tipped down, radians. */
const VIEW_PITCH = 0.07;
/**
 * The play view's lens, degrees top to bottom. It was 58. At 52 the opponent
 * and the ball are a ninth larger and a dodge slides the court further across
 * the screen, while the near posts, the floor marks and the player's own
 * shadow all stay in the picture. Narrower than about 48 loses the shadow and
 * crowds the raised hand.
 */
export const PLAY_FOV = 52;
/** Time constant of the first-person eye's blend toward the tracked head. */
const EYE_BLEND_MS = 18;
export function createPovScene(canvas: HTMLCanvasElement) {
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
  renderer.toneMappingExposure = 1.1;
  const scene = new T.Scene();
  scene.background = new T.Color("#101a20");
  scene.fog = new T.Fog("#101a20", 14, 32);
  const camera = new T.PerspectiveCamera(PLAY_FOV, 1, 0.035, 60);
  // Turn to face the court, then tip, then roll: the same for both seats.
  camera.rotation.order = "YXZ";
  const ambient = new T.HemisphereLight("#e8f0ee", "#34322a", 2);
  scene.add(ambient);
  const sun = new T.DirectionalLight("#fff0d1", 3);
  sun.position.set(-3, 8, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  scene.add(sun);
  const cool = new T.PointLight("#7ee1e2", 24, 15);
  cool.position.set(3, 4, -7);
  scene.add(cool);
  const materials: T.Material[] = [];
  const geometries: T.BufferGeometry[] = [];
  const mat = (color: string, roughness = 0.6, metalness = 0.1) => {
    const m = new T.MeshStandardMaterial({ color, roughness, metalness });
    materials.push(m);
    return m;
  };
  const floorMat = mat("#a6a493", 0.9),
    wallMat = mat("#26353e", 0.85),
    dark = mat("#14222a"),
    cyan = mat("#96e5d7", 0.35, 0.35),
    orange = mat("#e97c51", 0.4, 0.2),
    skin = mat("#d4d7cc", 0.65);
  const box = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    m: T.Material,
  ) => {
    const g = new T.BoxGeometry(w, h, d);
    geometries.push(g);
    const mesh = new T.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  };
  box(0, -0.09, -4, 12, 0.16, 24, floorMat);
  box(-5, 3, -4, 0.25, 6, 23, wallMat);
  box(5, 3, -4, 0.25, 6, 23, wallMat);
  box(0, 3, -15, 10, 6, 0.2, wallMat);
  box(0, 3, 7, 10, 6, 0.2, wallMat);
  for (let z = 3; z >= -14; z -= 3) {
    box(-4.83, 2.5, z, 0.12, 5, 0.08, dark);
    box(4.83, 2.5, z, 0.12, 5, 0.08, dark);
    box(0, 5.4, z, 10, 0.12, 0.14, dark);
  }
  for (let z = 1; z >= -10; z -= 4) {
    const lamp = new T.MeshBasicMaterial({ color: "#fff3dc" });
    materials.push(lamp);
    box(0, 5.25, z, 3, 0.025, 0.6, lamp);
  }
  const lineMat = new T.LineBasicMaterial({
    color: "#566a6b",
    transparent: true,
    opacity: 0.55,
  });
  materials.push(lineMat);
  const grid: T.Vector3[] = [];
  for (let x = -4; x <= 4; x++) {
    grid.push(new T.Vector3(x, 0.005, 3), new T.Vector3(x, 0.005, -13));
  }
  for (let z = 3; z >= -13; z--) {
    grid.push(new T.Vector3(-4, 0.005, z), new T.Vector3(4, 0.005, z));
  }
  const gridGeo = new T.BufferGeometry().setFromPoints(grid);
  geometries.push(gridGeo);
  scene.add(new T.LineSegments(gridGeo, lineMat));
  for (const z of [0, -COURT_DISTANCE]) {
    box(0, 0.009, z, 1.2, 0.016, 0.5, z === 0 ? cyan : orange);
    box(0, 0.02, z - 0.3, 1.45, 0.02, 0.025, dark);
  }
  // Soft translucent spatial boundary, not a lane or a movement multiplier.
  const boundaryMat = new T.MeshBasicMaterial({
    color: "#96e5d7",
    transparent: true,
    opacity: 0.06,
    side: T.DoubleSide,
  });
  materials.push(boundaryMat);
  const boundaryGeo = new T.PlaneGeometry(0.6, 2.2);
  geometries.push(boundaryGeo);
  for (const z of [0, -COURT_DISTANCE])
    for (const x of [-0.65, 0.65]) {
      const m = new T.Mesh(boundaryGeo, boundaryMat);
      m.rotation.y = Math.PI / 2;
      m.position.set(x, 1.1, z);
      scene.add(m);
    }
  // Things within a few steps of each player. A small move of the head slides
  // near objects across the view far more than the opponent eight metres away,
  // which is what tells the player their dodge registered. They stand outside
  // the court's width and low on the floor, where no ball travels.
  for (const [z0, toward] of [
    [0, -1],
    [-COURT_DISTANCE, 1],
  ] as const) {
    // Two metres ahead and just outside the court: inside the view, and low
    // enough that a thrown ball passes over them.
    for (const x of [-0.85, 0.85]) {
      box(x, 0.3, z0 + toward * 2, 0.06, 0.6, 0.06, dark);
      box(
        x,
        0.615,
        z0 + toward * 2,
        0.11,
        0.03,
        0.11,
        z0 === 0 ? cyan : orange,
      );
    }
    for (const ahead of [0.7, 1.1, 1.5, 2, 2.6, 3.3])
      box(0, 0.006, z0 + toward * ahead, 2.1, 0.004, 0.03, dark).castShadow =
        false;
  }
  const sphereGeo = new T.SphereGeometry(1, 24, 16);
  geometries.push(sphereGeo);
  const sphere = (radius: number, m: T.Material) => {
    const mesh = new T.Mesh(sphereGeo, m);
    mesh.scale.setScalar(radius);
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  };
  const capsuleGeo = new T.CylinderGeometry(1, 1, 1, 10);
  geometries.push(capsuleGeo);
  // Limbs narrow toward the far joint: a uniform pipe reads as a mannequin.
  const taperGeo = new T.CylinderGeometry(0.76, 1, 1, 10);
  geometries.push(taperGeo);
  function bone(m: T.Material, r = 0.035, taper = false) {
    const mesh = new T.Mesh(taper ? taperGeo : capsuleGeo, m);
    mesh.scale.set(r, 1, r);
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }
  const up = new T.Vector3(0, 1, 0);
  function link(mesh: T.Mesh, a: Vec3, b: Vec3, r = 0.035) {
    const va = new T.Vector3(a.x, a.y, a.z),
      vb = new T.Vector3(b.x, b.y, b.z);
    const delta = vb.clone().sub(va);
    mesh.position.copy(va).add(vb).multiplyScalar(0.5);
    mesh.scale.set(r, Math.max(0.001, delta.length()), r);
    mesh.quaternion.setFromUnitVectors(up, delta.normalize());
  }
  /**
   * Jointed avatar. Every part is placed between the pose's skeleton joints each
   * frame; nothing here is a canned animation. Prototype mannequin, not final art.
   */
  function createAvatar() {
    const jersey = mat("#e97c51", 0.45, 0.15);
    const torsoMat = mat("#e97c51", 0.45, 0.15);
    torsoMat.side = T.DoubleSide;
    const headGroup = new T.Group();
    const skull = new T.Mesh(sphereGeo, skin);
    skull.scale.set(0.135, 0.155, 0.15);
    skull.castShadow = true;
    const visorGeo = new T.BoxGeometry(0.2, 0.05, 0.06);
    geometries.push(visorGeo);
    const visor = new T.Mesh(visorGeo, dark);
    // Local -z is the face, so head turn and tilt stay readable at a distance.
    visor.position.set(0, 0.03, -0.12);
    headGroup.add(skull, visor);
    scene.add(headGroup);
    const soleGeo = new T.BoxGeometry(0.1, 0.03, 0.26);
    const footShadeGeo = new T.CircleGeometry(0.13, 20);
    geometries.push(soleGeo, footShadeGeo);
    const torsoGeo = new T.BufferGeometry();
    torsoGeo.setAttribute(
      "position",
      new T.BufferAttribute(new Float32Array(60 * 3), 3),
    );
    geometries.push(torsoGeo);
    const torso = new T.Mesh(torsoGeo, torsoMat);
    torso.castShadow = true;
    torso.frustumCulled = false;
    scene.add(torso);
    const neck = bone(skin, 0.045);
    const side = () => ({
      shoulder: sphere(0.064, jersey),
      upperArm: bone(jersey, 0.052, true),
      elbow: sphere(0.04, skin),
      foreArm: bone(skin, 0.042, true),
      hand: bone(skin, 0.034),
      fist: sphere(0.05, skin),
      hip: sphere(0.082, dark),
      thigh: bone(dark, 0.08, true),
      knee: sphere(0.058, skin),
      shin: bone(skin, 0.058, true),
      ankle: sphere(0.046, skin),
      foot: bone(jersey, 0.043),
      toe: sphere(0.043, jersey),
      sole: (() => {
        const mesh = new T.Mesh(soleGeo, dark);
        mesh.castShadow = true;
        scene.add(mesh);
        return mesh;
      })(),
      shade: (() => {
        const mesh = new T.Mesh(
          footShadeGeo,
          new T.MeshBasicMaterial({
            color: "#05080c",
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
          }),
        );
        materials.push(mesh.material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 1;
        scene.add(mesh);
        return mesh;
      })(),
    });
    const sides = [side(), side()];
    // Three rings of four corners (left-front, right-front, right-back,
    // left-back): shoulders, waist, hips. Two segments, so the trunk bends
    // and twists between the hips and the shoulders instead of being one box.
    const quads = [
      [0, 1, 5, 4],
      [4, 5, 9, 8],
      [2, 3, 7, 6],
      [6, 7, 11, 10],
      [3, 2, 1, 0],
      [8, 9, 10, 11],
      [3, 0, 4, 7],
      [7, 4, 8, 11],
      [1, 2, 6, 5],
      [5, 6, 10, 9],
    ];
    const tmp = new T.Vector3();
    // Feet hold their place on the floor and step; see footPlant.ts.
    const planter = createFootPlanter();
    // A wrist that is lost or found fades over a tenth of a second.
    const handFade = [1, 1];
    let fadeClock = 0;
    return {
      update(
        pose: PlayerPose,
        player: 0 | 1,
        tint: string,
        handsVisible: [boolean, boolean],
        /** 0 to 1: how white the body is lit, for the instant it is hit. */
        flash = 0,
      ) {
        jersey.color.set(tint);
        torsoMat.color.set(tint);
        for (const m of [jersey, torsoMat]) {
          m.emissive.set("#ffffff");
          m.emissiveIntensity = 1.6 * Math.max(0, Math.min(1, flash));
        }
        const clock = performance.now();
        const j = planter.update(bodyOf(pose), clock / 1000).map((joint) => {
          const w = worldPoint(joint, player);
          return new T.Vector3(w.x, w.y, w.z);
        });
        const fadeStep = Math.min(1, Math.max(0, (clock - fadeClock) / 110));
        fadeClock = clock;
        for (let i = 0; i < 2; i++)
          handFade[i] = Math.max(
            0,
            Math.min(1, handFade[i] + (handsVisible[i] ? fadeStep : -fadeStep)),
          );
        const ls = j[JOINT.L_SHOULDER],
          rs = j[JOINT.R_SHOULDER],
          lh = j[JOINT.L_HIP],
          rh = j[JOINT.R_HIP];
        const chest = ls.clone().add(rs).multiplyScalar(0.5),
          pelvis = lh.clone().add(rh).multiplyScalar(0.5);
        const across = rs.clone().sub(ls).normalize(),
          spine = chest.clone().sub(pelvis).normalize();
        const front = new T.Vector3().crossVectors(across, spine);
        if (front.lengthSq() < 1e-8) front.set(0, 0, 1);
        front.normalize();
        // The hips have their own line: a shoulder turn twists the trunk.
        const acrossHips = rh.clone().sub(lh);
        if (acrossHips.lengthSq() < 1e-8) acrossHips.copy(across);
        acrossHips.normalize();
        const frontHips = new T.Vector3().crossVectors(acrossHips, spine);
        if (frontHips.lengthSq() < 1e-8) frontHips.copy(front);
        frontHips.normalize();
        // The waist sits nearer the hips' upright than the straight line from
        // hips to shoulders: a lean bends the trunk rather than tilting a box.
        const waist = pelvis.clone().lerp(chest, 0.42);
        waist.x = pelvis.x + (waist.x - pelvis.x) * 0.6;
        waist.z = pelvis.z + (waist.z - pelvis.z) * 0.6;
        const acrossWaist = across.clone().add(acrossHips).normalize();
        const frontWaist = front.clone().add(frontHips).normalize();
        const ring = (
          centre: T.Vector3,
          side: T.Vector3,
          ahead: T.Vector3,
          half: number,
          depth: number,
        ) =>
          [
            [-1, 1],
            [1, 1],
            [1, -1],
            [-1, -1],
          ].map(([a, b]) =>
            centre
              .clone()
              .addScaledVector(side, a * half)
              .addScaledVector(ahead, b * depth),
          );
        // Torso: a prism through both shoulders and both hips, so shoulder tilt,
        // hip tilt, lean and twist all come straight from the joints.
        const corner = (
          joint: T.Vector3,
          out: number,
          lift: number,
          depth: number,
        ) =>
          joint
            .clone()
            .addScaledVector(across, out)
            .addScaledVector(spine, lift)
            .addScaledVector(front, depth);
        const hipCorner = (joint: T.Vector3, out: number, depth: number) =>
          joint
            .clone()
            .addScaledVector(acrossHips, out)
            .addScaledVector(spine, -0.07)
            .addScaledVector(frontHips, depth);
        const corners = [
          corner(ls, -0.02, 0.035, 0.1),
          corner(rs, 0.02, 0.035, 0.1),
          corner(rs, 0.02, 0.035, -0.1),
          corner(ls, -0.02, 0.035, -0.1),
          ...ring(waist, acrossWaist, frontWaist, 0.125, 0.08),
          hipCorner(lh, -0.035, 0.085),
          hipCorner(rh, 0.035, 0.085),
          hipCorner(rh, 0.035, -0.085),
          hipCorner(lh, -0.035, -0.085),
        ];
        const position = torsoGeo.getAttribute("position") as T.BufferAttribute;
        let k = 0;
        for (const [a, b, c, d] of quads)
          for (const i of [a, b, c, a, c, d])
            position.setXYZ(k++, corners[i].x, corners[i].y, corners[i].z);
        position.needsUpdate = true;
        torsoGeo.computeVertexNormals();
        // Head: centred between the ears, facing where the nose points.
        const le = j[JOINT.L_EAR],
          re = j[JOINT.R_EAR],
          nose = j[JOINT.NOSE];
        const earMid = le.clone().add(re).multiplyScalar(0.5);
        const centre = earMid.clone().lerp(nose, 0.25);
        headGroup.position.copy(centre);
        const right = re.clone().sub(le);
        const forward = nose.clone().sub(earMid);
        if (right.lengthSq() > 1e-8) {
          right.normalize();
          forward.addScaledVector(right, -forward.dot(right));
          if (forward.lengthSq() > 1e-8) {
            forward.normalize();
            const upward = new T.Vector3().crossVectors(right, forward);
            headGroup.quaternion.setFromRotationMatrix(
              new T.Matrix4().makeBasis(right, upward, forward.negate()),
            );
          }
        }
        link(neck, chest.clone().addScaledVector(spine, 0.03), centre, 0.045);
        sides.forEach((part, i) => {
          const shoulder = j[JOINT.L_SHOULDER + i],
            elbow = j[JOINT.L_ELBOW + i],
            wrist = j[JOINT.L_WRIST + i],
            knuckle = j[JOINT.L_KNUCKLE + i],
            hip = j[JOINT.L_HIP + i],
            knee = j[JOINT.L_KNEE + i],
            ankle = j[JOINT.L_ANKLE + i],
            toe = j[JOINT.L_TOE + i];
          part.shoulder.position.copy(shoulder);
          link(part.upperArm, shoulder, elbow, 0.052);
          part.elbow.position.copy(elbow);
          // A wrist the camera has lost is not drawn at a stale position: the
          // forearm and hand thin away, and grow back when it is found.
          const seen = handFade[i];
          link(part.foreArm, elbow, wrist, 0.042 * seen);
          link(part.hand, wrist, knuckle, 0.034 * seen);
          part.fist.position.copy(tmp.copy(wrist).lerp(knuckle, 0.9));
          part.fist.scale.setScalar(0.05 * seen);
          for (const mesh of [part.foreArm, part.hand, part.fist])
            mesh.visible = seen > 0.02;
          part.hip.position.copy(hip);
          link(part.thigh, hip, knee, 0.08);
          part.knee.position.copy(knee);
          link(part.shin, knee, ankle, 0.058);
          part.ankle.position.copy(ankle);
          link(part.foot, ankle, toe, 0.043);
          part.toe.position.copy(toe);
          // A sole under the foot and a soft shadow under that: the feet used
          // to hang four centimetres above a floor that showed no contact.
          const lifted = Math.max(0, ankle.y - BODY.ankle);
          part.sole.position.set(
            (ankle.x + toe.x) / 2,
            0.015 + lifted,
            (ankle.z + toe.z) / 2,
          );
          part.sole.rotation.set(
            0,
            Math.atan2(toe.x - ankle.x, toe.z - ankle.z),
            0,
          );
          part.shade.position.set(
            part.sole.position.x,
            0.011,
            part.sole.position.z,
          );
          part.shade.scale.set(0.8 + lifted, 1.25 + lifted, 1);
          part.shade.rotation.z = -part.sole.rotation.y;
          part.shade.material.opacity = 0.35 * Math.max(0, 1 - lifted / 0.35);
        });
      },
    };
  }
  const avatar = createAvatar();
  // The broadcast view (seen from behind the opponent) shows both players whole:
  // the second avatar is the opponent, near the lens, back turned. Hidden otherwise.
  const nearFrom = scene.children.length;
  const nearAvatar = createAvatar();
  const nearParts = scene.children.slice(nearFrom);
  const showNear = (shown: boolean) => nearParts.forEach((o) => (o.visible = shown));
  showNear(false);
  const ownHands = [sphere(0.045, skin), sphere(0.045, skin)];
  // The player's own forearms in first person; see viewModel.ts. A sleeve in
  // the player's colour that narrows to the wrist, with a skin-coloured hand.
  const ownForearms = [bone(cyan, 0.036, true), bone(cyan, 0.036, true)];
  for (const mesh of [...ownForearms, ...ownHands]) mesh.castShadow = false;
  const ownFade = [1, 1];
  let ownFadeClock = 0;
  // The player's own shadow, thrown forward along the floor by a low light
  // behind them: the one part of their body they can see answer a dodge.
  // Each unit of height lands this far ahead.
  const SHADOW_REACH = 2.3;
  const ownShadowGeo = new T.BufferGeometry();
  ownShadowGeo.setAttribute(
    "position",
    new T.BufferAttribute(new Float32Array(30 * 9), 3),
  );
  geometries.push(ownShadowGeo);
  const ownShadowMat = new T.MeshBasicMaterial({
    color: "#03060a",
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: T.DoubleSide,
  });
  materials.push(ownShadowMat);
  const ownShadow = new T.Mesh(ownShadowGeo, ownShadowMat);
  ownShadow.frustumCulled = false;
  ownShadow.renderOrder = 1;
  scene.add(ownShadow);
  /** Where the held ball was last drawn, so a thrown ball can leave from there. */
  const heldAt = new T.Vector3();
  /** For each of the player's balls: how far its first drawing was from the real one. */
  const handOff = new Map<number, T.Vector3>();
  // Balls the game has finished with keep bouncing and rolling for a few
  // seconds instead of vanishing where they resolved. See deadBall.ts.
  const lastBall = new Map<number, BallState>();
  const dead: {
    mesh: T.Group;
    blob?: T.Mesh<T.CircleGeometry, T.MeshBasicMaterial>;
    state: BallState;
    born: number;
  }[] = [];
  let deadClock = 0;
  const retire = (d: Pick<(typeof dead)[number], "mesh" | "blob">) => {
    scene.remove(d.mesh);
    if (d.blob) {
      scene.remove(d.blob);
      d.blob.material.dispose();
    }
  };
  const chains = [
    [0, 1, 2, 3, 4],
    [0, 5, 6, 7, 8],
    [0, 9, 10, 11, 12],
    [0, 13, 14, 15, 16],
    [0, 17, 18, 19, 20],
  ];
  const fingers = [0, 1].map(() => ({
    joints: Array.from({ length: 21 }, () => sphere(0.009, cyan)),
    bones: Array.from({ length: 20 }, () => bone(cyan, 0.007)),
  }));
  for (const rig of fingers)
    for (const mesh of [...rig.joints, ...rig.bones]) mesh.castShadow = false;
  // Yellow, lit from within: the ball must stand out against the opponent's
  // orange jersey, which the old orange ball did not.
  const ballMat = mat("#ffe14a", 0.28, 0.15);
  ballMat.emissive.set("#c98a00");
  ballMat.emissiveIntensity = 0.6;
  // A soft dark disc on the floor directly beneath each ball: the cue for how
  // far away and how high it is. The sun's shadow falls well off to one side.
  const blobGeo = new T.CircleGeometry(0.13, 24);
  geometries.push(blobGeo);
  const blobs = new Map<
    number,
    T.Mesh<T.CircleGeometry, T.MeshBasicMaterial>
  >();
  const ballMeshes = new Map<number, T.Group>();
  // The ball's trail: a ribbon facing the camera, wide and bright at the ball
  // and tapering to nothing. A line is one pixel wide in WebGL at any size.
  const TRAIL = 14;
  const trails = new Map<number, { line: T.Mesh; points: Vec3[] }>();
  const trailMat = new T.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    side: T.DoubleSide,
    fog: false,
  });
  materials.push(trailMat);
  const trailIndex: number[] = [];
  for (let i = 0; i < TRAIL - 1; i++)
    trailIndex.push(
      2 * i,
      2 * i + 1,
      2 * i + 2,
      2 * i + 1,
      2 * i + 3,
      2 * i + 2,
    );
  // An incoming ball wears a ring that closes on it as it nears: how long
  // until it arrives, readable before the ball itself is more than a dot.
  const approachMat = new T.MeshBasicMaterial({
    color: "#ffe14a",
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    side: T.DoubleSide,
    fog: false,
  });
  materials.push(approachMat);
  const approachGeo = new T.RingGeometry(0.2, 0.225, 40);
  geometries.push(approachGeo);
  const approachRing = new T.Mesh(approachGeo, approachMat);
  approachRing.renderOrder = 9;
  approachRing.visible = false;
  scene.add(approachRing);
  const impactGeo = new T.RingGeometry(0.75, 1, 32);
  geometries.push(impactGeo);
  const impacts = new Map<
    number,
    { mesh: T.Mesh<T.RingGeometry, T.MeshBasicMaterial>; born: number }
  >();
  const seenImpacts = new Set<number>();
  const ringGeo = new T.TorusGeometry(0.111, 0.008, 6, 32);
  geometries.push(ringGeo);
  function ballMesh(id: number) {
    let group = ballMeshes.get(id);
    if (group) return group;
    group = new T.Group();
    const body = new T.Mesh(sphereGeo, ballMat);
    body.scale.setScalar(0.11);
    // Held balls keep the sun shadow; a ball in flight gets the disc beneath it.
    body.castShadow = id < 0;
    group.add(body);
    for (let a = 0; a < 3; a++) {
      const ring = new T.Mesh(ringGeo, dark);
      ring.rotation.set(
        a === 1 ? Math.PI / 2 : 0,
        a === 2 ? Math.PI / 2 : 0,
        0,
      );
      group.add(ring);
    }
    scene.add(group);
    ballMeshes.set(id, group);
    return group;
  }
  const held = ballMesh(-1);
  const enemyHeld = ballMesh(-2);
  // Aim marker: a ring on the opponent's side showing where the ball will go.
  // Drawn over everything so the opponent's body never hides it.
  const aimMaterial = new T.MeshBasicMaterial({
    color: "#96e5d7",
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    side: T.DoubleSide,
    fog: false,
  });
  materials.push(aimMaterial);
  const aimRingGeo = new T.RingGeometry(AIM_RADIUS - 0.05, AIM_RADIUS, 64),
    aimDotGeo = new T.CircleGeometry(0.045, 20);
  geometries.push(aimRingGeo, aimDotGeo);
  const aimRing = new T.Mesh(aimRingGeo, aimMaterial),
    aimDot = new T.Mesh(aimDotGeo, aimMaterial);
  aimRing.renderOrder = aimDot.renderOrder = 10;
  // A thin line from the ring to the floor: how high the aim is.
  const aimDrop = new T.Mesh(capsuleGeo, aimMaterial);
  aimDrop.renderOrder = 10;
  aimDrop.visible = false;
  scene.add(aimDrop);
  const aimGroup = new T.Group();
  aimGroup.add(aimRing, aimDot);
  aimGroup.visible = false;
  scene.add(aimGroup);
  let lastTime = 0;
  let smoothEye: Vec3 | null = null,
    eyeAt = 0,
    eyeViewer: 0 | 1 = 0;
  function render(
    s: DuelState,
    local: 0 | 1,
    heldBall: boolean,
    fingerVisuals: FingerVisual[] = [],
    visibleHands: [boolean, boolean] = [true, true],
    options: {
      opponentHolding?: boolean;
      opponentView?: boolean;
      /**
       * A chase camera in the local player's own frame (see cameraRig.ts): both
       * players drawn whole, never mirrored. Null or absent: first person.
       */
      chase?: Shot | null;
      /** The dark court floor (CORE.md 2.1): the ball and the figures stand out. */
      darkFloor?: boolean;
      /** Aim marker for the local player, in their own frame. */
      aim?: {
        point: Vec3;
        locked: boolean;
        /** The ball is away: the ring stays, faint, where it was thrown. */
        ghost?: boolean;
        /** How that throw ended, shown briefly on the ring. */
        result?: "hit" | "miss";
      } | null;
      /** 0 to 1: the opponent lit white for the instant the player's ball lands. */
      flash?: number;
      /** The ball coming to the hand of whoever gets it next, from a world point. */
      handover?: { from: Vec3; at: number; to: 0 | 1 } | null;
      /** Speed of the after-effects: 1, or less for the slow finish of a round. */
      rate?: number;
      /** First-person jolt from being hit: metres pushed back, radians rolled. */
      kick?: { back: number; roll: number };
    } = {},
  ) {
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (
      canvas.width !== Math.round(width * renderer.getPixelRatio()) ||
      canvas.height !== Math.round(height * renderer.getPixelRatio())
    )
      renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    // Swap only the viewing seat. Physics, tracking, hands and possession retain
    // their player identities, with one render pass and one WebGL context.
    const chase = options.chase ?? null;
    const offSeat = !!(options.opponentView || chase);
    const viewer = options.opponentView ? ((1 - local) as 0 | 1) : local;
    floorMat.color.set(options.darkFloor ? "#2a3640" : "#a6a493");
    const mine = s.poses[viewer],
      other = (1 - viewer) as 0 | 1,
      p = s.poses[other];
    // "See myself" is a camera on a stand at the opponent's place, not the
    // opponent's own head, which sways and bobs and would move the picture.
    const target = chase
      ? worldPoint(chase.eye, local)
      : options.opponentView
      ? worldPoint({ x: 0, y: 1.5, z: 0 }, viewer)
      : worldPoint(mine.head, viewer);
    // The pose changes about 30 times a second and the screen 60 or more. A
    // short blend at the screen's rate takes the remaining steps out of the view.
    const clock = performance.now();
    const blend =
      smoothEye &&
      eyeViewer === viewer &&
      clock - eyeAt < 100 &&
      Math.hypot(
        target.x - smoothEye.x,
        target.y - smoothEye.y,
        target.z - smoothEye.z,
      ) < 0.4
        ? 1 - Math.exp(-(clock - eyeAt) / EYE_BLEND_MS)
        : 1;
    const eye: Vec3 = smoothEye
      ? {
          x: smoothEye.x + (target.x - smoothEye.x) * blend,
          y: smoothEye.y + (target.y - smoothEye.y) * blend,
          z: smoothEye.z + (target.z - smoothEye.z) * blend,
        }
      : target;
    smoothEye = eye;
    eyeAt = clock;
    eyeViewer = viewer;
    camera.position.set(eye.x, eye.y, eye.z);
    // Tipped a few degrees down: more of the nearby floor, and the opponent a
    // little higher in the picture.
    camera.rotation.set(-VIEW_PITCH, viewer === 0 ? 0 : Math.PI, 0);
    if (options.kick && !offSeat) {
      // Away from the opponent is +z for seat 0 and -z for seat 1.
      camera.position.z += (viewer === 0 ? 1 : -1) * options.kick.back;
      camera.rotation.z = options.kick.roll;
    }
    // Opponent view is the opponent's seat through a long lens aimed at the centre
    // of your court, so the whole body fills the frame and its movement inside the
    // court stays visible. Play view keeps the normal first-person lens.
    camera.fov = chase ? chase.fov : options.opponentView ? 22 : PLAY_FOV;
    if (chase) {
      const centre = worldPoint(chase.look, local);
      camera.lookAt(centre.x, centre.y, centre.z);
    } else if (options.opponentView) {
      const centre = worldPoint({ x: 0, y: 0.95, z: 0 }, other);
      camera.lookAt(centre.x, centre.y, centre.z);
    }
    camera.updateProjectionMatrix();
    const set = (o: T.Object3D, v: Vec3) => o.position.set(v.x, v.y, v.z);
    // The other seat's player as a full skeleton. In opponent view that player is
    // you, tinted cyan, and a wrist the camera has lost hides that forearm.
    avatar.update(
      p,
      other,
      other === local ? "#96e5d7" : "#e97c51",
      other === local ? visibleHands : [true, true],
      other === local ? 0 : (options.flash ?? 0),
    );
    // In a chase view the player is drawn whole too, in front of the lens.
    showNear(!!chase);
    if (chase) nearAvatar.update(s.poses[local], local, "#96e5d7", visibleHands, 0);
    // In play view the player's own arms are drawn where they can be seen:
    // a hand raised beside the head to aim is level with the eye or behind
    // it, and would otherwise be off screen along with the ball it holds.
    camera.updateMatrixWorld(true);
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const mineJoints = bodyOf(mine);
    {
      // Each joint's shadow: straight ahead of it by its height.
      const cast = (p: Vec3) => {
        const w = worldPoint(
          { x: p.x, y: 0, z: p.z + Math.max(0, p.y) * SHADOW_REACH },
          viewer,
        );
        return { x: w.x, z: w.z };
      };
      type P = { x: number; z: number };
      const position = ownShadowGeo.getAttribute(
        "position",
      ) as T.BufferAttribute;
      let n = 0;
      const tri = (a: P, b: P, c: P) => {
        for (const p of [a, b, c]) position.setXYZ(n++, p.x, 0.013, p.z);
      };
      const strip = (a: P, b: P, half: number) => {
        const dx = b.x - a.x,
          dz = b.z - a.z;
        const size = Math.hypot(dx, dz) || 1;
        const ox = (-dz / size) * half,
          oz = (dx / size) * half;
        const a1 = { x: a.x + ox, z: a.z + oz },
          a2 = { x: a.x - ox, z: a.z - oz },
          b1 = { x: b.x + ox, z: b.z + oz },
          b2 = { x: b.x - ox, z: b.z - oz };
        tri(a1, b1, b2);
        tri(a1, b2, a2);
      };
      const J = (i: number) => cast(mineJoints[i]);
      const ls = J(JOINT.L_SHOULDER),
        rs = J(JOINT.R_SHOULDER),
        lh = J(JOINT.L_HIP),
        rh = J(JOINT.R_HIP);
      tri(ls, rs, rh);
      tri(ls, rh, lh);
      const head = cast(mineJoints[JOINT.NOSE]);
      strip({ x: (ls.x + rs.x) / 2, z: (ls.z + rs.z) / 2 }, head, 0.05);
      // A ball-shaped head lands as an oval, long the way the light travels.
      const far = viewer === 0 ? -1 : 1;
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2,
          a1 = ((i + 1) / 12) * Math.PI * 2;
        tri(
          head,
          {
            x: head.x + Math.cos(a0) * 0.14,
            z: head.z + far * Math.sin(a0) * 0.33,
          },
          {
            x: head.x + Math.cos(a1) * 0.14,
            z: head.z + far * Math.sin(a1) * 0.33,
          },
        );
      }
      for (let i = 0; i < 2; i++) {
        const elbow = J(JOINT.L_ELBOW + i),
          wrist = J(JOINT.L_WRIST + i);
        strip(i ? rs : ls, elbow, 0.05);
        if (visibleHands[i]) strip(elbow, wrist, 0.04);
      }
      position.needsUpdate = true;
      ownShadowGeo.setDrawRange(0, n);
      ownShadow.visible = !offSeat;
    }
    const ownClock = performance.now();
    const ownStep = Math.min(1, Math.max(0, (ownClock - ownFadeClock) / 110));
    ownFadeClock = ownClock;
    for (let i = 0; i < 2; i++)
      ownFade[i] = Math.max(
        0,
        Math.min(1, ownFade[i] + (visibleHands[i] ? ownStep : -ownStep)),
      );
    let heldDrawn: Vec3 | null = null;
    [mine.leftHand, mine.rightHand].forEach((h, i) => {
      const wrist = worldPoint(h, viewer);
      const elbow = worldPoint(mineJoints[JOINT.L_ELBOW + i], viewer);
      const raised = h.y - mine.root.y >= 0.15;
      const keep = !offSeat && (raised || (i === 1 && heldBall));
      let shown = wrist;
      if (keep) {
        const c = new T.Vector3(wrist.x, wrist.y, wrist.z).applyMatrix4(
          camera.matrixWorldInverse,
        );
        const k = keepInView(
          { x: c.x, y: c.y, depth: -c.z },
          tanHalf,
          camera.aspect,
        );
        const w = new T.Vector3(k.x, k.y, -k.depth).applyMatrix4(
          camera.matrixWorld,
        );
        shown = { x: w.x, y: w.y, z: w.z };
      }
      // The forearm keeps its direction and a fixed length. Its measured
      // length cannot be trusted mid-throw: the wrist and the elbow are each
      // led separately and the forearm nearly doubled.
      const along = {
        x: wrist.x - elbow.x,
        y: wrist.y - elbow.y,
        z: wrist.z - elbow.z,
      };
      const reach = Math.hypot(along.x, along.y, along.z) || 1;
      const shownElbow = {
        x: shown.x - (along.x / reach) * FOREARM,
        y: shown.y - (along.y / reach) * FOREARM,
        z: shown.z - (along.z / reach) * FOREARM,
      };
      set(ownHands[i], shown);
      // From the stand at the opponent's place these would be the opponent's
      // hands, floating in front of the lens.
      ownHands[i].scale.setScalar(0.045 * ownFade[i]);
      ownHands[i].visible = !offSeat && ownFade[i] > 0.02;
      link(ownForearms[i], shownElbow, shown, 0.036 * ownFade[i]);
      ownForearms[i].visible = keep && ownFade[i] > 0.02;
      if (i === 1) {
        heldDrawn = keep ? palmOf(shownElbow, shown) : wrist;
        held.scale.setScalar(keep ? VIEW_MODEL.ballScale : 1);
      }
    });
    for (let i = 0; i < 2; i++) {
      const visual = fingerVisuals.find(
        (f) =>
          visibleHands[i] &&
          f.side === (i === 0 ? "Left" : "Right") &&
          f.points.length === 21 &&
          f.points.every((p) => [p.x, p.y, p.z].every(Number.isFinite)),
      );
      const rig = fingers[i];
      rig.joints.forEach((j) => (j.visible = !!visual));
      rig.bones.forEach((b) => (b.visible = !!visual));
      if (visual) {
        visual.points.forEach((point, k) => {
          if (k < 21) set(rig.joints[k], worldPoint(point, local));
        });
        let k = 0;
        for (const chain of chains)
          for (let j = 1; j < chain.length; j++) {
            link(
              rig.bones[k++],
              worldPoint(visual.points[chain[j - 1]], local),
              worldPoint(visual.points[chain[j]], local),
              0.007,
            );
          }
      }
    }
    held.visible = heldBall;
    // The marker belongs to the thrower's own view; from the opponent's seat the
    // raised arm is the only tell.
    const aim = offSeat ? null : options.aim;
    aimGroup.visible = !!aim;
    aimDrop.visible = !!aim && !aim.ghost;
    if (aim) {
      const at = worldPoint(aim.point, local);
      set(aimGroup, at);
      aimGroup.quaternion.copy(camera.quaternion);
      // Is the ring over the opponent? The same radii the hit test uses.
      const foe = s.poses[(1 - local) as 0 | 1],
        seat = (1 - local) as 0 | 1;
      const torso = worldPoint({ ...foe.root, y: foe.root.y + 0.2 }, seat),
        head = worldPoint(foe.head, seat);
      const onTarget =
        Math.hypot(at.x - torso.x, at.y - torso.y) < 0.35 ||
        Math.hypot(at.x - head.x, at.y - head.y) < 0.26;
      aimMaterial.color.set(
        aim.result === "hit"
          ? "#7dff9a"
          : aim.result === "miss"
            ? "#ff6b5a"
            : aim.locked
              ? "#fff3c4"
              : onTarget
                ? "#ffe14a"
                : "#96e5d7",
      );
      aimMaterial.opacity = aim.ghost && !aim.result ? 0.35 : 0.95;
      // Never smaller on screen than a set share of the view, however far.
      const visible =
        2 *
        camera.position.distanceTo(aimGroup.position) *
        Math.tan((camera.fov * Math.PI) / 360);
      const floor = Math.max(1, (AIM_MIN_SHARE * visible) / (2 * AIM_RADIUS));
      // A free ring breathes; a committed one is still and slightly drawn in.
      const pulse =
        aim.locked || aim.ghost
          ? 0.85
          : 1 + 0.06 * Math.sin(performance.now() / 80);
      aimGroup.scale.setScalar(floor * pulse);
      if (at.y - AIM_RADIUS > 0.05)
        link(
          aimDrop,
          { x: at.x, y: 0.01, z: at.z },
          { x: at.x, y: at.y - AIM_RADIUS * floor * pulse, z: at.z },
          0.008 * floor,
        );
      else aimDrop.visible = false;
    }
    enemyHeld.visible =
      options.opponentHolding === true && !options.opponentView;
    if (chase) enemyHeld.visible = false;
    set(
      enemyHeld,
      worldPoint(s.poses[(1 - local) as 0 | 1].rightHand, (1 - local) as 0 | 1),
    );
    set(held, heldDrawn ?? worldPoint(s.poses[local].rightHand, local));
    // A ball being handed over flies to the hand on an arc for a moment.
    const arriving = options.handover
      ? Math.min(1, (performance.now() - options.handover.at) / HANDOVER_MS)
      : 1;
    if (options.handover && arriving < 1) {
      const mesh = options.handover.to === local ? held : enemyHeld;
      const ease = arriving * arriving * (3 - 2 * arriving);
      const from = options.handover.from;
      mesh.position.set(
        from.x + (mesh.position.x - from.x) * ease,
        Math.max(0.11, from.y) +
          (mesh.position.y - Math.max(0.11, from.y)) * ease +
          0.6 * Math.sin(Math.PI * ease),
        from.z + (mesh.position.z - from.z) * ease,
      );
    }
    if (heldBall) heldAt.copy(held.position);
    const palm = fingerVisuals.find(
      (f) =>
        f.side === "Right" &&
        f.points.length === 21 &&
        f.points.every((p) => [p.x, p.y, p.z].every(Number.isFinite)),
    );
    if (palm) {
      const v = (i: number) => {
        const p = worldPoint(palm.points[i], local);
        return new T.Vector3(p.x, p.y, p.z);
      };
      const x = v(5).sub(v(17)),
        y = v(9).sub(v(0)),
        z = new T.Vector3().crossVectors(x, y);
      if (x.lengthSq() > 1e-8 && z.lengthSq() > 1e-8) {
        x.normalize();
        z.normalize();
        y.crossVectors(z, x).normalize();
        held.quaternion.setFromRotationMatrix(
          new T.Matrix4().makeBasis(x, y, z),
        );
      }
    }
    const dt = Math.min(0.05, Math.max(0, s.time - lastTime));
    if (s.time < lastTime) {
      seenImpacts.clear();
      for (const { mesh } of impacts.values()) {
        scene.remove(mesh);
        mesh.material.dispose();
      }
      impacts.clear();
    }
    lastTime = s.time;
    const live = new Set(s.balls.map((b) => b.id));
    for (const [id, m] of ballMeshes)
      if (id > 0 && !live.has(id)) {
        ballMeshes.delete(id);
        handOff.delete(id);
        const blob = blobs.get(id);
        blobs.delete(id);
        const state = lastBall.get(id);
        lastBall.delete(id);
        if (state) {
          // A ball that struck a body comes off it; any other carries on.
          const event = (s.events ?? []).find((e) => e.id === id);
          if (event?.kind === "hit") {
            const body = s.poses[event.target];
            const head = worldPoint(body.head, event.target),
              torso = worldPoint(
                { ...body.root, y: body.root.y + 0.2 },
                event.target,
              );
            const near = (c: Vec3) =>
              Math.hypot(
                c.x - state.position.x,
                c.y - state.position.y,
                c.z - state.position.z,
              );
            state.velocity = rebound(
              state.velocity,
              state.position,
              near(head) < near(torso) ? head : torso,
            );
          }
          // A caught ball is in someone's hands: it does not fall to the floor.
          if (event?.kind === "catch") retire({ mesh: m, blob });
          else {
            dead.push({ mesh: m, blob, state, born: performance.now() });
            while (dead.length > 3) retire(dead.shift()!);
          }
        } else retire({ mesh: m, blob });
        const trail = trails.get(id);
        if (trail) {
          scene.remove(trail.line);
          trail.line.geometry.dispose();
          trails.delete(id);
        }
      }
    let approachSeen = false;
    for (const b of s.balls) {
      const m = ballMesh(b.id);
      const drawn = { ...b.position };
      // The player's own throw leaves from where the ball was drawn in the
      // hand and joins its real path over the first 80 ms.
      if (b.owner === local && !offSeat) {
        let off = handOff.get(b.id);
        if (!off && b.age < 0.05) {
          off = heldAt.clone().sub(new T.Vector3(drawn.x, drawn.y, drawn.z));
          handOff.set(b.id, off);
        }
        const k = off ? Math.max(0, 1 - b.age / 0.08) : 0;
        if (off && k > 0) {
          drawn.x += off.x * k;
          drawn.y += off.y * k;
          drawn.z += off.z * k;
        }
      }
      set(m, drawn);
      // Far away the ball would be a few pixels: draw it up to 1.8 times its
      // size at the far end, shrinking to true size as it comes within 4.5 m.
      const away = camera.position.distanceTo(m.position);
      m.scale.setScalar(Math.max(1, Math.min(1.8, away / 4.5)));
      let blob = blobs.get(b.id);
      if (!blob) {
        blob = new T.Mesh(
          blobGeo,
          new T.MeshBasicMaterial({
            color: "#000000",
            transparent: true,
            depthWrite: false,
          }),
        );
        blob.rotation.x = -Math.PI / 2;
        scene.add(blob);
        blobs.set(b.id, blob);
      }
      lastBall.set(b.id, {
        position: { ...drawn },
        velocity: { ...b.velocity },
        spin: { ...b.spin },
        radius: b.radius,
      });
      const height = Math.max(0, drawn.y - b.radius);
      blob.position.set(drawn.x, 0.012, drawn.z);
      blob.scale.setScalar(1 + 0.3 * height);
      blob.material.opacity = options.darkFloor ? Math.max(0.25, 0.55 * (1 - height / 3)) : 0.45 * Math.max(0, 1 - height / 3);
      let trail = trails.get(b.id);
      if (!trail) {
        const geometry = new T.BufferGeometry();
        geometry.setAttribute(
          "position",
          new T.BufferAttribute(new Float32Array(TRAIL * 6), 3),
        );
        geometry.setAttribute(
          "color",
          new T.BufferAttribute(new Float32Array(TRAIL * 6), 3),
        );
        geometry.setIndex(trailIndex);
        const line = new T.Mesh(geometry, trailMat);
        line.frustumCulled = false;
        scene.add(line);
        trail = { line, points: [] };
        trails.set(b.id, trail);
      }
      if (dt > 0 || !trail.points.length) {
        trail.points.push(drawn);
        if (trail.points.length > TRAIL) trail.points.shift();
      }
      {
        const position = trail.line.geometry.getAttribute(
            "position",
          ) as T.BufferAttribute,
          color = trail.line.geometry.getAttribute(
            "color",
          ) as T.BufferAttribute;
        const count = trail.points.length;
        for (let i = 0; i < TRAIL; i++) {
          // Unused samples collapse onto the oldest point.
          const at = trail.points[Math.max(0, i - (TRAIL - count))];
          const next =
            trail.points[
              Math.min(count - 1, Math.max(0, i - (TRAIL - count)) + 1)
            ];
          const along = new T.Vector3(
            next.x - at.x,
            next.y - at.y,
            next.z - at.z,
          );
          const toEye = new T.Vector3(
            camera.position.x - at.x,
            camera.position.y - at.y,
            camera.position.z - at.z,
          );
          const side = along.cross(toEye);
          // 0 at the tail, 1 at the ball.
          const k = count > 1 ? i / (TRAIL - 1) : 0;
          if (side.lengthSq() > 1e-10) side.setLength(0.085 * k);
          else side.set(0, 0, 0);
          position.setXYZ(2 * i, at.x + side.x, at.y + side.y, at.z + side.z);
          position.setXYZ(
            2 * i + 1,
            at.x - side.x,
            at.y - side.y,
            at.z - side.z,
          );
          const glow = 0.55 * k * k;
          color.setXYZ(2 * i, glow, glow * 0.88, glow * 0.3);
          color.setXYZ(2 * i + 1, glow, glow * 0.88, glow * 0.3);
        }
        position.needsUpdate = true;
        color.needsUpdate = true;
      }
      // The ring around a ball coming at this player.
      if (b.owner !== local && !offSeat) {
        const far = Math.abs(drawn.z - camera.position.z);
        const speed = Math.max(1, Math.abs(b.velocity.z));
        approachRing.visible = far > 0.4;
        approachRing.position.set(drawn.x, drawn.y, drawn.z);
        approachRing.quaternion.copy(camera.quaternion);
        // About three ball-widths across at the far end, closing onto the ball.
        approachRing.scale.setScalar(0.7 + 1.1 * Math.min(1, far / 8));
        // Red for the last 150 ms.
        approachMat.color.set(far / speed < 0.15 ? "#ff5a3c" : "#ffe14a");
        approachSeen = true;
      }
      const spin = new T.Vector3(b.spin.x, b.spin.y, b.spin.z);
      if (spin.length() === 0) {
        // Camera throws carry no measured spin. A ball that does not turn looks
        // like it slides, so it is drawn with a thrower's backspin.
        spin.set(b.velocity.z, 0, -b.velocity.x);
        if (spin.length() > 0) spin.setLength(BACKSPIN);
      }
      if (spin.length() > 0)
        m.quaternion.premultiply(
          new T.Quaternion().setFromAxisAngle(
            spin.clone().normalize(),
            spin.length() * dt,
          ),
        );
    }
    if (!approachSeen) approachRing.visible = false;
    // Finished balls: bounce, roll, then shrink away after three seconds.
    const deadNow = performance.now();
    const real =
      Math.min(0.05, Math.max(0, (deadNow - deadClock) / 1000)) *
      Math.max(0.05, Math.min(1, options.rate ?? 1));
    deadClock = deadNow;
    const bounces: number[] = [];
    for (let i = dead.length - 1; i >= 0; i--) {
      const d = dead[i];
      const step = stepDeadBall(d.state, real);
      d.state = step.ball;
      if (step.bounce !== null && step.bounce > 0.8) bounces.push(step.bounce);
      const left = Math.min(1, (3000 - (deadNow - d.born)) / 400);
      if (left <= 0) {
        retire(d);
        dead.splice(i, 1);
        continue;
      }
      set(d.mesh, d.state.position);
      d.mesh.scale.setScalar(left);
      const roll = new T.Vector3(d.state.velocity.z, 0, -d.state.velocity.x);
      if (roll.length() > 0.01)
        d.mesh.quaternion.premultiply(
          new T.Quaternion().setFromAxisAngle(
            roll.clone().normalize(),
            (roll.length() / d.state.radius) * real,
          ),
        );
      if (d.blob) {
        const height = Math.max(0, d.state.position.y - d.state.radius);
        d.blob.position.set(d.state.position.x, 0.012, d.state.position.z);
        d.blob.scale.setScalar((1 + 0.3 * height) * left);
        d.blob.material.opacity = 0.45 * Math.max(0, 1 - height / 3) * left;
      }
    }
    const effectNow = performance.now();
    for (const event of s.events ?? []) {
      if (seenImpacts.has(event.id) || s.time - event.at > 0.7) continue;
      seenImpacts.add(event.id);
      if (seenImpacts.size > 256)
        seenImpacts.delete(seenImpacts.values().next().value!);
      // A ring at the local head's collision distance fills the whole view.
      // Local hits use the HUD edge flash; world rings mark remote/floor contact.
      if (event.kind === "hit" && event.target === viewer) continue;
      if (event.kind === "catch") continue;
      const material = new T.MeshBasicMaterial({
        color: event.kind === "hit" ? "#ffba93" : "#b6edda",
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: T.DoubleSide,
      });
      const mesh = new T.Mesh(impactGeo, material);
      set(mesh, event.position);
      if (event.kind === "floor") {
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0.02;
      } else mesh.quaternion.copy(camera.quaternion);
      scene.add(mesh);
      impacts.set(event.id, { mesh, born: effectNow });
    }
    for (const [id, effect] of impacts) {
      const age = (effectNow - effect.born) / 450;
      if (age >= 1) {
        scene.remove(effect.mesh);
        effect.mesh.material.dispose();
        impacts.delete(id);
      } else {
        effect.mesh.scale.setScalar(0.05 + age * 0.3);
        effect.mesh.material.opacity = 0.8 * (1 - age);
      }
    }
    renderer.render(scene, camera);
    return { bounces };
  }
  return {
    render,
    /**
     * Where a point on the screen falls on the upright plane through a player
     * (across the court at their distance), in that player's own frame; null if
     * the ray misses it. For aiming by touching the screen.
     */
    pointAt(clientX: number, clientY: number, seat: 0 | 1, at: Vec3): Vec3 | null {
      const rect = canvas.getBoundingClientRect();
      const nx = ((clientX - rect.left) / rect.width) * 2 - 1,
        ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
      const ray = new T.Raycaster();
      ray.setFromCamera(new T.Vector2(nx, ny), camera);
      const w = worldPoint(at, seat);
      const plane = new T.Plane(new T.Vector3(0, 0, 1), -w.z);
      const hit = new T.Vector3();
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      return localPoint({ x: hit.x, y: hit.y, z: hit.z }, seat);
    },
    /** Step the picture down on a device that cannot keep up; see quality.ts. */
    setQuality(level: { pixelRatio: number; shadows: boolean }) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, level.pixelRatio));
      sun.castShadow = level.shadows;
    },
    dispose() {
      for (const { line } of trails.values()) line.geometry.dispose();
      for (const { mesh } of impacts.values()) mesh.material.dispose();
      for (const blob of blobs.values()) blob.material.dispose();
      for (const d of dead) d.blob?.material.dispose();
      for (const m of materials) m.dispose();
      for (const g of geometries) g.dispose();
      renderer.dispose();
      scene.clear();
    },
  };
}
