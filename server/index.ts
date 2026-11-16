import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { DT, Flight, type Input } from '../shared/flight'
import {
  type Collection,
  collectItems,
  type HatId,
  isHat,
  readCollection,
} from '../shared/items'
import {
  D2R,
  type Design,
  launchState,
  restPose,
  sanitizeDesign,
  type Vec3,
} from '../shared/plane'
import { spawnPoint, surfaceAt, worldTime } from '../shared/world'
import { openDb, type Plane } from './db'

const ROOT = join(import.meta.dir, '..')
const DATA = process.env.DATA_DIR ?? join(ROOT, 'data')
const PAINT = join(DATA, 'paint')
mkdirSync(PAINT, { recursive: true })
const db = openDb(DATA)

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TICK_MS = 50,
  MAX_FLIGHT_S = 180
// The thrower's browser simulates ahead; the server follows the step count it reports, never ahead
// of real time, and runs on its own once the browser falls more than STALL_STEPS behind.
const LEAD_STEPS = 30,
  STALL_STEPS = 1500,
  MAX_QUEUED_INPUTS = 2000,
  THROW_GAP_MS = 1500 // at most one throw per connection this often: each can store a few MB of paint

type Landed = Plane
// A plane in the air: the official simulation, and the inputs its thrower sent ahead of it.
interface LiveFlight {
  id: number
  name: string
  design: Design
  paint: boolean
  hat: HatId | null
  sim: Flight
  start: number
  clientStep: number
  inputs: Input[]
  ws: Socket
}
// What a player is doing, as their browser reports it; several tabs show the most active one.
const STATUSES = [
  'flying',
  'aiming',
  'folding',
  'results',
  'replay',
  'exploring',
  'watching',
  'lab',
  'arriving',
] as const
type Status = (typeof STATUSES)[number]
interface SocketData {
  name: string
  pid: string
  flight: LiveFlight | null
  status: Status
  lastThrow: number // performance.now() of this connection's last throw
}
type Socket = ServerWebSocket<SocketData>
// A message from a browser: parsed JSON, so every field is checked before use.
type ClientMessage = Record<string, unknown>
const MIN_DIST = 5 // throws that land closer to the tower than this (metres) don't stay in the city
// Everyone gets every landed plane on connect, so they are kept in memory too.
const stored = await db.listPlanes()
const landed: Landed[] = stored.filter((r) => r.dist >= MIN_DIST)
// Player ids stay private: they identify a browser across reloads, so never send them to other clients.
const publicRec = ({ pid, ...rec }: Landed) => rec
const bestByPid = new Map<string, number>()
const recordBest = (rec: Landed) =>
  rec.pid &&
  bestByPid.set(rec.pid, Math.max(bestByPid.get(rec.pid) ?? 0, rec.dist))
landed.forEach(recordBest)
const sockets = new Set<Socket>()
const collections = new Map<string, Collection>(
  (await db.listCollections()).map((row) => [row.pid, readCollection(row)]),
)
const collectionFor = (pid: string): Collection =>
  collections.get(pid) ?? { owned: [], equipped: null }
function sendCollection(pid: string, collected: HatId[] = []) {
  for (const socket of sockets)
    if (socket.data.pid === pid)
      socket.send(
        JSON.stringify({ t: 'collection', ...collectionFor(pid), collected }),
      )
}
function saveCollection(
  pid: string,
  collection: Collection,
  collected: HatId[] = [],
) {
  collections.set(pid, collection)
  db.saveCollection(pid, collection).catch((error) =>
    console.error('could not save collected items:', error),
  )
  sendCollection(pid, collected)
}

// Live board: everyone connected now, merged per player (several tabs count once), sent with a "you" flag.
function sendPlayers() {
  const players = new Map<
    string,
    {
      pid: string
      name: string
      best: number
      flying: boolean
      flight: number | null
      status: Status
    }
  >()
  for (const ws of sockets) {
    const { pid, name, flight } = ws.data,
      status = flight ? 'flying' : ws.data.status,
      p = players.get(pid)
    if (p) {
      p.flying ||= !!flight
      p.flight ??= flight?.id ?? null
      if (STATUSES.indexOf(status) < STATUSES.indexOf(p.status))
        p.status = status
      continue
    }
    players.set(pid, {
      pid,
      name,
      best: bestByPid.get(pid) ?? 0,
      flying: !!flight,
      flight: flight?.id ?? null,
      status,
    })
  }
  const list = [...players.values()].sort(
    (a, b) => b.best - a.best || a.name.localeCompare(b.name),
  )
  for (const ws of sockets) {
    ws.send(
      JSON.stringify({
        t: 'players',
        list: list.map(({ pid, ...p }) => ({ ...p, you: pid === ws.data.pid })),
      }),
    )
  }
}
const flights = new Map<number, LiveFlight>()
let nextId = stored.reduce((m, p) => Math.max(m, p.id), 0) + 1

