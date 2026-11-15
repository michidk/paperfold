import { expect, test } from 'bun:test'
import {
  buildPlane,
  DEFAULT_DESIGN,
  type Flap,
  type Fold,
  launchState,
  type PlaneModel,
  planeStats,
  RULES,
  sanitizeDesign,
  step,
} from './plane'

function fly(model: PlaneModel, speed: number, pitch: number, maxT = 120) {
  const s = launchState([0, 50, 0], 0, pitch, speed)
  let t = 0
  while (s.p[1] > 0 && t < maxT) {
    step(s, model, 0.001)
    t += 0.001
  }
  return { s, t }
}

test('default dart glides like a paper plane', () => {
  const m = buildPlane(DEFAULT_DESIGN)
  expect(m.mass).toBeCloseTo(0.005, 3)
  const { s, t } = fly(m, 7, 0)
  const dist = Math.hypot(s.p[0], s.p[2])
  console.log('glide', {
    dist: dist.toFixed(1),
    t: t.toFixed(1),
    stats: planeStats(m),
  })
  expect(s.p.every(Number.isFinite)).toBe(true)
  expect(dist / 50).toBeGreaterThan(2.5) // glide ratio
  expect(dist / 50).toBeLessThan(10)
}, 30_000)

test('right roll input turns right', () => {
  const neutral = fly(buildPlane(DEFAULT_DESIGN), 7, 0, 6).s
  const right = fly(buildPlane(DEFAULT_DESIGN, -12, 12), 7, 0, 6).s
  expect(right.p[2] - neutral.p[2]).toBeGreaterThan(0.5) // +z is the right wing side
})

test('sanitizeDesign clamps untrusted input, and turns an old keel and wing V into the root fold', () => {
  const d = sanitizeDesign({ nose: 99, keel: 'x', dihedral: -1e9, clip: 1 })
  expect(d.nose).toBe(0.25)
  expect(d.clip).toBe(true)
  expect(d.v).toBe(2)
  expect(d.folds[0]).toEqual({
    x1: 0.03,
    y1: 0.1485,
    x2: 0.03,
    y2: -0.1485,
    angle: -110,
  }) // 3 cm keel, -20° V
})

const fold = (x1: number, x2: number, angle: number): Fold => ({
  x1,
  y1: 0.1485,
  x2,
  y2: -0.1485,
  angle,
}) // lengthwise, full length
const flap = (
  x0: number,
  x1: number,
  fromTail: number,
  angle: number,
): Flap => ({
  x0,
  x1,
  y: -0.1485 + fromTail,
  angle,
})
// The wing root: a 3 cm keel and a 6° V, as in the default plane.
const ROOT = fold(0.03, 0.03, -84)
const design = (folds: Fold[], flaps: Flap[] = []) => ({
  ...DEFAULT_DESIGN,
  folds: [ROOT, ...folds],
  flaps,
})

// Group vertices by their spot on the flat sheet (uv): one continuous sheet means every copy of a
// sheet point lands in the same 3D place, except along the flap cuts.
function tears(m: PlaneModel) {
  const at = new Map<string, number[][]>()
  for (let i = 0; i < m.uv.length / 2; i++) {
    const key = `${m.uv[2 * i].toFixed(6)},${m.uv[2 * i + 1].toFixed(6)}`
    const p = m.pos.slice(3 * i, 3 * i + 3)
    at.set(key, [...(at.get(key) ?? []), p])
  }
  const torn: string[] = []
  for (const [key, ps] of at)
    if (
      ps.some(
        (p) =>
          Math.hypot(p[0] - ps[0][0], p[1] - ps[0][1], p[2] - ps[0][2]) > 1e-9,
      )
    )
      torn.push(key)
  return torn
}

