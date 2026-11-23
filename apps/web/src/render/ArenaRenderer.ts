import * as T from 'three';
import { LM, type FighterView } from '@spar/protocol';
import type { DrawArgs, Renderer } from './Renderer';
import { combatDistance, contactReach } from './combatProjection';
import { retargetPose } from './poseRig';
import { synthPose, punchExtension, punchHand, punchShape } from './pose';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const Y = new T.Vector3(0, 1, 0);

export function createArenaRenderer(canvas: HTMLCanvasElement, onUnavailable?: () => void): Renderer {
  const parent = canvas.parentElement!;
  // A separate surface leaves the original canvas available for the 2D fallback.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gl = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  gl.domElement.className = 'arena__surface';
  gl.outputColorSpace = T.SRGBColorSpace;
  gl.toneMapping = T.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.15;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = T.PCFShadowMap;
  const scene = new T.Scene();
  scene.background = new T.Color('#080d12');
  scene.fog = new T.Fog('#080d12', 8, 24);
  const camera = new T.PerspectiveCamera(58, 1, 0.05, 45);
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();
  let resourcesReleased = false;
  const releaseResources = () => {
    if (resourcesReleased) return; resourcesReleased = true;
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    gl.dispose(); gl.forceContextLoss();
  };
  try {
  const geo = <G extends T.BufferGeometry>(g: G) => { geometries.add(g); return g; };
  const mat = (color: string, roughness = .6, metalness = 0) => {
    const m = new T.MeshStandardMaterial({ color, roughness, metalness }); materials.add(m); return m;
  };
  const white = mat('#dde3df'), dark = mat('#131c25'), steel = mat('#75818a', .3, .75);
  const red = mat('#b92730', .32), blue = mat('#1b777f', .34);
  const skin = mat('#ad7860', .76), shorts = mat('#18252c', .83);
  const sphere = geo(new T.SphereGeometry(1, 24, 16));
  const cylinder = geo(new T.CylinderGeometry(1, 1, 1, 12));
  function mesh(g: T.BufferGeometry, m: T.Material, into: T.Object3D = scene) {
    const o = new T.Mesh(g, m); into.add(o); return o;
  }
  function ellipsoid(into: T.Object3D, m: T.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    const o = mesh(sphere, m, into); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.castShadow = true; return o;
  }
  function rod(into: T.Object3D, m: T.Material, a: T.Vector3, b: T.Vector3, radius: number) {
    const o = mesh(cylinder, m, into); placeRod(o, a, b, radius); return o;
  }
  function placeRod(o: T.Mesh, a: T.Vector3, b: T.Vector3, radius: number) {
    o.position.copy(a).add(b).multiplyScalar(.5);
    o.scale.set(radius, a.distanceTo(b), radius);
    o.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize());
  }
  scene.add(new T.HemisphereLight('#b8d8ee', '#28201a', 1.5));
  const key = new T.SpotLight('#fff2df', 70, 24, .8, .7, 1.2);
  key.position.set(-2, 6, 2); key.target.position.set(0, 0, 0); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -.0003;
  scene.add(key, key.target);
  const rim = new T.PointLight('#51c2dd', 35, 14, 1.6); rim.position.set(1.5, 3, -4); scene.add(rim);
  const warm = new T.PointLight('#ef6750', 18, 12, 1.7); warm.position.set(-4, 2, 1); scene.add(warm);

  // Canvas markings are a local texture, with no network asset dependency.
  const textureCanvas = document.createElement('canvas'); textureCanvas.width = textureCanvas.height = 1024;
  const c = textureCanvas.getContext('2d')!;
  c.fillStyle = '#34434a'; c.fillRect(0, 0, 1024, 1024);
  c.strokeStyle = '#708083'; c.lineWidth = 3; c.strokeRect(64, 64, 896, 896);
  c.beginPath(); c.arc(512, 512, 240, 0, Math.PI * 2); c.stroke();
  c.fillStyle = '#aab5af'; c.textAlign = 'center'; c.font = 'italic 900 145px sans-serif'; c.fillText('SPAR', 512, 550);
  c.font = '600 19px sans-serif'; c.fillText('READ THE FIGHT', 512, 590);
  for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#34434a' : '#314047'; c.fillRect(0, i * 128, 26, 128); }
  const texture = new T.CanvasTexture(textureCanvas); texture.colorSpace = T.SRGBColorSpace; textures.add(texture);
  const floorMat = new T.MeshStandardMaterial({ map: texture, roughness: .95 }); materials.add(floorMat);
  const floor = mesh(geo(new T.PlaneGeometry(9, 9)), floorMat); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const apron = mesh(geo(new T.BoxGeometry(9.2, .3, 9.2)), dark); apron.position.y = -.16;
  for (const x of [-4.3, 4.3]) for (const z of [-4.3, 4.3]) {
    rod(scene, steel, new T.Vector3(x, 0, z), new T.Vector3(x, 1.75, z), .055);
    const pad = mesh(geo(new T.BoxGeometry(.19, .85, .19)), x * z > 0 ? red : blue); pad.position.set(x, 1.15, z);
  }
  for (const h of [.55, .88, 1.21, 1.54]) {
    for (const side of [-4.3, 4.3]) {
      rod(scene, h > 1.4 ? white : dark, new T.Vector3(side, h, -4.3), new T.Vector3(side, h, 4.3), .022);
      rod(scene, h > 1.4 ? white : dark, new T.Vector3(-4.3, h, side), new T.Vector3(4.3, h, side), .022);
    }
  }
  // Low-cost arena tiers and ceiling lighting supply stable parallax cues.
  for (let tier = 0; tier < 4; tier++) {
    for (const side of [-1, 1]) {
      const bench = mesh(geo(new T.BoxGeometry(17, .24, .7)), dark);
      bench.position.set(0, .3 + tier * .5, side * (6 + tier * .8));
    }
  }
  const audienceMaterial = mat('#334550', .9);
  const crowdHeads = new T.InstancedMesh(sphere, audienceMaterial, 192);
  const crowdBodies = new T.InstancedMesh(sphere, audienceMaterial, 192);
  scene.add(crowdHeads, crowdBodies);
  const spectator = new T.Object3D();
  for (let i = 0; i < 192; i++) {
    const row = Math.floor(i / 48), side = i % 48 < 24 ? -1 : 1;
    const x = ((i % 24) - 11.5) * .59;
    const z = side * (6.1 + row * .8);
    const y = .83 + row * .5 + Math.sin(i * 31) * .04;
    spectator.position.set(x, y, z); spectator.scale.set(.075, .1, .075); spectator.updateMatrix(); crowdHeads.setMatrixAt(i, spectator.matrix);
    spectator.position.y -= .19; spectator.scale.set(.15, .2, .08); spectator.updateMatrix(); crowdBodies.setMatrixAt(i, spectator.matrix);
  }
  const bannerCanvas = document.createElement('canvas'); bannerCanvas.width = 1024; bannerCanvas.height = 256;
  const bannerContext = bannerCanvas.getContext('2d')!;
  bannerContext.fillStyle = '#102028'; bannerContext.fillRect(0, 0, 1024, 256);
  bannerContext.fillStyle = '#91b4b4'; bannerContext.textAlign = 'center'; bannerContext.font = 'italic 900 125px sans-serif'; bannerContext.fillText('SPAR', 512, 153);
  bannerContext.font = '600 18px sans-serif'; bannerContext.fillText('THE NIGHT SESSION', 512, 205);
  const bannerTexture = new T.CanvasTexture(bannerCanvas); bannerTexture.colorSpace = T.SRGBColorSpace; textures.add(bannerTexture);
  const bannerMaterial = new T.MeshBasicMaterial({ map: bannerTexture }); materials.add(bannerMaterial);
  for (const z of [-8.7, 8.7]) {
    const banner = mesh(geo(new T.PlaneGeometry(5, 1.25)), bannerMaterial); banner.position.set(0, 3.4, z); if (z > 0) banner.rotation.y = Math.PI;
  }
  const luminous = new T.MeshBasicMaterial({ color: '#f4eddb' }); materials.add(luminous);
  for (const x of [-3, 3]) for (const z of [-3, 3]) {
    const lamp = mesh(geo(new T.BoxGeometry(1.5, .04, .22)), luminous); lamp.position.set(x, 4.7, z);
    rod(scene, steel, new T.Vector3(x, 4.8, -5), new T.Vector3(x, 4.8, 5), .035);
  }

  const fighter = new T.Group(); scene.add(fighter);
  const torso = ellipsoid(fighter, skin, 0, 1.22, 0, .245, .34, .145);
  const chest = ellipsoid(fighter, skin, 0, 1.41, .018, .28, .17, .16);
  const hips = ellipsoid(fighter, shorts, 0, .89, 0, .24, .2, .16);
  const waistband = mesh(geo(new T.CylinderGeometry(.235, .225, .065, 24)), white, fighter); waistband.position.y = 1.01; waistband.scale.z = .72;
  const neck = ellipsoid(fighter, skin, 0, 1.51, 0, .072, .1, .07);
  const head = new T.Group(); fighter.add(head);
  ellipsoid(head, skin, 0, 0, 0, .125, .168, .13);
  ellipsoid(head, skin, 0, -.04, .1, .09, .085, .062);
  ellipsoid(head, skin, 0, .008, .139, .025, .033, .033);
  for (const x of [-.048, .048]) {
    ellipsoid(head, dark, x, .04, .119, .026, .01, .009);
    ellipsoid(head, skin, Math.sign(x) * .123, 0, 0, .025, .043, .019);
  }
  // Purposeful sparring headguard, including cheek pads and a crown.
  const headgear = mat('#263940', .55);
  ellipsoid(head, headgear, 0, .125, -.01, .132, .066, .126);
  for (const x of [-.116, .116]) ellipsoid(head, headgear, x, .01, .042, .035, .1, .093);
  const arms = (['L', 'R'] as const).map((hand) => {
    const upper = mesh(cylinder, skin, fighter); upper.castShadow = true;
    const lower = mesh(cylinder, skin, fighter); lower.castShadow = true;
    const elbow = ellipsoid(fighter, skin, 0, 0, 0, .068, .068, .068);
    const shoulder = ellipsoid(fighter, skin, 0, 0, 0, .089, .092, .087);
    const glove = new T.Group(); fighter.add(glove);
    ellipsoid(glove, blue, 0, 0, 0, .102, .122, .145);
    ellipsoid(glove, blue, hand === 'L' ? -.075 : .075, -.028, .025, .042, .067, .074);
    const cuff = mesh(geo(new T.CylinderGeometry(.085, .072, .1, 16)), white, glove); cuff.position.y = -.105;
    return { hand, upper, lower, glove, elbow, shoulder };
  });
  const legs = [-1, 1].map((side) => {
    const upper = mesh(cylinder, shorts, fighter), lower = mesh(cylinder, skin, fighter);
    const boot = ellipsoid(fighter, dark, side * .17, .08, .06, .093, .08, .18);
    return { side, upper, lower, boot };
  });
  const hands = new T.Group(); camera.add(hands); scene.add(camera);
  const ownGloves = [-1, 1].map((side) => {
    const group = new T.Group(); hands.add(group);
    ellipsoid(group, red, 0, 0, 0, .1, .125, .145);
    ellipsoid(group, red, -side * .072, -.018, -.025, .042, .07, .075);
    const cuff = mesh(geo(new T.CylinderGeometry(.075, .065, .12, 16)), white, group); cuff.position.y = -.125;
    const forearm = mesh(geo(new T.CylinderGeometry(.064, .083, .44, 16)), skin, group); forearm.position.set(side * .015, -.33, .07); forearm.rotation.x = -.3;
    // View-model gloves stay readable under all arena lighting directions.
    return { side, group };
  });

  const hud = document.createElement('div'); hud.className = 'arena__hud';
  hud.innerHTML = `<div class="arena__top"><div class="arena__fighter"><span data-you>YOU</span><div class="arena__meter"><i data-hp-you></i></div><div class="arena__energy"><i data-stamina-you></i></div></div><div class="arena__clock"><small data-round></small><strong data-clock></strong></div><div class="arena__fighter arena__fighter--opponent"><span data-them>OPPONENT</span><div class="arena__meter"><i data-hp-them></i></div><div class="arena__energy"><i data-stamina-them></i></div></div></div><div class="arena__callout" role="status"><small data-state-label></small><strong data-state></strong><span data-state-help></span></div><div class="arena__impact" data-impact></div><div class="arena__bottom"><div><small>DISTANCE</small><strong data-distance></strong></div><div class="arena__movement"><small data-tracking></small><strong data-move></strong></div><div><small>MATCH HITS</small><strong data-hits></strong></div></div>`;
  const q = (s: string) => hud.querySelector<HTMLElement>(`[data-${s}]`)!;
  const elements = Object.fromEntries(['you','them','hp-you','hp-them','stamina-you','stamina-them','round','clock','state-label','state','state-help','impact','distance','tracking','move','hits'].map(k => [k, q(k)]));
  const text = (k: string, s: string) => { if (elements[k].textContent !== s) elements[k].textContent = s; };
  
  let width = 0, height = 0, last = 0, angle = 0, targetAngle = 0, distance = 2.55, hitAt = -10000, flashAt = -10000;
  let lastHud = -1000, disposed = false, contextLost = false;
  const loseContext = (e: Event) => { e.preventDefault(); contextLost = true; text('state', 'Graphics paused'); text('state-help', 'Restoring the arena…'); queueMicrotask(() => { if (!disposed) onUnavailable?.(); }); };
  const restoreContext = () => { contextLost = false; lastHud = -1000; };
  gl.domElement.addEventListener('webglcontextlost', loseContext);
  gl.domElement.addEventListener('webglcontextrestored', restoreContext);
  function resize() {
    const w = Math.max(1, parent.clientWidth), h = Math.max(1, parent.clientHeight);
    if (width === w && height === h) return;
    width = w; height = h;
    gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); gl.setSize(w, h, false);
    camera.aspect = w / h; camera.fov = w < h ? 72 : 58; camera.updateProjectionMatrix();
  }
  let observer: ResizeObserver | undefined;
  try {
    resize();
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(resize); observer.observe(parent); }
    window.addEventListener('resize', resize);
    parent.append(gl.domElement, hud); canvas.style.display = 'none';
  } catch (error) {
    observer?.disconnect(); window.removeEventListener('resize', resize);
    disposed = true; releaseResources(); gl.domElement.remove(); hud.remove(); canvas.style.display = ''; throw error;
  }

  function draw(a: DrawArgs) {
    if (disposed || contextLost) return;
    const dt = last ? clamp(a.nowMs - last, 0, 100) : 16; last = a.nowMs;
    const blend = 1 - Math.exp(-dt / 85);
    const me = a.view.fighters[a.localPlayer], them = a.view.fighters[1 - a.localPlayer];
    for (const e of a.events) {
      if (e.kind === 'STEP' && (e.detail === 'L' || e.detail === 'R')) targetAngle += (e.detail === 'L' ? -.16 : .16) * (e.who === a.localPlayer ? 1 : -1);
      if (e.kind === 'HIT') { if (e.who !== a.localPlayer) flashAt = a.nowMs; else hitAt = a.nowMs; }
      if (['HIT','BLOCK','EVADE','COUNTER','MISS'].includes(e.kind)) {
        text('impact', e.kind === 'HIT' ? (e.who === a.localPlayer ? 'LANDED' : 'HIT TAKEN') : e.kind);
        elements.impact.dataset.at = String(a.nowMs);
      }
    }
    angle += (targetAngle - angle) * blend;
    distance += (combatDistance(a.view.range) - distance) * blend;
    const ownRig = retargetPose(a.localPose);
    const liveHead = ownRig?.points[LM.NOSE];
    const slip = me.head === 'SLIP_L' ? -.23 : me.head === 'SLIP_R' ? .23 : liveHead ? clamp(-liveHead.x, -.2, .2) : 0;
    const eye = me.phase === 'KNOCKDOWN' ? .45 : me.head === 'DUCK' ? 1.17 : 1.66;
    const forward = new T.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const right = new T.Vector3(Math.cos(angle), 0, -Math.sin(angle));
    const cameraTarget = forward.clone().multiplyScalar(distance).addScaledVector(right, slip);
    cameraTarget.y = eye;
    camera.position.lerp(cameraTarget, blend);
    camera.lookAt(right.x * slip, eye - .04, right.z * slip);
    if (!reducedMotion.matches) camera.rotateZ(me.phase === 'KNOCKDOWN' ? -.42 : -slip * .08);
    fighter.rotation.y = angle;
    fighter.rotation.z += ((them.phase === 'KNOCKDOWN' ? 1.35 : 0) - fighter.rotation.z) * blend;
    fighter.position.y += ((them.phase === 'KNOCKDOWN' ? -.35 : 0) - fighter.position.y) * blend;
    const p = synthPose(them, a.nowMs);
    // A late pose packet must never hide an authoritative punch or knockdown.
    const live = them.phase === 'IDLE' && them.head === 'CENTER' && !them.guardHigh ? retargetPose(a.opponentPose) : null;
    const point = (i: number) => {
      const q = live?.points[i];
      return q ? new T.Vector3(q.x, q.y, q.z) : new T.Vector3((p[i].x - .5) * 1.75, (1.3 - p[i].y) * 1.58, -p[i].z * .65);
    };
    const shoulderMid = point(LM.L_SHOULDER).add(point(LM.R_SHOULDER)).multiplyScalar(.5);
    torso.position.x = shoulderMid.x * .5; chest.position.copy(shoulderMid); chest.position.y -= .015;
    head.position.lerp(point(LM.NOSE), blend); head.position.z = live ? clamp(head.position.z, -.2, .3) : .018;
    neck.position.set(head.position.x * .6, head.position.y - .14, head.position.z * .5);
    head.rotation.x = reducedMotion.matches ? 0 : Math.max(0, 1 - (a.nowMs - hitAt) / 220) * -.25;
    hips.position.y = .85;
    for (const arm of arms) {
      const left = arm.hand === 'L';
      const s = point(left ? LM.L_SHOULDER : LM.R_SHOULDER), e = point(left ? LM.L_ELBOW : LM.R_ELBOW), w = point(left ? LM.L_WRIST : LM.R_WRIST);
      if (them.punch && punchHand(them.punch, them.stance) === arm.hand) {
        const shift = punchExtension(them) * (contactReach(them, true) - (punchShape(them.punch) === 'straight' ? 1.3 : .9) * .65);
        w.z += shift; e.z += shift * .5;
      }
      if (live) arm.glove.position.lerp(w, blend); else arm.glove.position.copy(w);
      placeRod(arm.upper, s, e, .075); placeRod(arm.lower, e, arm.glove.position, .058);
      arm.elbow.position.copy(e); arm.shoulder.position.copy(s);
      arm.glove.rotation.x = -.22;
    }
    for (const leg of legs) {
      const hip = new T.Vector3(leg.side * .13, .85, 0), knee = new T.Vector3(leg.side * .2, .44, leg.side * .09), ankle = new T.Vector3(leg.side * .21, .1, leg.side * .15);
      placeRod(leg.upper, hip, knee, .105); placeRod(leg.lower, knee, ankle, .066); leg.boot.position.copy(ankle); leg.boot.position.y = .065;
    }
    const ext = punchExtension(me), active = punchHand(me.punch, me.stance);
    for (const hand of ownGloves) {
      const which = hand.side < 0 ? 'L' : 'R'; const e = active === which ? ext : 0;
      const shape = me.punch ? punchShape(me.punch) : 'straight';
      const x = hand.side * (me.guardHigh ? .19 : .26);
      const y = me.guardHigh ? -.13 : -.33;
      const arc = Math.sin(e * Math.PI);
      hand.group.position.set(x * (1 - e * .75) + (shape === 'hook' ? hand.side * .3 * arc : 0), y + e * (me.body ? -.13 : .11) - (shape === 'upper' ? .24 * arc : 0), -.45 - e * (contactReach(me) - .45));
      if (me.phase === 'IDLE') {
        const wrist = ownRig?.points[hand.side < 0 ? LM.L_WRIST : LM.R_WRIST];
        if (wrist) hand.group.position.set(clamp(-wrist.x * .7, -.42, .42), clamp((wrist.y - 1.6) * .65, -.48, .12), clamp(-.35 - wrist.z * .65, -.9, -.3));
      }
      hand.group.rotation.set(-e * .5, -hand.side * e * .3, hand.side * -.13);
      hand.group.visible = me.phase !== 'KNOCKDOWN';
    }
    hud.style.setProperty('--damage', String(Math.max(0, 1 - (a.nowMs - flashAt) / 350) * .5));
    elements.impact.style.opacity = String(clamp(1 - (a.nowMs - Number(elements.impact.dataset.at ?? -10000)) / 800, 0, 1));
    if (a.nowMs - lastHud > 80) { updateHud(a, me, them); lastHud = a.nowMs; }
    gl.render(scene, camera);
  }
  function updateHud(a: DrawArgs, me: FighterView, them: FighterView) {
    text('you', a.names?.local ?? 'YOU'); text('them', a.names?.opponent ?? 'OPPONENT');
    for (const [side, f] of [['you', me], ['them', them]] as const) {
      elements[`hp-${side}`].style.transform = `scaleX(${clamp(f.hp / 1000, 0, 1)})`;
      elements[`stamina-${side}`].style.transform = `scaleX(${clamp(f.stamina / 1000, 0, 1)})`;
      for (const [key, label, value] of [[`hp-${side}`, 'Health', f.hp], [`stamina-${side}`, 'Stamina', f.stamina]] as const) {
        const bar = elements[key]; bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', `${side === 'you' ? 'Your' : 'Opponent'} ${label}`); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '1000'); bar.setAttribute('aria-valuenow', String(value));
      }
    }
    text('round', `ROUND ${a.view.round} / 3`); text('clock', `${Math.floor(a.view.clockSec / 60)}:${String(a.view.clockSec % 60).padStart(2, '0')}`);
    text('distance', a.view.range < 400 ? 'IN CLOSE' : a.view.range > 700 ? 'OUTSIDE' : 'IN RANGE');
    text('hits', `${me.landed} / ${them.landed}`);
    text('tracking', retargetPose(a.localPose) ? 'CAMERA CONNECTED' : a.inputKind === 'camera' ? 'REACQUIRING YOU' : 'KEYBOARD');
    text('move', me.phase === 'STUNNED' ? 'Recover your guard' : me.head !== 'CENTER' ? me.head.replace('_', ' ') : me.guardHigh ? 'GUARD HIGH' : 'GUARD LOW');
    let title = '', label = '', help = '';
    if (a.stalled) { title = 'SYNCING'; help = 'Waiting for your opponent'; }
    else if (a.view.state === 'INTRO') { title = 'GET READY'; label = `ROUND ${a.view.round}`; help = 'Hands up. Find your distance.'; }
    else if (a.view.state === 'REST') { title = 'BREATHE'; label = 'BACK TO YOUR CORNER'; help = 'The next round starts shortly'; }
    else if (a.view.state === 'OVER') { title = a.view.winner === 'DRAW' ? 'DRAW' : a.view.winner === a.localPlayer ? 'YOU WIN' : 'YOU LOSE'; label = a.view.method ?? 'MATCH COMPLETE'; }
    else if (me.phase === 'KNOCKDOWN' || them.phase === 'KNOCKDOWN') {
      const f = me.phase === 'KNOCKDOWN' ? me : them;
      title = String(clamp(Math.floor((600 - f.phaseFrames) / 60) + 1, 1, 10));
      help = f === me ? 'Raise both hands above your head · or press G' : 'Opponent is down';
    }
    text('state', title); text('state-label', label); text('state-help', help);
  }
  return { canvas, draw, resize, dispose() {
    if (disposed) return; disposed = true; observer?.disconnect(); window.removeEventListener('resize', resize);
    gl.domElement.removeEventListener('webglcontextlost', loseContext); gl.domElement.removeEventListener('webglcontextrestored', restoreContext);
    releaseResources(); gl.domElement.remove(); hud.remove(); canvas.style.display = '';
  } };
  } catch (error) {
    releaseResources(); gl.domElement.remove(); throw error;
  }
}
