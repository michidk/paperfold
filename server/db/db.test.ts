import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Plane } from './index'

const plane: Plane = {
  id: 1,
  pid: 'abc',
  name: 'Lucky Moth',
  hat: null,
  design: { nose: 0.1 },
  paint: true,
  p: [1, 0, 2],
  q: [0, 0, 0, 1],
  dist: 12,
  where: 'street',
  time: 4,
  at: 1,
}

test('planes survive a restart, and planes.json is imported once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paperfold-db-'))
  writeFileSync(
    join(dir, 'planes.json'),
    JSON.stringify([{ ...plane, pid: undefined }]),
  )
  const db = openDb(dir)
  expect(await db.listPlanes()).toEqual([{ ...plane, pid: null }])
  expect(existsSync(join(dir, 'planes.json'))).toBe(false)
  await db.addPlane({ ...plane, id: 2 })
  db.close()
  const again = openDb(dir)
  expect(
    (await again.listPlanes()).map((p) => [p.id, p.pid, p.design]),
  ).toEqual([
    [1, null, { nose: 0.1 }],
    [2, 'abc', { nose: 0.1 }],
  ])
  again.close()
})

test('collected and equipped hats survive restarts independently for each player', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paperfold-items-'))
  const db = openDb(dir)
  await db.saveCollection('alice', { owned: ['top-hat'], equipped: null })
  await db.saveCollection('bob', {
    owned: ['wizard-hat'],
    equipped: 'wizard-hat',
  })
  await db.saveCollection('alice', {
    owned: ['top-hat', 'crown'],
    equipped: 'crown',
  })
  db.close()
  const again = openDb(dir)
  expect(await again.listCollections()).toEqual([
    { pid: 'alice', owned: ['top-hat', 'crown'], equipped: 'crown' },
    { pid: 'bob', owned: ['wizard-hat'], equipped: 'wizard-hat' },
  ])
  await again.addPlane({ ...plane, hat: 'crown' })
  expect((await again.listPlanes())[0].hat).toBe('crown')
  again.close()
})
