import type { PlaneModel, Quat, State, Vec3 } from './plane'
import { add, cross, dot, qrot, qrotInv, sub } from './plane'
import type { Solid } from './world'

export interface Hit {
  t: number
  normal: Vec3
  box: Solid | null
}

function segmentBox(a: Vec3, b: Vec3, box: Solid): Hit | null {
  let enter = 0,
    leave = 1,
    normal: Vec3 | null = null
  const lo = [box.x0, 0, box.z0],
    hi = [box.x1, box.y1, box.z1]
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i]
    if (Math.abs(d) < 1e-12) {
      if (a[i] < lo[i] || a[i] > hi[i]) return null
      continue
    }
    let near = (lo[i] - a[i]) / d,
      far = (hi[i] - a[i]) / d
    const sign = d > 0 ? -1 : 1
    if (near > far) [near, far] = [far, near]
    if (near >= enter) {
      enter = near
      normal = [0, 0, 0]
      normal[i] = sign
    }
    leave = Math.min(leave, far)
    if (enter > leave) return null
  }
  if (!normal || enter < 0 || enter > 1) return null
  return { t: enter, normal, box }
}

export function sweepContact(
  before: { p: Vec3; q: Quat },
  after: { p: Vec3; q: Quat },
  points: Vec3[],
  solids: Solid[],
) {
  const paths = points.map((p) => [
    add(before.p, qrot(before.q, p)),
    add(after.p, qrot(after.q, p)),
  ])
  const bounds = [0, 1, 2].map((i) => [
    Math.min(...paths.flatMap((p) => p.map((v) => v[i]))),
    Math.max(...paths.flatMap((p) => p.map((v) => v[i]))),
  ])
  const nearby = solids.filter(
    (b) =>
      bounds[0][1] >= b.x0 &&
      bounds[0][0] <= b.x1 &&
      bounds[2][1] >= b.z0 &&
      bounds[2][0] <= b.z1 &&
      bounds[1][0] <= b.y1 &&
      bounds[1][1] >= 0,
  )
  let first: (Hit & { r: Vec3 }) | null = null
  for (const [a, b] of paths) {
    const candidates: Hit[] = []
    if (b[1] <= 0 && b[1] < a[1])
      candidates.push({
        t: Math.max(0, a[1] / (a[1] - b[1])),
        normal: [0, 1, 0] as Vec3,
        box: null,
      })
    for (const box of nearby) {
      const hit = segmentBox(a, b, box)
      if (hit) candidates.push(hit)
    }
    for (const hit of candidates)
      if (!first || hit.t < first.t) {
        const point = a.map((v, i) => v + hit.t * (b[i] - v))
        const centre = before.p.map((v, i) => v + hit.t * (after.p[i] - v))
        first = { ...hit, r: sub(point, centre) }
      }
  }
  return first
}

export function resolveContact(
  s: State,
  model: PlaneModel,
  hit: { normal: Vec3; r: Vec3 },
) {
  const { normal: n, r } = hit
  const velocity = add(s.v, cross(qrot(s.q, s.w), r))
  const inward = dot(velocity, n)
  if (inward >= 0) return
  const arm = qrotInv(s.q, cross(r, n))
  const denominator =
    1 / model.mass +
    arm.reduce((sum, v, i) => sum + (v * v) / model.inertia[i], 0)
  const impulse = (-1.15 * inward) / denominator
  for (let i = 0; i < 3; i++) {
    s.v[i] += (impulse * n[i]) / model.mass
    s.w[i] += (impulse * arm[i]) / model.inertia[i]
  }
}
