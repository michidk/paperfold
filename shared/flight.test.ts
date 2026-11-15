import { expect, test } from 'bun:test'
import {
  cloneState,
  Flight,
  type Input,
  PredictedFlight,
  type ServerState,
} from './flight'
import { DEFAULT_DESIGN, launchState } from './plane'

const start = () => launchState([3, 49.6, 1], 0.7, 0.1, 8, [0.3, -0.2, 0.5])
const snapshot = (f: Flight): ServerState => ({
  n: f.n,
  ...cloneState(f.s),
  s: [...f.steer],
})

test('a late input is corrected by rewinding to the server and replaying', () => {
  const server = new Flight(DEFAULT_DESIGN, start()),
    client = new PredictedFlight(DEFAULT_DESIGN, start())
  const sent: Input[] = []
  client.stepTo(1000, [0, 0])
  client.stepTo(3000, [1, 1], (i) => sent.push(i)) // pulls up and banks at step 1000

  // A 600 ms input delay produces enough divergence to exercise the 1 cm correction threshold.
  while (server.n < 1600) server.advance()
  expect(sent).toEqual([{ at: 1000, p: 1, r: 1 }])
  server.setSteer(1, 1)
  while (server.n < 2000) server.advance()

  const before = client.hist.get(2000)
  expect(
    Math.hypot(...(before?.p ?? []).map((v, i) => v - server.s.p[i])),
  ).toBeGreaterThan(0.01) // they disagree
  expect(client.reconcile(snapshot(server))).toBe('rewind')

  while (server.n < 3000) server.advance()
  expect(client.sim.n).toBe(3000)
  expect(client.sim.s.p).toEqual(server.s.p) // identical after the replay
})

test('agreeing states are left alone, and a stalled client jumps ahead', () => {
  const server = new Flight(DEFAULT_DESIGN, start()),
    client = new PredictedFlight(DEFAULT_DESIGN, start())
  client.stepTo(800, [0, 0])
  while (server.n < 500) server.advance()
  expect(client.reconcile(snapshot(server))).toBe(null)
  while (server.n < 1500) server.advance()
  expect(client.reconcile(snapshot(server))).toBe('jump')
  expect(client.sim.n).toBe(1500)
})
