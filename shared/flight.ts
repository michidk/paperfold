// One flight, stepped identically by the thrower's browser (instant feedback) and the server (authority).

import { resolveContact, sweepContact } from './contact'
import {
  buildPlane,
  D2R,
  G,
  type PlaneModel,
  type Quat,
  qrot,
  qrotInv,
  type State,
  step,
  type Vec3,
} from './plane'
import { MOVER_TOP, moversAt } from './traffic'
import { CITY, windAt } from './world'

export const DT = 0.001 // fixed substep; both sides count steps, so inputs line up exactly

// Steering. Bending the paper's flaps turned some designs the wrong way, so the controls apply torque
// straight to the plane, but only as much as airspeed allows (it grows with speed squared, like any
// control surface), so a slow or stalling plane barely answers. Left/right banks the plane up to
// MAX_BANK and turns its nose with the bank; up/down asks for a pitch rate. An axis without input gets
// no torque, so hands-off flight is the plain physics.
export const MAX_BANK = 40 * D2R,
  PITCH_RATE = 1.6 // rad/s at full stick
const ROLL_RATE = 2.5, // rad/s, the fastest it rolls into a bank
  BANK_GAIN = 4, // 1/s: roll rate per radian of bank still missing
  RATE_GAIN = 80, // 1/s: how firmly the plane is pushed towards the wanted rates
  MAX_ACCEL = 200, // rad/s² at REF_SPEED and above
  REF_SPEED = 7

// Body-frame steering torque for input pitch (+1 pulls up) and roll (+1 banks right).
export function steerTorque(
  s: State,
  model: PlaneModel,
  pitch: number,
  roll: number,
): Vec3 {
  if (!pitch && !roll) return [0, 0, 0]
  const speed = Math.hypot(...s.v),
    authority = MAX_ACCEL * Math.min(1, (speed / REF_SPEED) ** 2)
  const want: (number | null)[] = [
    null,
    null,
    pitch ? pitch * PITCH_RATE : null,
  ]
  if (roll) {
    const bank = Math.asin(Math.max(-1, Math.min(1, -qrot(s.q, [0, 0, 1])[1]))) // > 0: right wing down
    // A coordinated turn: heading changes at g·tan(bank)/v, to the right (towards +z) when banked right.
    // Banked, that rotation is partly yaw and partly pitch for the plane, so it asks for both.
    const turn = qrotInv(s.q, [
      0,
      (-G * Math.tan(bank)) / Math.max(speed, 2),
      0,
    ])
    const rate = BANK_GAIN * (roll * MAX_BANK - bank)
    want[0] = Math.max(-ROLL_RATE, Math.min(ROLL_RATE, rate))
    want[1] = turn[1]
    want[2] = (want[2] ?? 0) + turn[2]
  }
  return want.map((rate, i) => {
    if (rate === null) return 0
    const accel = RATE_GAIN * (rate - s.w[i])
    return model.inertia[i] * Math.max(-authority, Math.min(authority, accel))
  }) as Vec3
}

export interface Landing {
  y: number
  where: 'street' | 'tree' | 'tower' | 'roof' | 'car' | 'person'
}
// One recorded steering change: from step `at`, pitch p and roll r.
export interface Input {
  at: number
  p: number
  r: number
}
// The server's state of a flight at step n, with its steering s.
export interface ServerState extends State {
  n: number
  s: [number, number]
}

export const cloneState = (s: State): State => ({
  p: [...s.p],
  q: [...s.q],
  v: [...s.v],
  w: [...s.w],
})

export class Flight {
  design: unknown
  t0: number
  s: State
  n: number
  steer: [number, number]
  model: PlaneModel
  landing: Landing | null

  // t0: world time (worldTime) when the flight started, so the wind matches on every machine.
  constructor(design: unknown, state: State, n = 0, t0 = 0) {
    this.design = design
    this.t0 = t0
    this.s = cloneState(state)
    this.n = n // steps simulated so far
    this.steer = [0, 0]
    this.model = buildPlane(design)
    this.landing = null // { y, where } once it touches down
  }

  setSteer(pitch: number, roll: number) {
    if (pitch === this.steer[0] && roll === this.steer[1]) return
    this.steer = [pitch, roll]
  }

