import { expect, test } from 'bun:test'
import { resolveContact, sweepContact } from './contact'
import {
  buildPlane,
  DEFAULT_DESIGN,
  launchState,
  type State,
  type Vec3,
} from './plane'

const box = { x0: 1, x1: 1.1, z0: -1, z1: 1, y1: 5 }

test('a swept nose hits a thin wall even when the centre never enters it', () => {
  const before = launchState([0, 2, 0], 0, 0, 10)
  const after = { ...before, p: [2, 2, 0] as Vec3 }
  const hit = sweepContact(before, after, [[0.15, 0, 0]], [box])
  expect(hit?.normal).toEqual([-1, 0, 0])
  expect(hit?.t).toBeCloseTo(0.425, 8)
})

test('wing contact generates torque and does not add kinetic energy', () => {
  const model = buildPlane(DEFAULT_DESIGN)
  const s = launchState([0, 2, 0], 0, 0, 8)
  const energy = (s: State) =>
    (model.mass * s.v.reduce((a, v) => a + v * v, 0)) / 2 +
    s.w.reduce((a, w, i) => a + model.inertia[i] * w * w, 0) / 2
  const initial = energy(s)
  resolveContact(s, model, { normal: [-1, 0, 0], r: [0, 0, 0.07] })
  expect(Math.abs(s.w[1])).toBeGreaterThan(0.1)
  expect(s.v[0]).toBeLessThan(8)
  expect(energy(s)).toBeLessThan(initial)
  const separating = launchState([0, 2, 0], 0, 0, -8)
  resolveContact(separating, model, { normal: [-1, 0, 0], r: [0, 0, 0.07] })
  expect(separating.v).toEqual([-8, 0, 0])
  expect(separating.w).toEqual([0, 0, 0])
})

test('the lowest paper point reaches the floor before the centre', () => {
  const before = launchState([0, 0.1, 0], 0, 0, 0)
  const after = { ...before, p: [0, 0.01, 0] as Vec3 }
  const hit = sweepContact(before, after, [[0, -0.03, 0]], [])
  expect(hit?.normal).toEqual([0, 1, 0])
  expect(hit?.t).toBeCloseTo(7 / 9, 8)
  expect(hit?.box).toBe(null)
})

test('roof entry and wall entry are distinguished by the swept face', () => {
  const before = launchState([1.05, 6, 0], 0, 0, 0)
  expect(
    sweepContact(before, { ...before, p: [1.05, 4, 0] }, [[0, 0, 0]], [box])
      ?.normal,
  ).toEqual([0, 1, 0])
})
