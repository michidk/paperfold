import { expect, test } from 'bun:test'
import { buildPlane, DEFAULT_DESIGN, SHEET } from './plane'
import { selfIntersects } from './selfhit'

test('the default dart does not pass through itself', () => {
  expect(selfIntersects(buildPlane(DEFAULT_DESIGN).pos)).toBe(false)
})

test('a wing folded back through the body is caught', () => {
  const x = 0.06,
    fold = { x1: x, y1: SHEET.L / 2, x2: x, y2: -SHEET.L / 2 }
  const flat = selfIntersects(
    buildPlane({ ...DEFAULT_DESIGN, folds: [{ ...fold, angle: 30 }] }).pos,
  )
  const through = [-170, 170].some((angle) =>
    selfIntersects(
      buildPlane({ ...DEFAULT_DESIGN, folds: [{ ...fold, angle }] }).pos,
    ),
  )
  expect(flat).toBe(false)
  expect(through).toBe(true)
})
