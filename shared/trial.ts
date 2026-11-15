// The lab's test throw: launched from a platform in still air with no steering, nothing in the way
// but the floor. The same design and launch always fly the same way, so designs can be compared.
import { sweepContact } from './contact'
import {
  aeroForces,
  buildPlane,
  D2R,
  launchState,
  type Quat,
  qrot,
  qrotInv,
  type State,
  step,
  type Vec3,
} from './plane'

export const TRIAL = Object.freeze({
  height: 10, // metres
  speed: 7, // m/s
  pitch: 0, // degrees, nose up
  duration: 30, // seconds before it counts as still flying
  dt: 0.001,
})
const SAMPLE_HZ = 60 // path points per second, enough to replay smoothly

export interface Launch {
  speed: number
  pitch: number
}
export interface PathPoint {
  t: number
  p: Vec3
  q: Quat
  v: Vec3 // velocity
  f: Vec3 // air force on the plane, world frame (newtons)
}
const sample = (t: number, s: State, model: ReturnType<typeof buildPlane>) => ({
  t,
  p: [...s.p] as Vec3,
  q: [...s.q] as Quat,
  v: [...s.v] as Vec3,
  f: qrot(s.q, aeroForces(s, model).bodyForce),
})

export type Trial = ReturnType<typeof flyTrial>

export function flyTrial(design: unknown, launch: Partial<Launch> = {}) {
  const { speed = TRIAL.speed, pitch = TRIAL.pitch } = launch
  const model = buildPlane(design),
    s = launchState([0, TRIAL.height, 0], 0, pitch * D2R, speed)
  const path: PathPoint[] = [sample(0, s, model)]
  let time = 0,
    pitchSum = 0,
    samples = 0,
    top: number = TRIAL.height,
    slowest = speed,
    fastest = speed,
    outcome: 'landed' | 'time limit' = 'time limit'
  for (let n = 0; n < TRIAL.duration / TRIAL.dt; n++) {
    const before: { p: Vec3; q: Quat } = { p: [...s.p], q: [...s.q] }
    step(s, model, TRIAL.dt)
    if (![...s.p, ...s.v, ...s.q, ...s.w].every(Number.isFinite))
      throw new Error('This design produced an unstable simulation.')
    const hit = sweepContact(before, s, model.contacts, [])
    time = (n + 1) * TRIAL.dt
    pitchSum += s.w[2] ** 2
    samples++
    const v = Math.hypot(...s.v)
    top = Math.max(top, s.p[1])
    slowest = Math.min(slowest, v)
    fastest = Math.max(fastest, v)
    if (hit) {
      s.p = before.p.map((v, i) => v + hit.t * (s.p[i] - v)) as Vec3
      time -= (1 - hit.t) * TRIAL.dt
      outcome = 'landed'
    }
    if (
      hit ||
      Math.floor(time * SAMPLE_HZ) > Math.floor((time - TRIAL.dt) * SAMPLE_HZ)
    )
      path.push(sample(time, s, model))
    if (hit) break
  }
  const distance = Math.hypot(s.p[0], s.p[2])
  return {
    outcome,
    distance,
    time,
    lateral: s.p[2], // > 0: drifted right
    glide: outcome === 'landed' ? distance / TRIAL.height : null, // metres forward per metre of height
    top,
    slowest,
    fastest,
    pitchRate: (Math.sqrt(pitchSum / samples) * 180) / Math.PI, // RMS, degrees per second: wobble
    mass: model.mass,
    path,
  }
}

// What the lab shows for one moment of a run. Angles in degrees; forces in newtons.
export function telemetry(pt: PathPoint) {
  const speed = Math.hypot(...pt.v),
    dir = pt.v.map((x) => x / (speed || 1)),
    along =
      pt.f[0] * (dir[0] ?? 0) +
      pt.f[1] * (dir[1] ?? 0) +
      pt.f[2] * (dir[2] ?? 0)
  const air = qrotInv(pt.q, pt.v), // the plane's velocity in its own frame
    nose = qrot(pt.q, [1, 0, 0]),
    right = qrot(pt.q, [0, 0, 1])
  const drag = -along,
    lift = Math.hypot(...pt.f.map((x, i) => x - along * (dir[i] ?? 0)))
  const deg = (r: number) => (r * 180) / Math.PI
  return {
    speed,
    sink: -pt.v[1], // m/s downwards
    height: pt.p[1],
    distance: Math.hypot(pt.p[0], pt.p[2]),
    aoa: deg(Math.atan2(-air[1], air[0])), // angle of attack: > 0 when the nose is above the flight path
    pitch: deg(Math.asin(Math.max(-1, Math.min(1, nose[1])))),
    bank: deg(Math.asin(Math.max(-1, Math.min(1, -right[1])))), // > 0: right wing down
    lift,
    drag,
    ld: drag > 1e-6 ? lift / drag : null,
  }
}
