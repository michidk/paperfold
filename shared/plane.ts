// Paper plane model shared by server (simulation) and client (rendering).
// Fold design -> flat paper panels -> rigid body with flat-plate aerodynamics.
// Body frame: +x nose, +y up, +z right wing. Quaternions are [x, y, z, w].

import { panelForce } from './aerodynamics'
import { exposedSurfaces, polygonSurface } from './surfaces'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]
export type Side = 1 | -1
// A lengthwise fold. side limits it to one half; angleL is its angle on the left half.
export interface Fold {
  x1: number
  y1: number
  x2: number
  y2: number
  angle: number
  angleL?: number
  side?: Side
}
// A crosswise flap (a "cut" in the workshop) near the trailing edge.
export interface Flap {
  x0: number
  x1: number
  y: number
  angle: number
  angleL?: number
  side?: Side
}
export interface Design {
  v: 2 // folds start from the plain sheet; older designs had a built-in keel and wing V
  nose: number
  clip: boolean
  mirror?: boolean
  trimLeft: number
  trimRight: number
  folds: Fold[]
  flaps: Flap[]
}
export interface State {
  p: Vec3
  q: Quat
  v: Vec3
  w: Vec3
}
export type PlaneModel = ReturnType<typeof buildPlane>
// biome-ignore lint/suspicious/noExplicitAny: designs arrive from players and saves; sanitizeDesign checks every field
type Untrusted = any

export const SHEET = { W: 0.21, L: 0.297, GSM: 0.08 } // A4, 80 g/m²
export const G = 9.81
export const D2R = Math.PI / 180
// Elevon throw per unit steering input, degrees.
export const STEER_PITCH = 6,
  STEER_ROLL = 7 // stronger banking and enough elevator for pull-up recovery

export const LIMITS: Record<'nose' | 'trimLeft' | 'trimRight', Vec2> = {
  nose: [0, 0.25],
  trimLeft: [-12, 12],
  trimRight: [-12, 12],
}
// Folding rules that keep the plane one real sheet of paper:
// - Lengthwise folds run the full length of the sheet, lean at most maxTilt off the centre line and never
//   cross each other or the centre fold, so every fold can be made flat-to-flat without tearing.
//   The fold nearest the centre is the wing root: the strip inside it is the keel.
// - Crosswise folds are flaps: a hinge near the trailing edge with a cut at each end (like elevator slits).
//   A flap stops at the nearest lengthwise fold, so it never has to bend across one.
export const RULES = {
  maxFolds: 12,
  maxTilt: 30,
  maxFlaps: 2,
  flapZone: 0.09,
  maxFlapAngle: 45,
  minFlap: 0.008,
  minGap: 0.002,
}
// Sheet coords in metres: x across from the centre fold (right half; mirrored onto the left wing),
// y along the sheet (nose = +L/2). Angles in degrees: > 0 folds the far side (away from the centre)
// up, < 0 down, as seen with the half lying flat, top face up. The centre fold presses the halves
// together and hangs the keel below: a wing-root fold of -90° gives a flat wing, -84° a 6° V.
// A fold or flap is on both halves unless it has side: 1 (right) or -1 (left); angleL, if set, is
// its angle on the left half. Each half follows the rules on its own.
export const DEFAULT_DESIGN: Design = {
  v: 2,
  nose: 0.12,
  clip: false,
  trimLeft: 0,
  trimRight: 0,
  folds: [
    { x1: 0.03, y1: 0.1485, x2: 0.03, y2: -0.1485, angle: -84 }, // wing root: a 3 cm keel, 6° V
    { x1: 0.093, y1: 0.1485, x2: 0.093, y2: -0.1485, angle: 70 }, // wingtips up
  ],
  flaps: [{ x0: 0.03, x1: 0.093, y: -0.1235, angle: 10 }], // tail flap up
}
export const onSide = (o: { side?: Side }, s: Side) => !o.side || o.side === s
export const angleOn = (o: { angle: number; angleL?: number }, s: Side) =>
  s < 0 && o.angleL !== undefined ? o.angleL : o.angle
