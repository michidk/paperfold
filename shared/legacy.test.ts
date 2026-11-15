import { expect, test } from 'bun:test'
import legacy from './fixtures/legacy-planes.json'
import { buildPlane, planeStats } from './plane'
import { flyTrial } from './trial'

// Recorded from the model before the keel and wing V became an ordinary fold. Saved and landed
// planes are converted on load; they must keep their paper, shape and flight.
const near = (a: number, b: number, pct: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual((Math.abs(b) * pct) / 100 + 1e-9)

test('designs from before every fold was drawn fly as they did', () => {
  for (const old of Object.values(legacy)) {
    const m = buildPlane(old.design),
      st = planeStats(m),
      run = flyTrial(old.design)
    near(m.mass, old.mass, 0.1)
    near(st.span, old.span, 0.5)
    near(st.area, old.area, 2)
    for (const [i, v] of m.inertia.entries()) near(v, old.inertia[i] ?? 0, 5)
    near(run.distance, old.distance, 10)
  }
}, 60000)