const clamp = (v: unknown, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number(v) || 0))
const pub = (f: LiveFlight) => ({
  id: f.id,
  name: f.name,
  design: f.design,
  paint: f.paint,
  hat: f.hat,
})
const send = (msg: object) => server.publish('all', JSON.stringify(msg))

function throwPlane(ws: Socket, msg: ClientMessage) {
  const now = performance.now()
  if (ws.data.flight || now - ws.data.lastThrow < THROW_GAP_MS) return
  ws.data.lastThrow = now
  const id = nextId++
  const design = sanitizeDesign(msg.design)
  let paint = false
  if (
    typeof msg.paint === 'string' &&
    msg.paint.startsWith('data:image/png;base64,') &&
    msg.paint.length < 6_000_000
  ) {
    const buf = Buffer.from(msg.paint.slice(22), 'base64')
    if (buf.subarray(0, 8).equals(PNG_SIG)) {
      writeFileSync(join(PAINT, `${id}.png`), buf)
      paint = true
    }
  }
  const yaw = clamp(msg.yaw, -100, 100)
  const jitter = () => Math.random() - 0.5 // nobody throws perfectly
  const s = launchState(
    spawnPoint(yaw),
    yaw + jitter() * 0.05,
    clamp(msg.pitch, -30, 45) * D2R + jitter() * 0.06,
    3 + clamp(msg.power, 0, 1) * 11,
    [jitter() * 2, jitter() * 2, jitter() * 2],
  )
  const t0 = worldTime() // the wind this flight meets depends on when it started
  const f: LiveFlight = {
    id,
    name: ws.data.name,
    design,
    paint,
    hat: collectionFor(ws.data.pid).equipped,
    sim: new Flight(design, s, 0, t0),
    start: performance.now(),
    clientStep: 0,
    inputs: [],
    ws,
  }
  flights.set(id, f)
  ws.data.flight = f
  ws.send(JSON.stringify({ t: 'mine', id, design, state: s, t0 }))
  send({ t: 'launched', ...pub(f) })
  sendPlayers()
}

function land(f: LiveFlight, surfaceY: number, where: string) {
  const roll = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.4)
  const { p, q } = restPose(f.sim.model, f.sim.s.q, f.sim.s.p, surfaceY, roll)
  const rec: Landed = {
    ...pub(f),
    pid: f.ws.data.pid,
    p: p.map((v) => Math.round(v * 1000) / 1000) as Vec3,
    q,
    dist: Math.round(Math.hypot(p[0], p[2])),
    where,
    time: Math.round(f.sim.n * DT),
    at: Date.now(),
  }
  const ignored = rec.dist < MIN_DIST
  // Short throws don't stay in the city, so neither does their paint.
  if (ignored && f.paint) rmSync(join(PAINT, `${f.id}.png`), { force: true })
  if (!ignored) {
    landed.push(rec)
    recordBest(rec)
    db.addPlane(rec).catch((e) =>
      console.error(`could not save plane ${rec.id}:`, e),
    )
  }
  flights.delete(f.id)
  if (f.ws.data.flight === f) f.ws.data.flight = null
  send({
    t: 'landed',
    plane: publicRec(rec),
    ...(ignored && { ignored: true }),
  })
  sendPlayers()
}

const realStep = (f: LiveFlight) =>
  Math.floor((performance.now() - f.start) / 1000 / DT)

function tick() {
  if (!flights.size) return
  const out: object[] = []
  for (const f of flights.values()) {
    const sim = f.sim,
      now = realStep(f)
    const target = Math.min(
      now + LEAD_STEPS,
      Math.max(f.clientStep, now - STALL_STEPS),
    )
    while (sim.n < target && !sim.landing) {
      for (let i = f.inputs[0]; i && i.at <= sim.n; i = f.inputs[0]) {
        f.inputs.shift()
        sim.setSteer(i.p, i.r)
      }
      const before: Vec3 = [...sim.s.p]
      sim.advance()
      const collection = collectionFor(f.ws.data.pid)
      const collected = collectItems(before, sim.s.p, collection.owned)
      if (collected.length)
        saveCollection(
          f.ws.data.pid,
          { ...collection, owned: [...collection.owned, ...collected] },
          collected,
        )
    }
    const s = sim.s
    if (sim.landing) {
      land(f, sim.landing.y, sim.landing.where)
      continue
    }
    if (
      sim.n * DT > MAX_FLIGHT_S ||
      !s.p.every(Number.isFinite) ||
      s.p[1] > 500
    ) {
      if (!s.p.every(Number.isFinite)) s.p = spawnPoint(0)
      land(f, surfaceAt(s.p[0], s.p[2]), 'timeout')
      continue
    }
    out.push({
      id: f.id,
      n: sim.n,
      p: s.p,
      q: s.q,
      v: s.v,
      w: s.w,
      s: sim.steer,
    })
  }
  if (out.length) send({ t: 'flights', f: out })
}
setInterval(tick, TICK_MS)