const perSide = <T extends { side?: Side }>(items: T[], g: { side?: Side }) =>
  ([1, -1] as const)
    .filter((s) => onSide(g, s))
    .map((s) => items.filter((o) => onSide(o, s)))
// side and angleL, kept only when they mean something.
function sides<T extends { side?: Side; angleL?: number }>(
  f: Untrusted,
  g: T,
  maxAngle: number,
): T {
  if (f?.side === 1 || f?.side === -1) g.side = f.side
  else if (Number.isFinite(Number(f?.angleL)) && f.angleL !== null)
    g.angleL = num(f.angleL, -maxAngle, maxAngle, 0)
  return g
}
const num = (v: Untrusted, lo: number, hi: number, fallback: number) =>
  Number.isFinite(Number(v)) && v !== null && v !== ''
    ? Math.min(hi, Math.max(lo, Number(v)))
    : fallback

// x of a lengthwise fold line at height y (lengthwise lines are never horizontal).
export const lineX = (f: Pick<Fold, 'x1' | 'y1' | 'x2' | 'y2'>, y: number) =>
  f.x1 + ((f.x2 - f.x1) * (y - f.y1)) / (f.y2 - f.y1)
function inSheet(p: Vec2, d: Pick<Design, 'nose'>) {
  const { W, L } = SHEET
  return (
    p[0] > 0 &&
    p[0] < W / 2 &&
    p[1] > -L / 2 &&
    p[1] < L / 2 - (d.nose * p[0]) / (W / 2)
  )
}
// Would lengthwise fold g be invalid next to the already-accepted folds? Returns a reason or null.
export function foldProblem(
  g: Fold,
  accepted: Fold[],
  d: Pick<Design, 'nose'>,
): 'tilt' | 'centre' | 'cross' | null {
  const { L } = SHEET
  const dy = g.y2 - g.y1
  if (
    !(Math.abs(dy) > 0.005) ||
    Math.atan2(Math.abs(g.x2 - g.x1), Math.abs(dy)) > RULES.maxTilt * D2R + 1e-9
  )
    return 'tilt'
  if (Math.min(lineX(g, -L / 2), lineX(g, L / 2)) < RULES.minGap)
    return 'centre'
  for (const o of accepted) {
    const da = (g.x2 - g.x1) / dy,
      db = (o.x2 - o.x1) / (o.y2 - o.y1)
    if (Math.abs(da - db) < 1e-9) {
      if (Math.abs(lineX(g, 0) - lineX(o, 0)) < RULES.minGap) return 'cross'
      continue
    }
    const y = (lineX(o, 0) - lineX(g, 0)) / (da - db)
    if (inSheet([lineX(g, y), y], d)) return 'cross' // meeting inside the folded-away nose is fine
  }
  return null
}
// Narrow a flap so it never straddles a lengthwise fold; null if nothing sensible is left.
export function trimFlap(from: number, to: number, y: number, folds: Fold[]) {
  let x0 = from,
    x1 = to
  const mid = (x0 + x1) / 2
  for (const f of folds) {
    const a = lineX(f, -SHEET.L / 2),
      b = lineX(f, y),
      lo = Math.min(a, b),
      hi = Math.max(a, b)
    if (hi <= x0 || lo >= x1) continue
    if (lo >= mid) x1 = lo
    else if (hi <= mid) x0 = hi
    else return null
  }
  return x1 - x0 >= RULES.minFlap ? { x0, x1 } : null
}

