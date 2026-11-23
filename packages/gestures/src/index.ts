/**
 * @spar/gestures — pose landmark stream → boxing actions.
 *
 *   const cal = calibrate(frames);                 // or defaultCalibration()
 *   const engine = createGestureEngine(cal);
 *   engine.push(frame);                            // per camera frame → ActionEvent[]
 *   const bits = engine.sampleInput();             // per sim tick → InputBits
 */
export { OneEuro, OneEuroPoint, type OneEuroParams } from './oneEuro';
export { toBodyFrame, angleDeg, dist3, type BodyFrame, type Vec3 } from './bodyFrame';
export { calibrate, defaultCalibration, DEFAULT_ARM_LEN, type Calibration } from './calibration';
export { DEFAULTS, mergeOptions, type GestureOptions, type DeepPartial } from './defaults';
export {
  createGestureEngine,
  type GestureEngine, type GestureDebug, type HandDebug, type Hand, type HandState, type HeadState,
} from './engine';
export { framesToInputs } from './offline';
export { createAutomaticGestureEngine, type AutomaticGestureEngine, type TrackingStatus } from './automatic';
export { evaluateActions, type ExpectedActionSegment, type ActionClassMetrics, type ActionMatch, type ActionEvaluation } from './evaluation';
export * as synth from './synth';
