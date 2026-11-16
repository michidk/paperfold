import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCollection } from '../shared/items'
import { DEFAULT_DESIGN } from '../shared/plane'
import { openDb } from './db'

test('the server restricts equipment to collected hats and shares the equipped visual', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paperfold-items-server-'))
  const db = openDb(dir)
  await db.saveCollection('testplayer0001', {
    owned: ['top-hat'],
    equipped: null,
  })
  db.close()
  const child = Bun.spawn(['timeout', '15', 'bun', 'server/index.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, DATA_DIR: dir, PORT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const sockets: WebSocket[] = []
  try {
    const reader = child.stdout.getReader()
    let output = ''
    while (!/paperfold on :(\d+)/.test(output)) {
      const chunk = await reader.read()
      if (chunk.done)
        throw new Error(
          `Server failed: ${await new Response(child.stderr).text()}`,
        )
      output += new TextDecoder().decode(chunk.value)
    }
    const port = output.match(/paperfold on :(\d+)/)?.[1]
    const connect = async () => {
      const socket = new WebSocket(`ws://localhost:${port}/ws`)
      sockets.push(socket)
      const messages: Record<string, unknown>[] = []
      socket.addEventListener('message', (event) => {
        const message: unknown = JSON.parse(String(event.data))
        if (message && typeof message === 'object')
          messages.push({ ...message })
      })
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error('WebSocket failed'))
      })
      const next = async (type: string) => {
        const deadline = performance.now() + 2500
        while (performance.now() < deadline) {
          const index = messages.findIndex((message) => message.t === type)
          if (index >= 0) return messages.splice(index, 1)[0]
          await Bun.sleep(10)
        }
        throw new Error(`Missing ${type} message`)
      }
      return { socket, next }
    }
    const owner = await connect()
    owner.socket.send(
      JSON.stringify({ t: 'hello', pid: 'testplayer0001', name: 'Pilot' }),
    )
    expect(readCollection(await owner.next('collection'))).toEqual({
      owned: ['top-hat'],
      equipped: null,
    })
    owner.socket.send(JSON.stringify({ t: 'equip', hat: 'wizard-hat' }))
    owner.socket.send(
      JSON.stringify({ t: 'hello', pid: 'testplayer0001', name: 'Pilot' }),
    )
    expect(readCollection(await owner.next('collection')).equipped).toBeNull()
    owner.socket.send(JSON.stringify({ t: 'equip', hat: 'top-hat' }))
    expect(readCollection(await owner.next('collection')).equipped).toBe(
      'top-hat',
    )
    const observer = await connect()
    observer.socket.send(
      JSON.stringify({ t: 'hello', pid: 'testplayer0002', name: 'Observer' }),
    )
    expect(readCollection(await observer.next('collection'))).toEqual({
      owned: [],
      equipped: null,
    })
    await Bun.sleep(1600)
    owner.socket.send(
      JSON.stringify({
        t: 'throw',
        design: DEFAULT_DESIGN,
        power: 1,
        pitch: 0,
        yaw: 0,
      }),
    )
    expect((await observer.next('launched')).hat).toBe('top-hat')
    owner.socket.send(JSON.stringify({ t: 'equip', hat: null }))
    expect(readCollection(await owner.next('collection')).equipped).toBeNull()
  } finally {
    for (const socket of sockets) socket.close()
    child.kill()
    await child.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 12000)
