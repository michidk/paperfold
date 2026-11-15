import { expect, test } from 'bun:test'
import type { Vec3 } from './plane'
import { exposedSurfaces } from './surfaces'

const rect = (
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y = 0,
): { pts: Vec3[] } => ({
  pts: [
    [x0, y, z0],
    [x0, y, z1],
    [x1, y, z1],
    [x1, y, z0],
  ],
})
const area = (parts: { pts: Vec3[] }[]) =>
  exposedSurfaces(parts).reduce((a, p) => a + p.a, 0)

test('overlapping layers count their union regardless of polygon winding or order', () => {
  const a = rect(0, 2, 0, 1),
    b = rect(1, 3, 0, 1)
  b.pts.reverse()
  expect(area([a, b])).toBeCloseTo(3, 10)
  expect(area([b, a])).toBeCloseTo(3, 10)
  expect(area([a, a, a])).toBeCloseTo(2, 10)
})

test('adjacent and separated paper remains exposed', () => {
  expect(area([rect(0, 1, 0, 1), rect(1, 2, 0, 1)])).toBeCloseTo(2, 10)
  expect(area([rect(0, 1, 0, 1), rect(0, 1, 0, 1, 0.01)])).toBeCloseTo(2, 10)
})
