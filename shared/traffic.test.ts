import { expect, test } from 'bun:test'
import { Flight } from './flight'
import { DEFAULT_DESIGN, launchState } from './plane'
import { moversAt } from './traffic'
import { CITY, WIND_CYCLE } from './world'

test('traffic repeats seamlessly every hour', () => {
  const a = moversAt(0.4),
    b = moversAt(WIND_CYCLE + 0.4)
  a.forEach((m, i) => {
    expect(b[i]?.x0).toBeCloseTo(m.x0, 6)
    expect(b[i]?.z0).toBeCloseTo(m.z0, 6)
  })
})

test('cars and people never drive or walk through buildings or trees', () => {
  for (let t = 0; t < WIND_CYCLE; t += 37.3)
    for (const m of moversAt(t))
      for (const s of CITY.solids)
        expect(m.x0 < s.x1 && s.x0 < m.x1 && m.z0 < s.z1 && s.z0 < m.z1).toBe(
          false,
        )
})

test('a plane dropped onto a car lands on it, and ends up in the street', () => {
  const car = moversAt(100).find((m) => m.kind === 'car')
  if (!car) throw new Error('no cars')
  const x = (car.x0 + car.x1) / 2,
    z = (car.z0 + car.z1) / 2
  // Start just above the car's roof, falling, at the moment it is there.
  const f = new Flight(
    DEFAULT_DESIGN,
    launchState([x, 1.6, z], 0, -1.2, 1),
    0,
    100,
  )
  for (let i = 0; i < 200 && !f.landing; i++) f.advance()
  expect(f.landing).toEqual({ y: 0, where: 'car' })
})
