interface Score {
  name: string
  best: number
  you: boolean
}

export function flightProgress(players: readonly Score[], distance: number) {
  const ranked = players
    .filter((p) => Number.isFinite(p.best) && p.best > 0)
    .toSorted((a, b) => b.best - a.best || a.name.localeCompare(b.name))
  const leader = ranked[0]
  const target = leader?.best ?? 1
  const scores = ranked
    .map((p) => ({
      ...p,
      rank: ranked.findIndex((other) => other.best === p.best) + 1,
      fraction: p.best / target,
      passed: distance > p.best,
    }))
    .reverse()
  return {
    scores,
    leader,
    next: scores.find((p) => p.best >= distance),
    fraction: leader ? Math.max(0, Math.min(1, distance / target)) : 0,
    beyond: leader ? Math.max(0, distance - target) : 0,
  }
}