// Older saved designs: typed folds, free lines, or the original winglet/elevator fields.
function migrate(d: Untrusted): { folds: Untrusted[]; flaps: Untrusted[] } {
  const { W, L } = SHEET
  if (Array.isArray(d.flaps))
    return { folds: Array.isArray(d.folds) ? d.folds : [], flaps: d.flaps }
  const raw = Array.isArray(d.folds)
    ? d.folds
    : d.winglet !== undefined || d.elevator !== undefined
      ? [
          { type: 'long', at: d.winglet, angle: d.wingletAngle },
          { type: 'cross', at: d.elevator, angle: d.elevatorAngle },
        ]
      : null
  if (!raw) return DEFAULT_DESIGN
  const folds: Untrusted[] = [],
    flaps: Untrusted[] = []
  for (const f of raw) {
    if (f?.type === 'long')
      folds.push({
        x1: W / 2 - f.at,
        y1: L / 2,
        x2: W / 2 - f.at,
        y2: -L / 2,
        angle: f.angle,
      })
    else if (f?.type === 'cross')
      flaps.push({ x0: 0, x1: W / 2, y: -L / 2 + Number(f.at), angle: f.angle })
    else if (f && Math.abs(f.x2 - f.x1) < Math.abs(f.y2 - f.y1)) folds.push(f)
    else if (f)
      flaps.push({
        x0: Math.min(f.x1, f.x2),
        x1: Math.max(f.x1, f.x2),
        y: (f.y1 + f.y2) / 2,
        angle: f.angle,
      })
  }
  return { folds, flaps }
}

// Designs from before every fold was drawn: their keel and wing V become the wing-root fold.
function rootFold(d: Untrusted): Untrusted {
  const { L } = SHEET,
    keel = num(d.keel, 0.005, 0.075, 0.03),
    v = num(d.dihedral, -20, 35, 6),
    root: Untrusted = {
      x1: keel,
      y1: L / 2,
      x2: keel,
      y2: -L / 2,
      angle: v - 90,
    }
  if (Number.isFinite(Number(d.dihedralL)) && d.dihedralL !== null)
    root.angleL = num(d.dihedralL, -20, 35, v) - 90
  return root
}

export function sanitizeDesign(d: Untrusted = {}): Design {
  const { W, L } = SHEET,
    w = W / 2
  const out: Design = {
    ...DEFAULT_DESIGN,
    clip: !!d.clip,
    mirror: d.mirror !== false,
    folds: [],
    flaps: [],
  }
  for (const [key, [lo, hi]] of Object.entries(LIMITS) as [
    keyof typeof LIMITS,
    Vec2,
  ][])
    out[key] = num(d[key], lo, hi, DEFAULT_DESIGN[key])
  const migrated = migrate(d),
    rawFlaps = migrated.flaps,
    rawFolds = d.v === 2 ? migrated.folds : [rootFold(d), ...migrated.folds]
  for (const f of rawFolds.slice(0, 8 * RULES.maxFolds)) {
    const g = sides<Fold>(
      f,
      {
        x1: num(f?.x1, 0, w, NaN),
        y1: num(f?.y1, -L / 2, L / 2, NaN),
        x2: num(f?.x2, 0, w, NaN),
        y2: num(f?.y2, -L / 2, L / 2, NaN),
        angle: num(f?.angle, -180, 180, 0),
      },
      180,
    )
    const halves = perSide(out.folds, g)
    if (halves.some((h) => h.length >= RULES.maxFolds)) continue
    if (
      [g.x1, g.y1, g.x2, g.y2].every(Number.isFinite) &&
      halves.every((h) => !foldProblem(g, h, out))
    )
      out.folds.push(g)
  }
  for (const f of rawFlaps.slice(0, 8 * RULES.maxFlaps)) {
    let x0 = num(f?.x0, 0, w, NaN),
      x1 = num(f?.x1, 0, w, NaN)
    if (x0 > x1) [x0, x1] = [x1, x0]
    const y = num(f?.y, -L / 2 + RULES.minFlap, -L / 2 + RULES.flapZone, NaN)
    const g = sides<Omit<Flap, 'x0' | 'x1'>>(
      f,
      { y, angle: num(f?.angle, -RULES.maxFlapAngle, RULES.maxFlapAngle, 0) },
      RULES.maxFlapAngle,
    )
    const t =
      Number.isFinite(x0 + x1 + y) &&
      trimFlap(
        x0,
        x1,
        y,
        out.folds.filter((o) => !g.side || onSide(o, g.side as Side)),
      )
    const halves = perSide(out.flaps, g)
    if (
      !t ||
      halves.some(
        (h) =>
          h.length >= RULES.maxFlaps ||
          h.some((o) => o.x0 < t.x1 && t.x0 < o.x1),
      )
    )
      continue // flaps may not overlap
    out.flaps.push({ ...t, ...g })
  }
  return out
}