  advance() {
    if (this.landing) return this.landing
    const s = this.s
    const before: { p: Vec3; q: Quat } = { p: [...s.p], q: [...s.q] }
    step(
      s,
      this.model,
      DT,
      windAt(s.p, this.t0 + this.n * DT),
      steerTorque(s, this.model, this.steer[0], this.steer[1]),
    )
    this.n++
    const t = this.t0 + this.n * DT
    // Cars and people only matter near the ground, so the sky stays cheap to simulate.
    const low = Math.min(before.p[1], s.p[1]) < MOVER_TOP + 0.5
    const hit = sweepContact(
      before,
      s,
      this.model.contacts,
      low ? [...CITY.solids, ...moversAt(t)] : CITY.solids,
    )
    if (hit) {
      s.p = before.p.map(
        (v, i) => v + hit.t * (s.p[i] - v) + hit.normal[i] * 0.0001,
      ) as Vec3
      s.q = before.q.map((v, i) => v + hit.t * (s.q[i] - v)) as Quat
      const length = Math.hypot(...s.q)
      s.q = s.q.map((v) => v / length) as Quat
      if (hit.normal[1] > 0) {
        const box = hit.box,
          kind = box && 'kind' in box ? (box.kind as 'car' | 'person') : null
        this.landing = {
          y: kind ? 0 : (box?.y1 ?? 0), // off a car or someone's head, it slides down to the street
          where:
            kind ??
            (!box
              ? 'street'
              : box.tree
                ? 'tree'
                : box.tower
                  ? 'tower'
                  : 'roof'),
        }
      } else resolveContact(s, this.model, hit)
    }
    return this.landing
  }
}

// The thrower's copy: runs ahead of the server, remembers recent states and its own inputs so it can
// rewind to an authoritative server state and replay when they disagree.
const HIST_STEPS = 3000,
  DRIFT_M = 0.01
export class PredictedFlight {
  sim: Flight
  hist: Map<number, State>
  inputs: Input[]

  constructor(design: unknown, state: State, t0 = 0) {
    this.sim = new Flight(design, state, 0, t0)
    this.hist = new Map() // step -> state before that step
    this.inputs = [] // { at, p, r } in step order
  }

  // Step up to `target`; a new steer applies from the current step. onInput(input) lets the caller send it.
  stepTo(
    target: number,
    steer: readonly number[],
    onInput?: (input: Input) => void,
  ) {
    const sim = this.sim
    while (sim.n < target && !sim.landing) {
      if (steer[0] !== sim.steer[0] || steer[1] !== sim.steer[1]) {
        sim.setSteer(steer[0], steer[1])
        const input = { at: sim.n, p: steer[0], r: steer[1] }
        this.inputs.push(input)
        onInput?.(input)
      }
      this.#record()
      sim.advance()
    }
  }

  // srv: { n, p, q, v, w, s } from the server. Returns 'jump' if we were behind it, 'rewind' if we replayed.
  reconcile(srv: ServerState): 'jump' | 'rewind' | null {
    const sim = this.sim,
      mine = this.hist.get(srv.n)
    if (srv.n >= sim.n) {
      this.#adopt(srv)
      return 'jump'
    }
    if (
      !mine ||
      Math.hypot(
        mine.p[0] - srv.p[0],
        mine.p[1] - srv.p[1],
        mine.p[2] - srv.p[2],
      ) < DRIFT_M
    )
      return null
    const until = sim.n,
      replay = this.inputs.filter((i) => i.at >= srv.n)
    this.#adopt(srv)
    while (sim.n < until && !sim.landing) {
      for (let i = replay[0]; i && i.at <= sim.n; i = replay[0]) {
        replay.shift()
        sim.setSteer(i.p, i.r)
      }
      this.#record()
      sim.advance()
    }
    return 'rewind'
  }

  #adopt(srv: ServerState) {
    const sim = this.sim
    sim.s = cloneState(srv)
    sim.n = srv.n
    sim.landing = null
    sim.setSteer(srv.s[0], srv.s[1])
  }

  #record() {
    this.hist.set(this.sim.n, cloneState(this.sim.s))
    this.hist.delete(this.sim.n - HIST_STEPS)
  }
}
