// Talo (https://trytalo.com) keeps Paperfold's players and distance leaderboard. The server talks to it
// with a secret access key, so the browser never sees it and only server-simulated distances get in.
type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface TaloConfig {
  key: string // access key with read:players, write:players and write:leaderboards
  leaderboard: string // the leaderboard's internal name
  url?: string // a self-hosted Talo; defaults to Talo's cloud
}

export function openTalo(
  { key, leaderboard, url = 'https://api.trytalo.com' }: TaloConfig,
  fetcher: Fetch = fetch,
) {
  const aliases = new Map<string, Promise<number>>() // player id -> Talo alias id
  async function call(path: string, init: RequestInit = {}) {
    const res = await fetcher(`${url}/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    })
    if (!res.ok) throw new Error(`talo ${path}: ${res.status}`)
    return res.json()
  }
  const alias = (pid: string) => {
    let a = aliases.get(pid)
    if (!a) {
      a = call(
        `/players/identify?service=paperfold&identifier=${encodeURIComponent(pid)}`,
      ).then((r) => r.alias.id as number)
      a.catch(() => aliases.delete(pid)) // try again next landing
      aliases.set(pid, a)
    }
    return a
  }
  return {
    // One entry per landed throw; the leaderboard's own mode decides whether only the best one counts.
    submit: async (
      pid: string,
      dist: number,
      props: Record<string, string>,
    ) => {
      await call(`/leaderboards/${encodeURIComponent(leaderboard)}/entries`, {
        method: 'POST',
        headers: { 'x-talo-alias': String(await alias(pid)) },
        body: JSON.stringify({
          score: dist,
          props: Object.entries(props).map(([key, value]) => ({ key, value })),
        }),
      })
    },
  }
}
