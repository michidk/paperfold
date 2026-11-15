// Does the folded sheet pass through itself? Paper may touch or lie flat on paper, never cross it.
import { cross, dot, sub, type Vec3 } from './plane'

const EPS = 1e-4 // relative slack, so creases, shared corners and touching faces don't count

// Does segment p-q cross triangle abc strictly inside both?
function crosses(p: Vec3, q: Vec3, a: Vec3, b: Vec3, c: Vec3) {
  const e1 = sub(b, a),
    e2 = sub(c, a),
    d = sub(q, p),
    h = cross(d, e2),
    det = dot(e1, h)
  if (Math.abs(det) < 1e-12) return false // parallel or in its plane: touching, not crossing
  const s = sub(p, a),
    u = dot(s, h) / det,
    qv = cross(s, e1),
    v = dot(d, qv) / det,
    t = dot(e2, qv) / det
  return t > EPS && t < 1 - EPS && u > EPS && v > EPS && u + v < 1 - EPS
}

// pos: flat triangle list [x,y,z, ...] as buildPlane returns it.
export function selfIntersects(
  pos: ArrayLike<number> & { slice(a: number, b: number): ArrayLike<number> },
) {
  const tris: [Vec3, Vec3, Vec3][] = []
  const v = (i: number): Vec3 => [pos[i], pos[i + 1], pos[i + 2]]
  for (let i = 0; i < pos.length; i += 9) tris.push([v(i), v(i + 3), v(i + 6)])
  const box = tris.map((t) =>
    [0, 1, 2].map((k) => [
      Math.min(...t.map((v) => v[k])),
      Math.max(...t.map((v) => v[k])),
    ]),
  )
  for (let i = 0; i < tris.length; i++)
    for (let j = i + 1; j < tris.length; j++) {
      if (box[i].some(([lo, hi], k) => hi < box[j][k][0] || box[j][k][1] < lo))
        continue
      for (const [A, B] of [
        [tris[i], tris[j]],
        [tris[j], tris[i]],
      ] as const) {
        for (let e = 0; e < 3; e++)
          if (crosses(A[e], A[(e + 1) % 3], ...B)) return true
      }
    }
  return false
}
