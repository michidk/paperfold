import { expect, test } from 'bun:test'
import { limitAngle, splitFold } from './fold-edit'
import { buildPlane, DEFAULT_DESIGN, type Design } from './plane'
import { selfIntersects } from './selfhit'

test('separating symmetry preserves each angle and lets either crease move alone', () => {
  const [right, left] = splitFold({ ...DEFAULT_DESIGN.folds[0], angleL: -48 })
  right.x1 = 0.04
  right.x2 = 0.04
  expect(left.x1).toBe(0.03)
  expect(left.x2).toBe(0.03)
  expect(right.angle).toBe(-84)
  expect(left.angle).toBe(-48)
  expect(right.side).toBe(1)
  expect(left.side).toBe(-1)
  expect('angleL' in left).toBe(false)
})

test('a wing root stops at the closed centre seam on either half', () => {
  const d: Design = {
    ...DEFAULT_DESIGN,
    flaps: [],
    folds: [DEFAULT_DESIGN.folds[0]],
  }
  expect(limitAngle(d, 'fold', 0, 'angle', 84)).toBe(0)
  expect(limitAngle(d, 'fold', 0, 'angleL', 84)).toBe(0)
  expect(limitAngle(d, 'fold', 0, 'angle', -48)).toBe(-48)
})

test('an angle edit stops before intersecting another paper panel', () => {
  const d: Design = {
    ...DEFAULT_DESIGN,
    folds: DEFAULT_DESIGN.folds.map((f, i) => (i ? f : { ...f, angleL: -84 })),
  }
  const angle = limitAngle(d, 'fold', 0, 'angle', -48)
  expect(angle).toBeGreaterThanOrEqual(-84)
  expect(angle).toBeLessThan(-48)
  expect(
    selfIntersects(
      buildPlane({
        ...d,
        folds: d.folds.map((f, i) => (i ? f : { ...f, angle })),
      }).pos,
    ),
  ).toBe(false)
})

test('independent wing roots obey the seam limit after their positions diverge', () => {
  const [right, left] = splitFold(DEFAULT_DESIGN.folds[0])
  const d: Design = {
    ...DEFAULT_DESIGN,
    flaps: [],
    folds: [{ ...right, x1: 0.04, x2: 0.04 }, left],
  }
  for (const index of [0, 1]) {
    const angle = limitAngle(d, 'fold', index, 'angle', 60)
    expect(angle).toBeLessThanOrEqual(0)
    expect(
      selfIntersects(
        buildPlane({
          ...d,
          folds: d.folds.map((f, i) => (i === index ? { ...f, angle } : f)),
        }).pos,
      ),
    ).toBe(false)
  }
})

test('outer folds can still fold upward', () => {
  const d: Design = { ...DEFAULT_DESIGN, flaps: [] }
  expect(limitAngle(d, 'fold', 1, 'angle', 40)).toBe(40)
})
