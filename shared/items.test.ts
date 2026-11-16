import { expect, test } from 'bun:test'
import { Box3, Ray, Vector3 } from 'three'
import { collectItems, PICKUPS, readCollection } from './items'
import { CITY, TOWER } from './world'

test('flying through an item collects it even between simulation samples', () => {
  expect(collectItems([-18, 28, -72], [0, 28, -72], [])).toEqual(['top-hat'])
  expect(collectItems([-18, 33, -72], [0, 33, -72], [])).toEqual([])
  expect(collectItems([-9, 28, -72], [-9, 28, -72], [])).toEqual(['top-hat'])
})
test('collecting is per player and does not consume another player’s item', () => {
  expect(collectItems([-18, 28, -72], [0, 28, -72], ['top-hat'])).toEqual([])
  expect(collectItems([-18, 28, -72], [0, 28, -72], [])).toEqual(['top-hat'])
})
test('saved collections cannot equip unowned or unknown hats', () => {
  expect(
    readCollection({
      owned: ['top-hat', 'top-hat', 'unknown'],
      equipped: 'crown',
    }),
  ).toEqual({ owned: ['top-hat'], equipped: null })
  expect(
    readCollection({ owned: ['wizard-hat'], equipped: 'wizard-hat' }),
  ).toEqual({
    owned: ['wizard-hat'],
    equipped: 'wizard-hat',
  })
  expect(readCollection(null)).toEqual({ owned: [], equipped: null })
})
test('pickups are outside the city solids with room to fly through', () => {
  for (const {
    p: [x, y, z],
    radius,
  } of PICKUPS)
    expect(
      CITY.solids.some(
        (s) =>
          x + radius > s.x0 &&
          x - radius < s.x1 &&
          z + radius > s.z0 &&
          z - radius < s.z1 &&
          y - radius < s.y1,
      ),
    ).toBe(false)
})

test('buildings conceal every pickup from launch viewpoints around the tower', () => {
  const buildings = CITY.buildings
    .filter((building) => !building.tower)
    .map(
      (building) =>
        new Box3(
          new Vector3(building.x0, 0, building.z0),
          new Vector3(building.x1, building.y1, building.z1),
        ),
    )
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4
    const origin = new Vector3(
      Math.cos(angle) * 10,
      TOWER.h + 4,
      Math.sin(angle) * 10,
    )
    for (const { p, radius } of PICKUPS) {
      // Check the pickup's whole extent, not only its centre.
      for (const dx of [-radius, 0, radius])
        for (const dy of [-radius, 0, radius])
          for (const dz of [-radius, 0, radius]) {
            const point = new Vector3(p[0] + dx, p[1] + dy, p[2] + dz)
            const ray = new Ray(origin, point.clone().sub(origin).normalize())
            expect(
              buildings.some((building) => {
                const hit = ray.intersectBox(building, new Vector3())
                return (
                  hit !== null &&
                  hit.distanceTo(origin) < point.distanceTo(origin)
                )
              }),
            ).toBe(true)
          }
    }
  }
})