// --- vector / quaternion helpers ---
export const add = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
]
export const sub = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
]
export const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export function qmul(a: readonly number[], b: readonly number[]): Quat {
  const [ax, ay, az, aw] = a,
    [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}
export function qrot(q: readonly number[], v: readonly number[]): Vec3 {
  const u = [q[0], q[1], q[2]],
    t = cross(u, v).map((x) => 2 * x),
    c = cross(u, t)
  return [
    v[0] + q[3] * t[0] + c[0],
    v[1] + q[3] * t[1] + c[1],
    v[2] + q[3] * t[2] + c[2],
  ]
}
export const qrotInv = (q: readonly number[], v: readonly number[]) =>
  qrot([-q[0], -q[1], -q[2], q[3]], v)
export function qAxis(axis: readonly number[], a: number): Quat {
  const s = Math.sin(a / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a / 2)]
}
// Heading yaw (about +y, 0 = +x) then nose-up pitch.
export const launchQuat = (yaw: number, pitch: number) =>
  qmul(qAxis([0, 1, 0], yaw), qAxis([0, 0, 1], pitch))

// --- geometry ---
function clip(poly: Vec2[], f: (p: Vec2) => number) {
  const out: Vec2[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      fa = f(a),
      fb = f(b)
    if (fa >= 0) out.push(a)
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}
const polyArea = (p: Vec2[]) =>
  Math.abs(
    p.reduce((s, a, i) => {
      const b = p[(i + 1) % p.length]
      return s + a[0] * b[1] - b[0] * a[1]
    }, 0),
  ) / 2
const ticks = (a: number, b: number, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n)
// Rodrigues: rotate p about the axis through `a` along unit `d`.
function rotate(
  p: readonly number[],
  a: readonly number[],
  d: readonly number[],
  th: number,
): Vec3 {
  const v = sub(p, a),
    c = Math.cos(th),
    s = Math.sin(th),
    dv = dot(d, v),
    x = cross(d, v)
  const r = (i: number) => a[i] + v[i] * c + x[i] * s + d[i] * dv * (1 - c)
  return [r(0), r(1), r(2)]
}

// eL/eR: extra flap deflection in degrees (steering), trailing edge up positive.
export function buildPlane(design: Untrusted, eL = 0, eR = 0) {
  const d = sanitizeDesign(design)
  const { W, L, GSM } = SHEET,
    w = W / 2,
    n = d.nose
  // Sheet coords (x across from centre fold, y along, nose = +L/2). Nose flaps fold away above the diagonal.
  const below = (p: Vec2) => L / 2 - (n * p[0]) / w - p[1]
  // Each half is folded lying flat, top face up: (xs, ys) -> (ys, 0, xs). The strip along the centre
  // fold stays put; every crease turns the part beyond it. Then the half is stood up, keel hanging
  // from the centre fold: (x, y, z) -> (x, z, -y), and the left half mirrored.
  const root: Vec2 = [RULES.minGap / 2, 0] // beside the centre fold, inside every crease
  // The keel's depth: out to the fold nearest the centre (or the whole half), for the nose layers.
  const keel = Math.min(
    w,
    ...d.folds.map((f) => Math.min(lineX(f, L / 2), lineX(f, -L / 2))),
  )
  const crease = (f: Omit<Fold, 'side' | 'angleL'>) => {
    const l = Math.hypot(f.x2 - f.x1, f.y2 - f.y1),
      dx = (f.x2 - f.x1) / l,
      dy = (f.y2 - f.y1) / l
    const side = (p: Vec2) => (p[0] - f.x1) * dy - (p[1] - f.y1) * dx
    const rootSide = Math.sign(side(root)) || 1
    return {
      side,
      rootSide,
      th: f.angle * D2R,
      dist: Math.abs(side(root)),
      a: [f.y1, 0, f.x1] as Vec3,
      dir: (rootSide > 0 ? [dy, 0, dx] : [-dy, 0, -dx]) as Vec3, // chosen so +angle lifts the far side
    }
  }
  type Crease = ReturnType<typeof crease>
  const foldsBySide = {} as Record<Side, Fold[]>,
    creasesBySide = {} as Record<Side, Crease[]>,
    flapsBySide = {} as Record<Side, Flap[]>
  for (const [side, trim, steer] of [
    [1, d.trimRight, eR],
    [-1, d.trimLeft, eL],
  ] as const) {
    const folds = d.folds
      .filter((f) => onSide(f, side))
      .map((f) => ({ ...f, angle: angleOn(f, side) }))
    foldsBySide[side] = folds
    creasesBySide[side] = folds.map(crease).sort((a, b) => b.dist - a.dist) // outermost first: exact for non-crossing folds
    // Steering bends the flaps; a wing without flaps gets a small one at the tail for it.
    const own = d.flaps
      .filter((f) => onSide(f, side))
      .map((f) => ({ ...f, angle: angleOn(f, side) }))
    const steerFlap = own.length
      ? null
      : trimFlap(w * 0.4, w, -L / 2 + 0.02, folds)
    const flaps: Flap[] = own.length
      ? own
      : steerFlap
        ? [{ ...steerFlap, y: -L / 2 + 0.02, angle: 0 }]
        : []
    flapsBySide[side] = flaps.map((f) => ({
      ...f,
      angle: Math.max(-60, Math.min(60, f.angle + trim + steer)),
    }))
  }
  const wingPt = (
    xs: number,
    ys: number,
    side: Side,
    flap: Flap | undefined,
  ): Vec3 => {
    let p: Vec3 = [ys, 0, xs]
    if (flap) p = rotate(p, [flap.y, 0, 0], [0, 0, -1], flap.angle * D2R)
    for (const c of creasesBySide[side])
      if (Math.sign(c.side([xs, ys])) === -c.rootSide)
        p = rotate(p, c.a, c.dir, c.th)
    return [p[0], p[2], -p[1]] // stand the half up: keel down from the centre fold
  }
  const cells = (xs: number[], ys: number[]) => {
    const out: Vec2[][] = []
    for (let i = 0; i < ys.length - 1; i++)
      for (let j = 0; j < xs.length - 1; j++) {
        const poly = clip(
          [
            [xs[j], ys[i]],
            [xs[j + 1], ys[i]],
            [xs[j + 1], ys[i + 1]],
            [xs[j], ys[i + 1]],
          ],
          below,
        )
        if (poly.length >= 3 && polyArea(poly) > 1e-7) out.push(poly)
      }
    return out
  }
  // Split each wing's cells along its creases, hinges and cuts so no panel straddles one.
  const wingCells = (s: Side) => {
    const cuts: Omit<Fold, 'angle'>[] = [
      ...foldsBySide[s],
      ...flapsBySide[s].flatMap((f) => [
        { x1: 0, y1: f.y, x2: 1, y2: f.y },
        { x1: f.x0, y1: 0, x2: f.x0, y2: 1 },
        { x1: f.x1, y1: 0, x2: f.x1, y2: 1 },
      ]),
    ]
    let wing = cells(ticks(0, w, 8), ticks(-L / 2, L / 2, 12))
    for (const f of cuts) {
      const { side } = crease({ ...f, angle: 0 })
      wing = wing
        .flatMap((p) => [clip(p, side), clip(p, (q: Vec2) => -side(q))])
        .filter((p) => p.length >= 3 && polyArea(p) > 1e-8)
    }
    return wing
  }
  const parts: { pts: Vec3[]; uv: Vec2[]; area: number; mass: number }[] = []
  const add3 = (
    polys: Vec2[][],
    map: (xs: number, ys: number, side: Side) => Vec3,
    layers: number,
    sides: Side[],
  ) => {
    for (const poly of polys) {
      const area = polyArea(poly)
      for (const side of sides)
        parts.push({
          pts: poly.map(([xs, ys]) => {
            const p = map(xs, ys, side)
            return [p[0], p[1], p[2] * side] as Vec3
          }),
          uv: poly.map(
            ([xs, ys]): Vec2 => [(side * xs + w) / W, (ys + L / 2) / L],
          ),
          area,
          mass: area * GSM * layers,
        })
    }
  }
  const flapOf = (poly: Vec2[], side: Side) => {
    const c = [
      poly.reduce((t, p) => t + p[0], 0) / poly.length,
      poly.reduce((t, p) => t + p[1], 0) / poly.length,
    ]
    return flapsBySide[side].find(
      (f) => c[1] < f.y && c[0] > f.x0 && c[0] < f.x1,
    )
  }
  for (const side of [1, -1] as const)
    for (const poly of wingCells(side)) {
      const flap = flapOf(poly, side)
      add3([poly], (xs, ys) => wingPt(xs, ys, side, flap), 1, [side])
    }

  const masses: { m: number; c: Vec3 }[] = parts.map((p) => ({
    m: p.mass,
    c: polygonSurface(p.pts).c,
  }))
  const visible = masses.reduce((s, x) => s + x.m, 0)
  masses.push({
    m: Math.max(0, W * L * GSM - visible),
    c: [L / 2 - 0.6 * n, 0.7 * keel, 0],
  }) // folded nose layers
  if (d.clip) masses.push({ m: 0.0009, c: [L / 2 - 0.015, 0.5 * keel, 0] })
  const mass = masses.reduce((s, x) => s + x.m, 0)
  const cg = masses.reduce(
    (s, x) =>
      add(
        s,
        x.c.map((v) => (v * x.m) / mass),
      ),
    [0, 0, 0] as Vec3,
  )
  const inertia: Vec3 = [0, 0, 0]
  for (const { m, c } of masses) {
    const r = sub(c, cg)
    inertia[0] += m * (r[1] ** 2 + r[2] ** 2)
    inertia[1] += m * (r[0] ** 2 + r[2] ** 2)
    inertia[2] += m * (r[0] ** 2 + r[1] ** 2)
  }
  for (let i = 0; i < 3; i++) inertia[i] += mass * 2e-4 // panels are not point masses

  const panels = exposedSurfaces(parts).map((p) => ({
    c: sub(p.c, cg),
    n: p.n,
    a: p.a,
    pressureAxis: [1 - p.n[0] ** 2, -p.n[0] * p.n[1], -p.n[0] * p.n[2]] as Vec3,
  }))
  const pos: number[] = [],
    uv: number[] = []
  for (const p of parts)
    for (let i = 1; i < p.pts.length - 1; i++)
      for (const j of [0, i, i + 1]) {
        pos.push(...sub(p.pts[j], cg))
        uv.push(...p.uv[j])
      }
  const span =
    Math.max(...parts.flatMap((p) => p.pts.map((v) => v[2]))) -
    Math.min(...parts.flatMap((p) => p.pts.map((v) => v[2])))
  const area = panels.reduce((sum, p) => sum + p.a * Math.abs(p.n[1]), 0)
  const aspectRatio = Math.max(0.15, (span * span) / Math.max(area, 1e-8))
  const chord = Math.min(L, area / Math.max(span, 0.005))
  const vertices = parts.flatMap((p) => p.pts.map((v) => sub(v, cg)))
  const contacts = new Map<string, Vec3>()
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const z of [-1, 0, 1]) {
        if (!x && !y && !z) continue
        const dir: Vec3 = [x, y, z]
        const point = vertices.reduce((a, b) =>
          dot(a, dir) > dot(b, dir) ? a : b,
        )
        contacts.set(point.map((v) => v.toFixed(8)).join(','), point)
      }
  return {
    design: d,
    mass,
    cg,
    inertia,
    panels,
    pos,
    uv,
    aspectRatio,
    chord,
    contacts: [...contacts.values(), [0, 0, 0] as Vec3],
  }
}

