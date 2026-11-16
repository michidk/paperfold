// The only module that knows which database is behind Drizzle. Moving to Cloudflare D1 or another
// SQLite-compatible store means changing this file; callers already await every query.
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { Collection } from '../../shared/items'
import { collections, planes } from './schema'

export type Plane = typeof planes.$inferSelect

export function openDb(dataDir: string) {
  const sqlite = new Database(join(dataDir, 'paperfold.db'), { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  const db = drizzle(sqlite)
  migrate(db, {
    migrationsFolder: join(import.meta.dir, '..', '..', 'drizzle'),
  })
  importLegacyJson(db, join(dataDir, 'planes.json'))
  return {
    listPlanes: async (): Promise<Plane[]> =>
      db.select().from(planes).orderBy(planes.id),
    addPlane: async (rec: Plane) => {
      await db.insert(planes).values(rec)
    },
    listCollections: async () => db.select().from(collections),
    saveCollection: async (pid: string, collection: Collection) => {
      await db
        .insert(collections)
        .values({ pid, ...collection })
        .onConflictDoUpdate({
          target: collections.pid,
          set: collection,
        })
    },
    close: () => sqlite.close(),
  }
}

// Before the database, landed planes lived in planes.json. Import them once, then set the file aside.
function importLegacyJson(db: ReturnType<typeof drizzle>, file: string) {
  if (!existsSync(file)) return
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Plane[]
  db.transaction((tx) => {
    for (const r of rows)
      tx.insert(planes)
        .values({ ...r, pid: r.pid ?? null })
        .onConflictDoNothing()
        .run()
  })
  renameSync(file, `${file}.imported`)
}