test('ten lengthwise folds both ways plus flaps stay one sheet of paper', () => {
  const folds = [
    0.045, 0.06, 0.066, 0.072, 0.078, 0.084, 0.089, 0.094, 0.098, 0.102,
  ].map((x, i) => fold(x, x, i % 2 ? -25 : 30))
  folds[2] = fold(0.066, 0.07, 20) // leaning folds are fine as long as they don't cross
  const m = buildPlane(
    design(folds, [flap(0.03, 0.045, 0.03, 20), flap(0.045, 0.06, 0.02, -15)]),
  )
  expect(m.design.folds.length).toBe(11) // and the root fold
  expect(m.design.flaps.length).toBe(2)
  expect(m.mass).toBeCloseTo(0.005, 3) // folding never adds or loses paper
  expect(m.pos.every(Number.isFinite)).toBe(true)
  // The only separated points are on the four flap cuts (both wings), never on a fold.
  const flapEdges = m.design.flaps.flatMap((f) => [f.x0, f.x1])
  for (const key of tears(m)) {
    const [u, v] = key.split(',').map(Number),
      x = Math.abs(u * 0.21 - 0.105),
      y = v * 0.297 - 0.1485
    expect(flapEdges.some((e) => Math.abs(e - x) < 1e-6)).toBe(true)
    expect(y).toBeLessThan(
      (m.design.flaps.find(
        (f) => Math.abs(f.x0 - x) < 1e-6 || Math.abs(f.x1 - x) < 1e-6,
      )?.y ?? Number.NaN) + 1e-9,
    )
  }
  expect(fly(m, 7, 0, 10).s.p.every(Number.isFinite)).toBe(true)
})

test('a plain lengthwise fold lifts the far side and tears nothing', () => {
  const m = buildPlane({
    ...DEFAULT_DESIGN,
    folds: [fold(0.03, 0.03, -90), fold(0.08, 0.08, 90)],
    flaps: [],
  })
  let maxY = -1
  for (let i = 1; i < m.pos.length; i += 3)
    maxY = Math.max(maxY, m.pos[i] + m.cg[1])
  expect(maxY).toBeCloseTo(0.03 + 0.025, 3) // above the 3 cm keel, the strip outside the fold stands up
  expect(tears(buildPlane(design([fold(0.08, 0.08, 90)], [])))).toEqual(
    tears(buildPlane(design([], []))),
  ) // only the steering-flap cuts
})

test('fold direction matters: tail flap down dives, up holds', () => {
  const down = fly(
    buildPlane(design([], [flap(0.03, 0.105, 0.025, -15)])),
    7,
    0,
    3,
  ).s
  const up = fly(
    buildPlane(design([], [flap(0.03, 0.105, 0.025, 12)])),
    7,
    0,
    3,
  ).s
  expect(up.p[1]).toBeGreaterThan(down.p[1] + 2)
})

test('steering works without any folds or flaps', () => {
  const plain = design([], [])
  // Without an up flap it dives, so check the roll rate right after release (+x roll = right wing down).
  const neutral = fly(buildPlane(plain), 7, 0, 0.2).s,
    right = fly(buildPlane(plain, -12, 12), 7, 0, 0.2).s
  expect(right.w[0] - neutral.w[0]).toBeGreaterThan(0.5)
})