export function planeStats(model: PlaneModel) {
  let a = 0,
    cx = 0,
    minZ = 0,
    maxZ = 0
  for (const p of model.panels) {
    const ah = p.a * Math.abs(p.n[1])
    a += ah
    cx += ah * p.c[0]
  }
  for (let i = 2; i < model.pos.length; i += 3) {
    minZ = Math.min(minZ, model.pos[i])
    maxZ = Math.max(maxZ, model.pos[i])
  }
  return {
    span: maxZ - minZ,
    area: a,
    mass: model.mass,
    margin: a > 1e-10 ? -cx / a / SHEET.L : 0,
  }
}

// --- dynamics ---
export function launchState(
  p: Vec3,
  yaw: number,
  pitch: number,
  speed: number,
  spin: Vec3 = [0, 0, 0],
): State {
  const q = launchQuat(yaw, pitch)
  return { p: [...p], q, v: qrot(q, [speed, 0, 0]), w: [...spin] }
}

// Air forces on the plane: total force in the body frame, and torque (plus `control`) about its CG.
export function aeroForces(
  s: State,
  m: PlaneModel,
  wind: readonly number[] = [0, 0, 0],
  control: readonly number[] = [0, 0, 0],
) {
  const bodyForce: Vec3 = [0, 0, 0],
    T: Vec3 = [control[0], control[1], control[2]]
  const airflow = qrotInv(s.q, sub(wind, s.v))
  for (const pn of m.panels) {
    const flow = sub(airflow, cross(s.w, pn.c))
    const { force: f, pressure } = panelForce(
      flow,
      pn.n,
      pn.a,
      m.aspectRatio,
      pn.n[1] ** 2,
    )
    // Forward pressure bias in attached flow; return to the panel centre when stalled.
    // The chord is for the whole wing, so subdividing a panel cannot change this moment.
    const shift = pn.pressureAxis.map((v) => v * m.chord * 0.1 * pressure)
    const t = cross(add(pn.c, shift), f)
    for (let i = 0; i < 3; i++) {
      bodyForce[i] += f[i]
      T[i] += t[i]
    }
  }
  return { bodyForce, torque: T }
}

