import { expect, test } from 'bun:test'
import { DEFAULT_DESIGN } from './plane'
import { flyTrial, telemetry } from './trial'

test('workshop throws are repeatable and leave the design untouched', () => {
  const design = structuredClone(DEFAULT_DESIGN),
    original = structuredClone(design)
  const first = flyTrial(design),
    second = flyTrial(design)
  expect(second).toEqual(first)
  expect(design).toEqual(original)
  expect(first.outcome).toBe('landed')
  expect(first.distance).toBeGreaterThan(15)
  expect(first.time).toBeGreaterThan(2)
  expect(first.time).toBeLessThanOrEqual(30)
  expect(Math.abs(first.lateral)).toBeLessThan(0.01)
  expect(Number.isFinite(first.pitchRate)).toBe(true)
}, 30000)

test('persistent trim changes a repeatable throw', () => {
  const right = flyTrial({ ...DEFAULT_DESIGN, trimLeft: -4, trimRight: 4 })
  const left = flyTrial({ ...DEFAULT_DESIGN, trimLeft: 4, trimRight: -4 })
  expect(Math.abs(right.lateral)).toBeGreaterThan(0.03)
  expect(left.lateral).toBeCloseTo(-right.lateral, 4)
  expect(left.distance).toBeCloseTo(right.distance, 4)
}, 30000)

test('extreme folds and trim complete a finite controlled trial', () => {
  const r = flyTrial({
    ...DEFAULT_DESIGN,
    trimLeft: -12,
    trimRight: 12,
    folds: [
      { x1: 0.075, x2: 0.075, y1: 0.1485, y2: -0.1485, angle: -110 }, // deep keel, 20° anhedral
      { x1: 0.09, x2: 0.09, y1: 0.1485, y2: -0.1485, angle: 180 },
    ],
  })
  expect(
    [r.distance, r.time, r.lateral, r.pitchRate].every(Number.isFinite),
  ).toBe(true)
  expect(r.time).toBeLessThanOrEqual(30)
}, 30000)

test('a lab throw records its path from the platform to the floor', () => {
  const r = flyTrial(DEFAULT_DESIGN, { speed: 9, pitch: 10 })
  expect(r.path[0]?.p).toEqual([0, 10, 0])
  expect(r.path.at(-1)?.p[1]).toBeLessThan(0.2) // its centre, once the lowest paper touches the floor
  expect(r.path.at(-1)?.t).toBeCloseTo(r.time, 6)
  expect(r.path.every((a, i) => i === 0 || a.t > (r.path[i - 1]?.t ?? 0))).toBe(
    true,
  )
  expect(r.top).toBeGreaterThan(10) // nose up throw climbs first
  expect(r.glide).toBeCloseTo(r.distance / 10, 9)
}, 30000)

test('lab telemetry: over a glide, lift carries the weight and drag always slows it', () => {
  const r = flyTrial(DEFAULT_DESIGN),
    // The second half: past the launch, while it porpoises down to the floor.
    late = r.path.slice(r.path.length / 2).map(telemetry),
    mean = (f: (t: (typeof late)[number]) => number) =>
      late.reduce((sum, t) => sum + f(t), 0) / late.length,
    weight = r.mass * 9.81
  expect(mean((t) => t.lift)).toBeGreaterThan(weight * 0.6)
  expect(mean((t) => t.lift)).toBeLessThan(weight * 1.4)
  expect(late.every((t) => t.drag > 0)).toBe(true)
  expect(mean((t) => t.sink)).toBeGreaterThan(0)
  expect(late.every((t) => Math.abs(t.bank) < 1)).toBe(true) // a symmetric plane flies straight
}, 30000)