const DIST = join(ROOT, 'dist') // the client, built by `bun run build`

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req, srv) {
    const path = new URL(req.url).pathname
    if (path === '/healthz')
      return Response.json({
        ok: true,
        players: sockets.size,
        flights: flights.size,
      })
    if (path === '/ws') {
      const data: SocketData = {
        name: 'Anonymous',
        pid: crypto.randomUUID().replace(/-/g, ''),
        flight: null,
        status: 'arriving',
        lastThrow: 0,
      }
      return srv.upgrade(req, { data })
        ? undefined
        : new Response('Upgrade failed', { status: 400 })
    }
    const paint = path.match(/^\/paint\/(\d+)\.png$/)
    if (paint) {
      const file = Bun.file(join(PAINT, `${paint[1]}.png`))
      // Paint is loaded cross-origin when the client is hosted elsewhere, e.g. on GitHub Pages.
      return (await file.exists())
        ? new Response(file, {
            headers: { 'access-control-allow-origin': '*' },
          })
        : new Response('Not found', { status: 404 })
    }
    // Only plain file names inside dist/, so a request can never reach outside it.
    if (path !== '/' && !/^\/(assets\/)?[\w.-]+$/.test(path))
      return new Response('Not found', { status: 404 })
    const file = Bun.file(join(DIST, path === '/' ? 'index.html' : path))
    if (!(await file.exists()))
      return new Response('Not found', { status: 404 })
    // Built assets have content hashes in their names; the page itself revalidates every load.
    return new Response(file, {
      headers: {
        'cache-control': path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    })
  },
  websocket: {
    data: {} as SocketData,
    maxPayloadLength: 6_200_000,
    open(ws) {
      ws.subscribe('all')
      sockets.add(ws)
      ws.send(
        JSON.stringify({
          t: 'init',
          landed: landed.map(publicRec),
          flights: [...flights.values()].map(pub),
          time: worldTime(),
        }),
      )
    },
    close(ws) {
      sockets.delete(ws)
      sendPlayers()
    },
    message(ws, raw) {
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.t === 'hello') {
        if (ws.data.flight) return
        ws.data.name =
          String(msg.name ?? '')
            .replace(/[^\p{L}\p{N} _.-]/gu, '')
            .trim()
            .slice(0, 20) || 'Anonymous'
        if (typeof msg.pid === 'string' && /^[a-z0-9]{12,32}$/.test(msg.pid))
          ws.data.pid = msg.pid
        sendCollection(ws.data.pid)
        sendPlayers()
      } else if (msg.t === 'equip') {
        const collection = collectionFor(ws.data.pid)
        if (
          msg.hat === null ||
          (isHat(msg.hat) && collection.owned.includes(msg.hat))
        )
          saveCollection(ws.data.pid, { ...collection, equipped: msg.hat })
      } else if (msg.t === 'status') {
        const status = STATUSES.find((s) => s === msg.status)
        if (status && status !== ws.data.status) {
          ws.data.status = status
          sendPlayers()
        }
      } else if (msg.t === 'throw') throwPlane(ws, msg)
      else if ((msg.t === 'steer' || msg.t === 'progress') && ws.data.flight) {
        const f = ws.data.flight,
          at = Math.min(
            Math.floor(Number(msg.at)) || 0,
            realStep(f) + LEAD_STEPS,
          )
        f.clientStep = Math.max(f.clientStep, at)
        // Inputs for steps already simulated apply now; the browser corrects itself from our state.
        if (msg.t === 'steer' && f.inputs.length < MAX_QUEUED_INPUTS) {
          f.inputs.push({
            at: Math.max(at, f.sim.n),
            p: clamp(msg.pitch, -1, 1),
            r: clamp(msg.roll, -1, 1),
          })
        }
      }
    },
  },
})
if (!existsSync(join(DIST, 'index.html')))
  console.warn('paperfold: no client in dist/, run `bun run build` first')
console.log(`paperfold on :${server.port}`)

// Containers stop with SIGTERM: finish the database writes before going.
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.stop()
    db.close()
    process.exit(0)
  })
