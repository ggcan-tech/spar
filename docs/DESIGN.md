# SPAR — build spec (v0.1, 2026-09-06)

Working title **SPAR**: real shadow boxing in front of a webcam, computer vision turns your body
into fighting-game inputs, you fight a real human online. Web first (desktop Chrome/Safari).

Full founder brief lives in the Claude artifact "SPAR Master Plan". This file is the *build* spec:
the numbers every package must agree on. `packages/protocol/src/index.ts` is the code contract.

## Architecture (one sentence each)
- **Camera → Pose**: MediaPipe Pose Landmarker (tasks-vision, GPU delegate), 33 landmarks, ≥25 fps.
- **Pose → Actions** (`@spar/gestures`): One-Euro smoothing, body-frame normalization, per-hand punch state
  machine with early-fire, held states for guard/head, impulse steps. Output = `InputBits` per sim tick.
- **Sim** (`@spar/sim`): deterministic 60 Hz fighting sim, integer math, immutable state, inputs are 16-bit
  fields. Same package runs in browser and on the server (replay verification).
- **Netcode** (`@spar/netcode`): P2P rollback over an abstract `Transport` (WebRTC DataChannel in the app).
  2-frame input delay, up to 8 frames rollback, redundant inputs (last 8 frames per packet), GGPO-style time sync.
- **Signal** (`apps/signal`): WebSocket queue + pairing + SDP/ICE relay + result submission → replay verify → ratings.
- **Web** (`apps/web`): React shell + Canvas 2D renderer (opponent is a neon *shadow* driven by their landmarks),
  HUD, FX, WebAudio sounds, keyboard fallback input (dev/testing without camera).

## Sim numbers (frames @ 60 Hz)
Fighter: hp 1000, stamina 1000, guard HIGH/LOW, head CENTER/SLIP_L/SLIP_R/DUCK, phase, counterWindow, stance.
Match: range 200..1000 (start 600), 3 rounds × 60 s, 20 s rest, INTRO 120 frames before each round.

| Punch | Startup | Active | Recovery | Damage | Stamina | Max range | vs HIGH guard (blocked %) |
|---|---|---|---|---|---|---|---|
| JAB | 3 | 2 | 6 | 40 | 25 | 700 | 85 |
| CROSS | 5 | 2 | 9 | 80 | 45 | 650 | 85 |
| LEAD_HOOK | 6 | 3 | 10 | 90 | 50 | 500 | 50 |
| REAR_HOOK | 7 | 3 | 12 | 110 | 60 | 500 | 50 |
| LEAD_UPPER | 7 | 3 | 12 | 100 | 55 | 400 | 40 |
| REAR_UPPER | 7 | 3 | 12 | 120 | 60 | 400 | 40 |
| BODY modifier | +0 | +0 | +1 | ×0.8 | same | −50 | ignores HIGH guard; drains target stamina 2× damage |

Blocked = damage × (100 − blocked%) / 100 goes through as chip damage.

Resolution happens on the first ACTIVE frame of a punch, against the target's state at that frame:
- Range check: if range > punch max range → MISS (whiff). If range < 300 ("inside"): straights (JAB/CROSS) ×0.5; hooks/uppers full.
- Target head SLIP_L or SLIP_R vs straight (JAB/CROSS, head) → EVADE, target gets counterWindow = 12.
  - Slip vs hook: if the hook comes toward the slipped side → HIT ×1.5. Rule: LEAD_HOOK punishes SLIP_R of the target, REAR_HOOK punishes SLIP_L (attacker's lead hook travels across to the target's right side when both orthodox; keep it this simple regardless of stance).
