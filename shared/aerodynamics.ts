// Tunable low-Reynolds-number game approximation, not measured paper-airfoil data.
import type { Vec3 } from './plane'

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

export function coefficients(alpha: number, aspectRatio: number) {
  const ar = Math.max(0.15, aspectRatio),
    efficiency = 0.8
  const slope = (2 * Math.PI) / (1 + 2 / (efficiency * ar))
  const attached = slope * Math.sin(alpha) * Math.cos(alpha)
  const separated = smooth(
    (Math.abs(alpha) - (15 * Math.PI) / 180) / ((20 * Math.PI) / 180),
  )
  const lift =
    (1 - separated) * attached + separated * 0.65 * Math.sin(2 * alpha)
  const drag =
    0.015 +
    ((1 - separated) * attached ** 2) / (Math.PI * efficiency * ar) +
    separated * 2 * Math.sin(alpha) ** 2
  return { lift, drag, attached: 1 - separated }
}

export function panelForce(
  flow: Vec3,
  normal: Vec3,
  area: number,
  aspectRatio: number,
  wingFraction: number,
): { force: Vec3; pressure: number } {
  const speed = Math.hypot(...flow)
  if (speed < 1e-9) return { force: [0, 0, 0], pressure: 0 }
  const direction = flow.map((v) => v / speed)
  const incidence = Math.max(
    -1,
    Math.min(
      1,
      direction.reduce((v, x, i) => v + x * normal[i], 0),
    ),
  )
  const tangent = Math.sqrt(Math.max(0, 1 - incidence * incidence))
  const c = coefficients(Math.asin(incidence), aspectRatio)
  // Wing normals alone cannot distinguish forward flight from sliding sideways.
  // Project the nose direction onto this panel to measure flow along its chord.
  const chordLength = Math.sqrt(Math.max(0, 1 - normal[0] ** 2))
  const forward =
    chordLength > 1e-8 && tangent > 1e-8
      ? -(direction[0] - normal[0] * incidence) / (chordLength * tangent)
      : 1
  const slip = Math.acos(Math.max(-1, Math.min(1, forward)))
  // Forgiving near alignment; broadside/reverse flight becomes a draggy flat plate.
  const sideways = smooth(
    (slip - (25 * Math.PI) / 180) / ((40 * Math.PI) / 180),
  )
  const q = 0.5 * 1.2 * area * speed * speed
  const force = direction.map((d, i) => {
    const liftDirection =
      tangent > 1e-8 ? (normal[i] - incidence * d) / tangent : 0
    const plate =
      2 * incidence * normal[i] + 0.015 * (d - incidence * normal[i])
    const wing =
      (1 - sideways) * (c.lift * liftDirection + c.drag * d) +
      sideways * (plate + 0.8 * d)
    return q * (wingFraction * wing + (1 - wingFraction) * plate)
  })
  return {
    force: force as Vec3,
    pressure: wingFraction * c.attached * (1 - sideways),
  }
}
