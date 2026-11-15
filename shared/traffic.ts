// Cars in the streets and people on the pavements. They move along fixed loops as a function of world
// time alone, so the server and every browser agree where they are, and planes can hit them.
// Each speed is a whole number of loops per WIND_CYCLE, so the motion repeats seamlessly every hour.
import { BLOCK, CELL, GRID, mulberry32, type Solid, WIND_CYCLE } from './world'

export interface Mover extends Solid {
  kind: 'car' | 'person'
  heading: number // radians, 0 = +x, towards +z
  color: number
}
export const MOVER_TOP = 1.9 // nothing moving is taller; planes above it skip the check

const EDGE = GRID * CELL + CELL / 2, // cars drive off one side of the city and come back on the other
  ROAD = 2 * EDGE,
  WALK = BLOCK + 2, // people walk a square just inside the pavement slab's edge
  CAR_COLORS = [
    0xe63946, 0x1d3557, 0xf4a261, 0x2a9d8f, 0xffffff, 0x8338ec, 0xffbe0b,
  ],
  CLOTHES = [
    0xe76f51, 0x264653, 0xe9c46a, 0x6a4c93, 0x1982c4, 0x8ac926, 0xff595e,
  ]

const r = mulberry32(777)
const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)] as T
// Two cars on each street between blocks, one per direction, in their own lanes.
const CARS: {
  along: 'x' | 'z'
  at: number
  dir: 1 | -1
  start: number
  laps: number
  color: number
}[] = []
for (let i = -GRID; i < GRID; i++)
  for (const along of ['x', 'z'] as const)
    for (const dir of [1, -1] as const)
      CARS.push({
        along,
        at: (i + 0.5) * CELL + dir * 1.8, // drive on the right
        dir,
        start: r() * ROAD,
        laps: 40 + Math.floor(r() * 25), // 5.9 to 9.5 m/s
        color: pick(CAR_COLORS),
      })
// People around the blocks near the tower, where planes land most.
const PEOPLE: {
  x: number
  z: number
  dir: 1 | -1
  start: number
  laps: number
  color: number
}[] = []
for (let i = -3; i <= 3; i++)
  for (let j = -3; j <= 3; j++)
    for (let k = 0; k < 2; k++)
      PEOPLE.push({
        x: i * CELL,
        z: j * CELL,
        dir: r() < 0.5 ? 1 : -1,
        start: r() * 4 * WALK,
        laps: 27 + Math.floor(r() * 10), // 1.1 to 1.5 m/s
        color: pick(CLOTHES),
      })

const wrap = (v: number, n: number) => ((v % n) + n) % n
const box = (x: number, z: number, hx: number, hz: number, y1: number) => ({
  x0: x - hx,
  x1: x + hx,
  z0: z - hz,
  z1: z + hz,
  y1,
})

// Everything moving at world time t (seconds, as from worldTime).
export function moversAt(t: number): Mover[] {
  const out: Mover[] = []
  for (const c of CARS) {
    const s =
      wrap(c.start + (c.dir * c.laps * ROAD * t) / WIND_CYCLE, ROAD) - EDGE
    const [x, z] = c.along === 'x' ? [s, c.at] : [c.at, s]
    const [hx, hz] = c.along === 'x' ? [2, 0.9] : [0.9, 2]
    out.push({
      ...box(x, z, hx, hz, 1.5),
      kind: 'car',
      heading:
        c.along === 'x'
          ? c.dir > 0
            ? 0
            : Math.PI
          : c.dir > 0
            ? Math.PI / 2
            : -Math.PI / 2,
      color: c.color,
    })
  }
  for (const p of PEOPLE) {
    // Round the square: four sides of WALK metres, starting at its -x,-z corner.
    const s = wrap(
        p.start + (p.dir * p.laps * 4 * WALK * t) / WIND_CYCLE,
        4 * WALK,
      ),
      side = Math.floor(s / WALK),
      u = s - side * WALK - WALK / 2,
      h = WALK / 2
    const [dx, dz, heading] = (
      [
        [u, -h, 0],
        [h, u, Math.PI / 2],
        [-u, h, Math.PI],
        [-h, -u, -Math.PI / 2],
      ] as const
    )[side] ?? [0, 0, 0]
    out.push({
      ...box(p.x + dx, p.z + dz, 0.3, 0.3, 1.8),
      kind: 'person',
      heading: p.dir > 0 ? heading : heading + Math.PI,
      color: p.color,
    })
  }
  return out
}
