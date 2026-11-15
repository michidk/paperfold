import { expect, test } from 'bun:test'
import {
  buildPlane,
  DEFAULT_DESIGN,
  type Fold,
  RULES,
  SHEET,
  type Side,
  sanitizeDesign,
} from './plane'

const L = SHEET.L,
  fold = (x: number, extra: Partial<Fold> = {}): Fold => ({
    x1: x,
    y1: L / 2,
    x2: x,
    y2: -L / 2,
    angle: 40,
    ...extra,
  })
const mirrored = (pos: number[]) => {
  // is the left wing the mirror image of the right?
  const key = (i: number) =>
    [pos[i], pos[i + 1], Math.abs(pos[i + 2])].map((v) => v.toFixed(5)).join()
  const right = new Set<string>(),
    left = new Set<string>()
  for (let i = 0; i < pos.length; i += 3)
    if (Math.abs(pos[i + 2]) > 1e-9) (pos[i + 2] > 0 ? right : left).add(key(i)) // skip the centre line
  return [...left].every((k) => right.has(k))
}

test('one angle folds both halves alike; angleL bends the left half on its own', () => {
  expect(
    mirrored(buildPlane({ ...DEFAULT_DESIGN, folds: [fold(0.07)] }).pos),
  ).toBe(true)
  const d = sanitizeDesign({
    ...DEFAULT_DESIGN,
    folds: [fold(0.07, { angleL: -20 })],
  })
  expect(d.folds[0].angleL).toBe(-20)
  expect(mirrored(buildPlane(d).pos)).toBe(false)
})

test('one-sided folds and flaps only touch their half, and each half has its own limits', () => {
  const d = sanitizeDesign({
    ...DEFAULT_DESIGN,
    mirror: false,
    folds: [fold(0.07, { side: 1, angleL: 5 })],
    flaps: [],
  })
  expect(d.mirror).toBe(false)
  expect(d.folds[0]).toEqual(fold(0.07, { side: 1 })) // angleL means nothing on one half
  expect(mirrored(buildPlane(d).pos)).toBe(false)
  const many = (side: Side) =>
    Array.from({ length: RULES.maxFolds }, (_, i) =>
      fold(0.035 + i * 0.006, { side }),
    )
  expect(
    sanitizeDesign({ ...DEFAULT_DESIGN, folds: [...many(1), ...many(-1)] })
      .folds.length,
  ).toBe(2 * RULES.maxFolds)
  expect(
    sanitizeDesign({
      ...DEFAULT_DESIGN,
      folds: [...many(1), fold(0.1, { side: 1 })],
    }).folds.length,
  ).toBe(RULES.maxFolds)
  // A fold on the right may cross one that is only on the left.
  const crossing = [
    fold(0.05, { side: -1 }),
    { x1: 0.04, y1: L / 2, x2: 0.07, y2: -L / 2, angle: 20, side: 1 },
  ]
  expect(
    sanitizeDesign({ ...DEFAULT_DESIGN, folds: crossing }).folds.length,
  ).toBe(2)
})

test('the wing-root fold is a normal fold: one angle for both wings, or one each', () => {
  const root = { x1: 0.03, y1: L / 2, x2: 0.03, y2: -L / 2, angle: -80 }
  const same = sanitizeDesign({ ...DEFAULT_DESIGN, folds: [root] })
  expect(same.folds[0]?.angleL).toBeUndefined()
  expect(mirrored(buildPlane(same).pos)).toBe(true)
  const split = sanitizeDesign({
    ...DEFAULT_DESIGN,
    folds: [{ ...root, angleL: -999 }],
  })
  expect(split.folds[0]?.angleL).toBe(-180) // clamped like any fold angle
  expect(mirrored(buildPlane(split).pos)).toBe(false)
})

test('old designs keep their keel and wing V on each side', () => {
  const d = sanitizeDesign({
    ...DEFAULT_DESIGN,
    v: undefined,
    keel: 0.04,
    dihedral: 12,
    dihedralL: 2,
  })
  expect(d.folds[0]).toEqual({
    x1: 0.04,
    y1: L / 2,
    x2: 0.04,
    y2: -L / 2,
    angle: -78,
    angleL: -88,
  })
})
