// Convex polygon subtraction for paper layers lying in the same plane.
// This changes aerodynamic surfaces only; the original paper still supplies mass.
import type { Vec3 } from './plane'

type Poly = Vec3[]
const dot = (a: Vec3, b: Vec3) => a.reduce((s, x, i) => s + x * b[i], 0)
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

export function polygonSurface(pts: Poly) {
  let area = 0
  const centre: Vec3 = [0, 0, 0],
    normal: Vec3 = [0, 0, 0]
  for (let i = 1; i < pts.length - 1; i++) {
    const n = cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]))
    const a = Math.hypot(...n) / 2
    area += a
    for (let j = 0; j < 3; j++) {
      centre[j] += (a * (pts[0][j] + pts[i][j] + pts[i + 1][j])) / 3
      normal[j] += n[j]
    }
  }
  const length = Math.hypot(...normal) || 1
  return {
    a: area,
    c: centre.map((v) => v / (area || 1)) as Vec3,
    n: normal.map((v) => v / length) as Vec3,
  }
}

function halfPlane(poly: Poly, distance: (p: Vec3) => number) {
  const out: Poly = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      da = distance(a),
      db = distance(b)
    if (da >= 0) out.push(a)
    if (da >= 0 !== db >= 0)
      out.push(a.map((x, j) => x + ((b[j] - x) * da) / (da - db)) as Vec3)
  }
  return out
}

function subtract(poly: Poly, cover: Poly, normal: Vec3) {
  const outside: Poly[] = []
  let inside = poly
  for (let i = 0; i < cover.length && inside.length >= 3; i++) {
    const a = cover[i],
      edge = sub(cover[(i + 1) % cover.length], a)
    const distance = (p: Vec3) => dot(cross(edge, sub(p, a)), normal)
    const piece = halfPlane(inside, (p: Vec3) => -distance(p))
    if (piece.length >= 3 && polygonSurface(piece).a > 1e-10)
      outside.push(piece)
    inside = halfPlane(inside, distance)
  }
  return outside
}

export function exposedSurfaces(parts: { pts: Poly }[]) {
  const seen: { pts: Poly; n: Vec3; bounds: number[][] }[] = [],
    result: (ReturnType<typeof polygonSurface> & { pts: Poly })[] = []
  for (const { pts } of parts) {
    const surface = polygonSurface(pts)
    if (surface.a < 1e-10) continue
    const bounds = [0, 1, 2].map((i) => [
      Math.min(...pts.map((p) => p[i])),
      Math.max(...pts.map((p) => p[i])),
    ])
    const axis = surface.n
      .map(Math.abs)
      .indexOf(Math.max(...surface.n.map(Math.abs)))
    let pieces = [pts]
    for (const cover of seen) {
      if (
        bounds.some(
          ([lo, hi], i) =>
            i !== axis &&
            Math.min(hi, cover.bounds[i][1]) -
              Math.max(lo, cover.bounds[i][0]) <
              1e-9,
        )
      )
        continue
      if (Math.abs(dot(surface.n, cover.n)) < 1 - 1e-9) continue
      if (Math.abs(dot(sub(pts[0], cover.pts[0]), cover.n)) > 1e-6) continue
      pieces = pieces.flatMap((p) => subtract(p, cover.pts, cover.n))
      if (!pieces.length) break
    }
    seen.push({ pts, n: surface.n, bounds })
    for (const p of pieces) result.push({ ...polygonSurface(p), pts: p })
  }
  return result
}