test('fold rules: count, tilt, crossing, root, flap zone, angle and trimming', () => {
  const many = sanitizeDesign(
    design(
      Array.from({ length: 30 }, (_, i) =>
        fold(0.035 + i * 0.0022, 0.035 + i * 0.0022, 400),
      ),
    ),
  )
  expect(many.folds.length).toBe(RULES.maxFolds) // the root fold and as many more as fit
  expect(many.folds[1].angle).toBe(180)
  expect(
    sanitizeDesign(
      design([{ x1: 0.05, y1: 0, x2: 0.08, y2: -0.03, angle: 10 }]),
    ).folds,
  ).toEqual([ROOT]) // leans 45°
  expect(
    sanitizeDesign(design([fold(0.05, 0.09, 10), fold(0.09, 0.05, 10)])).folds
      .length,
  ).toBe(2) // crossing: the root fold and one of the two
  expect(sanitizeDesign(design([fold(0.001, 0.001, 10)])).folds).toEqual([ROOT]) // on the centre fold
  expect(sanitizeDesign(design([fold(0.02, 0.02, 10)])).folds.length).toBe(2) // inside the keel is fine now
  const f = sanitizeDesign(
    design(
      [],
      [
        flap(0.03, 0.1, 0.2, 80),
        flap(0.04, 0.05, 0.01, 0),
        flap(0.06, 0.07, 0.01, 0),
      ],
    ),
  ).flaps
  expect(f.length).toBe(1) // the others overlap it
  expect(f[0].y).toBeCloseTo(-0.1485 + RULES.flapZone, 9) // hinge pulled into the tail zone
  expect(f[0].angle).toBe(RULES.maxFlapAngle)
  const trimmed = sanitizeDesign(
    design([fold(0.08, 0.08, 40)], [flap(0.03, 0.1, 0.03, 10)]),
  ).flaps[0]
  expect(trimmed.x1).toBeCloseTo(0.08, 9) // stops at the fold instead of bending across it
  const split = sanitizeDesign(
    design([fold(0.06, 0.06, 40)], [flap(0.05, 0.07, 0.03, 10)]),
  ).flaps[0] // fold through the middle
  expect(split.x0 >= 0.06 - 1e-12 || split.x1 <= 0.06 + 1e-12).toBe(true) // keeps one side of it
})

test('older designs migrate to folds and flaps', () => {
  const typed = sanitizeDesign({
    folds: [
      { type: 'long', at: 0.012, angle: 70 },
      { type: 'cross', at: 0.025, angle: 10 },
    ],
  })
  expect(typed.folds[1].x1).toBeCloseTo(0.093, 6) // after the root fold of the old built-in keel
  expect(typed.flaps[0].y).toBeCloseTo(-0.1235, 6)
  const lines = sanitizeDesign({
    folds: [
      { x1: 0.093, y1: 0.06, x2: 0.093, y2: -0.1485, angle: 70 },
      { x1: 0.03, y1: -0.1235, x2: 0.105, y2: -0.1235, angle: 10 },
    ],
  })
  expect(lines.folds.length).toBe(2)
  expect(lines.flaps[0].x1).toBeCloseTo(0.093, 6) // trimmed at the wingtip fold
  expect(
    sanitizeDesign({
      winglet: 0.012,
      wingletAngle: 70,
      elevator: 0.025,
      elevatorAngle: 10,
    }).flaps.length,
  ).toBe(1)
})

test('nose fold can be skipped entirely', () => {
  const m = buildPlane({ ...DEFAULT_DESIGN, nose: 0 })
  expect(m.mass).toBeCloseTo(0.005, 3)
  expect(m.pos.every(Number.isFinite)).toBe(true)
})

test('folding a wing back onto itself preserves mass but removes covered aerodynamic area', () => {
  const root = fold(0.03, 0.03, -90) // a flat wing
  const plain = { ...DEFAULT_DESIGN, nose: 0, folds: [root], flaps: [] }
  const open = buildPlane(plain)
  const folded = buildPlane({
    ...plain,
    folds: [root, fold(0.0675, 0.0675, 180)],
  })
  expect(folded.mass).toBeCloseTo(open.mass, 12)
  expect(planeStats(folded).area).toBeCloseTo(planeStats(open).area / 2, 7)
})

test('independent tail trim persists and mirrored trim produces mirrored roll', () => {
  const rightDesign = { ...DEFAULT_DESIGN, trimLeft: -5, trimRight: 5 }
  expect(sanitizeDesign(rightDesign).trimRight).toBe(5)
  expect(sanitizeDesign({}).trimLeft).toBe(0)
  expect(sanitizeDesign({ trimRight: Infinity, trimLeft: -500 }).trimLeft).toBe(
    -12,
  )
  const right = fly(buildPlane(rightDesign), 7, 0, 0.3).s
  const left = fly(
    buildPlane({ ...DEFAULT_DESIGN, trimLeft: 5, trimRight: -5 }),
    7,
    0,
    0.3,
  ).s
  expect(right.w[0]).toBeGreaterThan(0.1)
  expect(left.w[0]).toBeCloseTo(-right.w[0], 6)
})
