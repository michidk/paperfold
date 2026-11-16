import { expect, test } from 'bun:test'
import { collectItems, PICKUPS, readCollection } from './items'
import { CITY } from './world'

test('flying through an item collects it even between simulation samples', () => {
  expect(collectItems([15, 46, 0], [30, 46, 0], [])).toEqual(['top-hat'])
  expect(collectItems([15, 50, 0], [30, 50, 0], [])).toEqual([])
  expect(collectItems([24, 46, 0], [24, 46, 0], [])).toEqual(['top-hat'])
})
test('collecting is per player and does not consume another player’s item', () => {
  expect(collectItems([15, 46, 0], [30, 46, 0], ['top-hat'])).toEqual([])
  expect(collectItems([15, 46, 0], [30, 46, 0], [])).toEqual(['top-hat'])
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