// Semi-implicit Euler, with attached wing flow blended into separated plate flow.
export function step(
  s: State,
  m: PlaneModel,
  dt: number,
  wind: readonly number[] = [0, 0, 0],
  control: readonly number[] = [0, 0, 0], // extra body-frame torque: the pilot's steering
) {
  const { bodyForce, torque: T } = aeroForces(s, m, wind, control)
  const F = qrot(s.q, bodyForce)
  F[1] -= m.mass * G
  for (let i = 0; i < 3; i++) {
    s.v[i] += (F[i] / m.mass) * dt
    s.p[i] += s.v[i] * dt
  }
  const I = m.inertia,
    w = s.w
  const gyro = cross(w, [I[0] * w[0], I[1] * w[1], I[2] * w[2]])
  for (let i = 0; i < 3; i++) w[i] += ((T[i] - gyro[i]) / I[i]) * dt
  const dq = qmul(s.q, [w[0], w[1], w[2], 0])
  for (let i = 0; i < 4; i++) s.q[i] += 0.5 * dt * dq[i]
  const ql = Math.hypot(...s.q)
  for (let i = 0; i < 4; i++) s.q[i] /= ql
}

// Lying on a surface: keep heading, tip onto one side, lowest point touching.
export function restPose(
  model: PlaneModel,
  q: Quat,
  p: Vec3,
  surfaceY: number,
  roll: number,
): { p: Vec3; q: Quat } {
  const f = qrot(q, [1, 0, 0])
  const rq = qmul(
    qAxis([0, 1, 0], Math.atan2(-f[2], f[0])),
    qAxis([1, 0, 0], roll),
  )
  let minY = Infinity
  for (let i = 0; i < model.pos.length; i += 3)
    minY = Math.min(minY, qrot(rq, model.pos.slice(i, i + 3))[1])
  return { p: [p[0], surfaceY - minY + 0.002, p[2]], q: rq }
}
