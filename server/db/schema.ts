import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'
import type { HatId } from '../../shared/items'
import type { Quat, Vec3 } from '../../shared/plane'

// Planes that landed and stay in the city. Paint is a PNG stored next to the database, keyed by id.
export const planes = sqliteTable(
  'planes',
  {
    id: integer('id').primaryKey(),
    pid: text('pid'), // private player id; never sent to other players
    name: text('name').notNull(),
    hat: text('hat').$type<HatId>(),
    design: text('design', { mode: 'json' }).notNull(),
    paint: integer('paint', { mode: 'boolean' }).notNull().default(false),
    p: text('p', { mode: 'json' }).$type<Vec3>().notNull(), // resting position
    q: text('q', { mode: 'json' }).$type<Quat>().notNull(), // resting orientation
    dist: real('dist').notNull(),
    where: text('where').notNull(),
    time: integer('time').notNull(), // seconds in the air
    at: integer('at').notNull(), // landing time, ms since epoch
  },
  (t) => [index('planes_pid').on(t.pid)],
)

export const collections = sqliteTable('collections', {
  pid: text('pid').primaryKey(),
  owned: text('owned', { mode: 'json' }).$type<HatId[]>().notNull(),
  equipped: text('equipped').$type<HatId>(),
})
