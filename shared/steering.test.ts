import { expect, test } from 'bun:test'
import { Flight, steerTorque } from './flight'
import { buildPlane, DEFAULT_DESIGN, launchState, qrot } from './plane'

// The wing-root fold: a 3 cm keel, and the wing folded down by -angle (-90: flat wings).
const ROOT = (angle: number) => ({
  x1: 0.03,
  y1: 0.1485,
  x2: 0.03,
  y2: -0.1485,
  angle,
})
// Designs whose bent flaps used to steer the wrong way or hardly at all.
const DESIGNS = {
  default: DEFAULT_DESIGN,
  flatWings: { ...DEFAULT_DESIGN, folds: [ROOT(-90)], flaps: [] },
  steepFolds: {
    ...DEFAULT_DESIGN,
    folds: [
      ROOT(-84),
      { x1: 0.06, y1: 0.1485, x2: 0.06, y2: -0.1485, angle: 85 },
      { x1: 0.09, y1: 0.1485, x2: 0.09, y2: -0.1485, angle: -60 },
    ],
  },
  bigDihedral: {
    ...DEFAULT_DESIGN,
    folds: [ROOT(-60), ...DEFAULT_DESIGN.folds.slice(1)],
  },
}

// Fly with the stick held; returns the heading change (degrees, > 0 to the right) and nose angle.
function fly(design: unknown, pitch: number, roll: number, seconds: number) {
  const f = new Flight(design, launchState([0, 50, 0], 0, 0, 7))
  f.setSteer(pitch, roll)
  let turned = 0,
    last = 0
  for (let i = 0; i < seconds / 0.001; i++) {
    f.advance()
    const nose = qrot(f.s.q, [1, 0, 0]),
      heading = Math.atan2(nose[2], nose[0])
    turned += ((heading - last + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
    last = heading
  }
  const nose = qrot(f.s.q, [1, 0, 0])
  return {
    turned: (turned * 180) / Math.PI,
    nose: (Math.asin(nose[1]) * 180) / Math.PI,
    finite: f.s.p.every(Number.isFinite),
  }
}

test('left and right turn that way, about equally, whatever the design', () => {
  for (const [name, design] of Object.entries(DESIGNS)) {
    const straight = fly(design, 0, 0, 3).turned
    const right = fly(design, 0, 1, 3).turned - straight,
      left = fly(design, 0, -1, 3).turned - straight
    expect({ name, right: right > 90 }).toEqual({ name, right: true })
    expect({ name, left: left < -90 }).toEqual({ name, left: true })
    expect(Math.abs(right + left)).toBeLessThan(0.3 * right)
  }
}, 30_000)

test('up raises the nose and down lowers it, whatever the design', () => {
  for (const [name, design] of Object.entries(DESIGNS)) {
    const level = fly(design, 0, 0, 0.5).nose,
      up = fly(design, 1, 0, 0.5),
      down = fly(design, -1, 0, 0.5)
    expect({ name, up: up.nose > level + 5 }).toEqual({ name, up: true })
    expect({ name, down: down.nose < level - 10 }).toEqual({ name, down: true })
    expect(up.finite && down.finite).toBe(true)
  }
})

test('no input means no steering torque, and a slow plane gets less of it', () => {
  const model = buildPlane(DEFAULT_DESIGN)
  const fast = launchState([0, 50, 0], 0, 0, 7),
    slow = launchState([0, 50, 0], 0, 0, 2)
  expect(steerTorque(fast, model, 0, 0)).toEqual([0, 0, 0])
  const hard = Math.abs(steerTorque(fast, model, 1, 0)[2]),
    soft = Math.abs(steerTorque(slow, model, 1, 0)[2])
  expect(hard).toBeGreaterThan(0)
  expect(soft).toBeLessThan(hard)
})