- Target DUCK vs straight or hook (head) → EVADE, counterWindow = 12, but ducking costs stamina 30 on entry and has 18 frames of recovery (a `duckRecovery` counter during which the head can't be re-ducked... keep simple: entering DUCK costs 30 stamina; leaving DUCK is free).
  - DUCK vs any UPPER (head) → HIT ×2.0 ("ducked into it").
- Target GUARD_HIGH (and head CENTER) vs head punch → BLOCK with chip damage per table.
- Body punches: ignore HIGH guard (full damage) and additionally reduce target stamina by 2×damage. If target guard is LOW (wrists down), body punches are BLOCKED 70%.
- Target phase STUNNED → HIT ×1.5. Target KNOCKDOWN → punch is ignored (no damage).
- Attacker counterWindow > 0 at ACTIVE → damage ×1.5, emit COUNTER.
- Landed HIT pushes range +40.

Stamina: punch costs on STARTUP entry. Regen per frame: +1 while IDLE and guard LOW (=60/s), +0.5/frame (use +1 every other frame) while GUARD_HIGH, 0 during punch/stun/knockdown. Below 300: startup +2, damage ×0.7, guard forced LOW ("hands drop"). Stamina never < 0.

Stun: rolling 120-frame damage window ≥ 250 → STUNNED 30 frames (cannot punch, guard forced LOW). Window resets after stun.

Knockdown: hp ≤ 0 → KNOCKDOWN; a 600-frame (10 s) count starts; GET_UP impulse ends it with hp = 300, stamina = max(stamina, 400). No GET_UP in time → KO. Third knockdown in a round → TKO. Emit KNOCKDOWN / GET_UP / MATCH_END.

Range: STEP_IN −150, STEP_OUT +150 (each step has a 20-frame cooldown per fighter), landed hit +40, drift toward 600 by 1 unit per frame when |range−600| > 0 (~50/s), clamp [200, 1000]. STEP_L / STEP_R: cosmetic lateral dodge = acts like a half-slip for 10 frames (evades straights only, no counter window) — also gives the renderer an event.

Punch input rules: a punch bit is accepted only when phase is IDLE (or RECOVERY with ≤2 frames left = "cancel window"). Simultaneous bits: priority JAB > CROSS > LEAD_HOOK > REAR_HOOK > LEAD_UPPER > REAR_UPPER. BODY bit modifies that punch. Head state comes directly from held bits each frame (SLIP_L > SLIP_R > DUCK priority), except during STUNNED/KNOCKDOWN (forced CENTER). Guard from GUARD_HIGH bit unless forced LOW.

Rounds and judging: at ROUND_END compute 10-point-must. score = Σ landed×weight (straight 1.0, hook 1.4, upper 1.5, body 1.2, counter ×1.5) + evades×0.5 + knockdowns×10 (as an integer ×10 to stay integer). Higher gets 10, other 9; 8 if they were knocked down at least once and lost the round; tie → 10-10. After round 3: sum → DECISION or DRAW. Clock counts frames; emit BELL at round start/end.

Hash: FNV-1a 32-bit over the serialized integer fields, in a fixed order. Provide `replay(seed, log)`.

Bot (`@spar/sim` exports `createBot(seed, difficulty)`): a deterministic policy `(view, player) => InputBits` using a seeded xorshift RNG. Behaviour: keeps guard high ~70% of the time, steps in when range > 650, jabs at range ≤ 700, throws 2–3 punch combos, slips ~30% of incoming straights (it sees the opponent's STARTUP phase), ducks hooks ~30%, backs off when stamina < 350. Difficulty scales reaction chance.

## Gesture numbers
Landmarks in body frame: origin = mid-shoulder, unit = shoulder width, rotated so shoulders are horizontal. Camera is NOT mirrored in data (image x grows to the person's left when they face the camera). "lead" hand = left for orthodox, right for southpaw.

- One-Euro filter per landmark: minCutoff 1.5 Hz, beta 0.05, dCutoff 1.0 (tuned for punches; not Kalman).
- Calibration (`calibrate(frames)` over ~2 s of guard stance + arm extension): armLen per hand (max wrist–shoulder distance seen), shoulderW baseline in image px-normalized units (for STEP_IN/OUT), chin box (nose y + 0.25 units, ±0.6 units wide).
- Punch state machine per hand: extension e = |wrist − shoulder| / armLen (body-frame units); radial velocity ė (units/s, from filtered e).
  - EXTENDING when ė > 3.0 /s and e > 0.45. EARLY FIRE when e ≥ 0.65 and ė > 4.0 → emit with `early: true`, confidence 0.8.
  - PEAK when e ≥ 0.80 and ė crosses ≤ 0 → emit (if not already fired early) with confidence 0.95; if fired early, upgrade nothing (one event per extension).
  - Classification at fire time: elbow angle > 150° and lateral wrist travel < 0.35 units → straight (JAB lead / CROSS rear). Elbow angle 60–140° and wrist crossed the body midline or lateral travel ≥ 0.35 → HOOK. Wrist vertical velocity < −2.5 /s (upward; image y grows downward) with elbow bent and wrist ending above shoulder line → UPPER. Fallback: straight.
  - BODY flag if wrist y at fire time is below the shoulder line by > 0.25 units.
  - Min 120 ms between events of the same hand; if both hands fire within 60 ms keep the higher confidence.
- Head: nose x offset from mid-shoulder > +0.35 units → SLIP toward that side (enter), < 0.20 → CENTER (exit; hysteresis). Which side is "L": the fighter's own left = image +x when facing camera. Nose y drop > 0.35 units below calibrated neutral AND knee angle < 160° → DUCK.
- Guard: both wrists inside chin box → GUARD_HIGH; else GUARD_LOW. Debounce 100 ms.
- Steps: hip center x (image, in shoulderW units) moves > 0.6 within 400 ms → STEP_L/R; then the return move within 600 ms is ignored (recenter forgiveness). Shoulder px width ratio vs baseline > 1.12 → STEP_IN, < 0.89 → STEP_OUT (per-step 500 ms cooldown, hysteresis back to 1.0 ± 0.04).
- GET_UP: both wrists above nose for 300 ms.
- Engine exposes `push(frame) → ActionEvent[]`, `held()`, `drainImpulses()`, `sampleInput()`, `stance()`.

## Netcode numbers
60 Hz, input delay 2 frames, max rollback 8 frames. Each packet carries the last 8 frames of local inputs
(frame number + 8×uint16) plus ack of last received remote frame, plus timing for RTT. If the remote is
more than 8 frames behind (no inputs), stall (`stalled: true`) rather than predict further. Time sync:
if local is > 1.5 frames ahead of remote on average, skip one tick every 30 frames. Prediction uses
`predictInput(lastRemote)`. Confirmed frame = min(local, remote) frames with real inputs. Input log = confirmed inputs.

## Web app screens
Home → Dojo (camera setup, calibration, "throw a jab/cross/…" call & response, recognized-action ticker, fps/latency panel, recorder) → Fight vs Bot → Online (queue, match, fight, result) → Result (stats).
Keyboard fallback (when camera off or key pressed): J=JAB, K=CROSS, U=LEAD_HOOK, I=REAR_HOOK, N=LEAD_UPPER, M=REAR_UPPER, B (hold)=BODY, A/D (hold)=SLIP_L/R, S (hold)=DUCK, Space (hold)=GUARD_HIGH, W=STEP_IN, X=STEP_OUT, Q/E=STEP_L/R, G=GET_UP.
