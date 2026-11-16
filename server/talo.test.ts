import { expect, test } from 'bun:test'
import { openTalo } from './talo'

test('identifies a player once and posts each landing to the leaderboard', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const talo = openTalo(
    { key: 'secret', leaderboard: 'distance', url: 'https://talo.test' },
    async (url, init) => {
      calls.push({ url, init })
      return Response.json(url.includes('identify') ? { alias: { id: 7 } } : {})
    },
  )
  await talo.submit('abc123', 42, { name: 'Moth' })
  await talo.submit('abc123', 50, { name: 'Moth' })
  expect(calls.map((c) => c.url)).toEqual([
    'https://talo.test/v1/players/identify?service=paperfold&identifier=abc123',
    'https://talo.test/v1/leaderboards/distance/entries',
    'https://talo.test/v1/leaderboards/distance/entries',
  ])
  const post = calls[1]?.init
  expect(post?.headers).toMatchObject({
    authorization: 'Bearer secret',
    'x-talo-alias': '7',
  })
  expect(JSON.parse(String(post?.body))).toEqual({
    score: 42,
    props: [{ key: 'name', value: 'Moth' }],
  })
})

test('a failed identify is retried on the next landing', async () => {
  let fail = true
  const talo = openTalo({ key: 'k', leaderboard: 'd' }, async (url) => {
    if (url.includes('identify') && fail)
      return new Response('', { status: 500 })
    return Response.json({ alias: { id: 1 } })
  })
  await expect(talo.submit('p', 1, {})).rejects.toThrow('500')
  fail = false
  await talo.submit('p', 1, {})
})
