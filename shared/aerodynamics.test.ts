import { expect, test } from 'bun:test'
import { coefficients, panelForce } from './aerodynamics'
import type { Vec3 } from './plane'

test('lift reverses with incidence and drag remains positive through stall and reverse flight', () => {
  for (const angle of [0, 0.1, 0.3, 0.6, 1.2, Math.PI / 2]) {
    const a = coefficients(angle, 3),
      b = coefficients(-angle, 3)
    expect(a.lift).toBeCloseTo(-b.lift, 10)
    expect(a.drag).toBeGreaterThan(0)
    expect(a.drag).toBeCloseTo(b.drag, 10)
  }
  expect(coefficients(0.25, 3).lift).toBeGreaterThan(coefficients(0.65, 3).lift)
})

test('shorter span costs more induced drag for the same lift', () => {
  const wide = coefficients(0.1, 5)
  let low = 0,
    high = 0.4
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2
    if (coefficients(mid, 1).lift < wide.lift) low = mid
    else high = mid
  }
  const narrow = coefficients((low + high) / 2, 1)
  expect(narrow.lift).toBeCloseTo(wide.lift, 6)
  expect(narrow.drag).toBeGreaterThan(wide.drag)
})

test('stall blending is continuous', () => {
  for (let a = -Math.PI / 2; a < Math.PI / 2; a += 0.001) {
    const before = coefficients(a, 2),
      after = coefficients(a + 0.001, 2)
    expect(Math.abs(before.lift - after.lift)).toBeLessThan(0.02)
    expect(Math.abs(before.drag - after.drag)).toBeLessThan(0.02)
  }
})

test('panel forces oppose relative motion at every tested attitude, including reverse flow', () => {
  for (const normal of [
    [0, 1, 0],
    [0, 0, 1],
    [0.6, 0.8, 0],
  ] as Vec3[]) {
    for (const flow of [
      [-7, -1, 0],
      [7, 1, 0],
      [0, 5, 0],
      [0, 0, 0],
      [1, -2, 3],
    ] as Vec3[]) {
      const { force } = panelForce(flow, normal, 0.02, 2, normal[1] ** 2)
      expect(force.every(Number.isFinite)).toBe(true)
      // Flow points opposite to the panel's velocity relative to the air.
      expect(
        force.reduce((sum, v, i) => sum + v * flow[i], 0),
      ).toBeGreaterThanOrEqual(-1e-12)
    }
  }
})

const slippingWing = (degrees: number) => {
  const b = (degrees * Math.PI) / 180
  const flow: Vec3 = [-7 * Math.cos(b), -0.7, -7 * Math.sin(b)]
  const result = panelForce(flow, [0, 1, 0], 0.02, 3, 1)
  const speed = Math.hypot(...flow)
  const direction = flow.map((v) => v / speed)
  const liftDirection = direction.map(
    (v, i) =>
      ((i === 1 ? 1 : 0) - direction[1] * v) / Math.sqrt(1 - direction[1] ** 2),
  )
  return {
    ...result,
    lift: -result.force.reduce((sum, v, i) => sum + v * liftDirection[i], 0),
    drag: result.force.reduce((sum, v, i) => sum + v * direction[i], 0),
  }
}

test('large sideways slips lose wing support and add drag while small slips stay forgiving', () => {
  const straight = slippingWing(0),
    gentle = slippingWing(15),
    sideways = slippingWing(70)
  expect(gentle.lift).toBeCloseTo(straight.lift, 8)
  expect(sideways.lift).toBeLessThan(straight.lift * 0.7)
  expect(sideways.drag).toBeGreaterThan(straight.drag * 5)
  expect(sideways.pressure).toBeLessThan(0.1)
  expect(slippingWing(-70).lift).toBeCloseTo(sideways.lift, 10)
})

test('sideways separation is smooth, dissipates energy and recovers when aligned', () => {
  let before = slippingWing(0)
  for (let degrees = 0.5; degrees <= 180; degrees += 0.5) {
    const after = slippingWing(degrees)
    expect(after.drag).toBeGreaterThanOrEqual(0)
    expect(Math.abs(after.lift - before.lift)).toBeLessThan(0.01)
    expect(Math.abs(after.drag - before.drag)).toBeLessThan(0.03)
    before = after
  }
  expect(slippingWing(0).pressure).toBe(1)
  const keel = panelForce([-4, -0.7, -5], [0, 0, 1], 0.01, 3, 0)
  expect(keel.force.every(Number.isFinite)).toBe(true)
})
