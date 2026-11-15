// Deterministic toy city shared by server (collision, wind) and client (rendering).
import type { Vec3 } from './plane'

// A box standing on the ground: a building, the tower, or a tree's crown.
export interface Solid {
  x0: number
  x1: number
  z0: number
  z1: number
  y1: number
  color?: number
  tower?: boolean
  tree?: boolean
}
export interface WindZone {
  x: number
  z: number
  r: number
  speed: number
  dir: number
  swing: number
  period: number
  phase: number
  top: number
}

export const CELL = 48,
  BLOCK = 36,
  GRID = 5
export const TOWER = { half: 5, h: 48 }
export const SPAWN_H = TOWER.h + 1.6
export const BREEZE: Vec3 = [0.8, 0, 0.4]
export const PALETTE = [
  0xffd166, 0xef8354, 0x7fc8a9, 0x9fa8da, 0xf4a6c0, 0x8ecae6, 0xf6bd60,
  0xcdb4db, 0xb5e48c,
]

export function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildCity() {
  const r = mulberry32(20261114)
  const buildings: Solid[] = [],
    trees: { x: number; z: number; h: number }[] = [],
    blocks: { x: number; z: number; park: boolean }[] = [],
    parks: [number, number][] = []
  buildings.push({
    x0: -TOWER.half,
    x1: TOWER.half,
    z0: -TOWER.half,
    z1: TOWER.half,
    y1: TOWER.h,
    color: 0xff6b6b,
    tower: true,
  })
  for (let i = -GRID; i <= GRID; i++)
    for (let j = -GRID; j <= GRID; j++) {
      const cx = i * CELL,
        cz = j * CELL,
        dist = Math.hypot(cx, cz)
      const park = !(i === 0 && j === 0) && r() < 0.15
      blocks.push({ x: cx, z: cz, park: park || (i === 0 && j === 0) })
      if (i === 0 && j === 0) continue
      if (park) {
        parks.push([cx, cz])
        for (let t = 0; t < 7; t++)
          trees.push({
            x: cx + (r() - 0.5) * 30,
            z: cz + (r() - 0.5) * 30,
            h: 4 + r() * 4,
          })
        continue
      }
      const lots = r() < 0.3 ? 1 : 2,
        size = BLOCK / lots
      for (let a = 0; a < lots; a++)
        for (let b = 0; b < lots; b++) {
          const x0 = cx - BLOCK / 2 + a * size + 1.5,
            z0 = cz - BLOCK / 2 + b * size + 1.5
          buildings.push({
            x0,
            x1: x0 + size - 3,
            z0,
            z1: z0 + size - 3,
            y1: Math.min(42, 5 + r() ** 2 * 30 + Math.max(0, 20 - dist * 0.08)),
            color: PALETTE[Math.floor(r() * PALETTE.length)],
          })
        }
    }
  // Thermals rise over the sun-baked parks nearest the tower, where throws can reach them.
  const thermals = parks
    .sort((a, b) => Math.hypot(...a) - Math.hypot(...b))
    .slice(0, 6)
    .map(([x, z]) => ({ x, z, r: 9, u: 3.2, top: 95 }))
  const solids: Solid[] = [
    ...buildings,
    ...trees.map((t) => ({
      x0: t.x - 1.4,
      x1: t.x + 1.4,
      z0: t.z - 1.4,
      z1: t.z + 1.4,
      y1: t.h,
      tree: true,
    })),
  ]
  return { buildings, trees, blocks, thermals, solids }
}
export const CITY = buildCity()

// Windy crossroads: gusty wind funnelling down the streets. Each zone blows along a direction that swings
// back and forth over a few minutes, with gusts on top. Time t is world seconds (worldTime), the same
// for everyone; every period divides WIND_CYCLE so the pattern repeats seamlessly each hour.
export const WIND_CYCLE = 3600
export const worldTime = (ms = Date.now()) => (ms / 1000) % WIND_CYCLE
function buildWindZones() {
  const r = mulberry32(4242),
    zones: WindZone[] = [],
    periods = [60, 90, 120, 150, 180, 240]
  while (zones.length < 8) {
    const i = Math.floor(r() * 2 * GRID) - GRID,
      j = Math.floor(r() * 2 * GRID) - GRID
    const x = (i + 0.5) * CELL,
      z = (j + 0.5) * CELL,
      d = Math.hypot(x, z) // a crossroads, so no buildings
    if (
      d < 25 ||
      d > 110 || // within reach of an ordinary throw
      zones.some((o) => Math.hypot(o.x - x, o.z - z) < 45)
    )
      continue
    zones.push({
      x,
      z,
      r: 24 + r() * 12,
      speed: 2.5 + r() * 3,
      dir: r() * Math.PI * 2,
      swing: 0.6 + r() * 0.9,
      period: periods[Math.floor(r() * periods.length)],
      phase: r() * Math.PI * 2,
      top: 55,
    })
  }
  return zones
}
export const WIND_ZONES = buildWindZones()
// Direction (radians, 0 = +x, towards +z) and speed of a zone's wind at time t.
export function zoneWind(zone: WindZone, t: number) {
  const a = (2 * Math.PI * t) / zone.period
  return {
    dir: zone.dir + zone.swing * Math.sin(a + zone.phase),
    speed: zone.speed * (0.75 + 0.25 * Math.sin(5 * a)),
  }
}
// Wind from the windy zones alone at point p and time t.
export function gustAt(p: readonly number[], t = 0) {
  const w: Vec3 = [0, 0, 0]
  for (const zone of WIND_ZONES) {
    const d2 = (p[0] - zone.x) ** 2 + (p[2] - zone.z) ** 2
    if (d2 >= zone.r * zone.r || p[1] >= zone.top) continue
    const fade =
      (1 - d2 / (zone.r * zone.r)) ** 2 *
      Math.min(1, (Math.max(0, p[1]) + 2) / 8) *
      Math.min(1, (zone.top - p[1]) / 15)
    const { dir, speed } = zoneWind(zone, t)
    w[0] += Math.cos(dir) * speed * fade
    w[2] += Math.sin(dir) * speed * fade
  }
  return w
}

export function windAt(p: readonly number[], t = 0) {
  const k = Math.min(1, Math.max(0, p[1]) / 25),
    g = gustAt(p, t)
  const w: Vec3 = [BREEZE[0] * k + g[0], 0, BREEZE[2] * k + g[2]]
  for (const t of CITY.thermals) {
    const d2 = (p[0] - t.x) ** 2 + (p[2] - t.z) ** 2
    if (d2 < t.r * t.r && p[1] < t.top) w[1] += t.u * (1 - d2 / (t.r * t.r))
  }
  return w
}

export function surfaceAt(x: number, z: number) {
  let y = 0
  for (const b of CITY.solids)
    if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) y = Math.max(y, b.y1)
  return y
}

export const spawnPoint = (yaw: number): Vec3 => [
  Math.cos(yaw) * 4.2,
  SPAWN_H,
  -Math.sin(yaw) * 4.2,
]
