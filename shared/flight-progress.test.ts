import { expect, test } from 'bun:test'
import { flightProgress } from './flight-progress'

test('scores are placed by distance with first place at the end', () => {
  const result = flightProgress(
    [
      { name: 'Ada', best: 200, you: false },
      { name: 'Ben', best: 50, you: false },
      { name: 'You', best: 100, you: true },
    ],
    75,
  )
  expect(result.fraction).toBe(0.375)
  expect(
    result.scores.map(({ name, fraction, rank, passed }) => ({
      name,
      fraction,
      rank,
      passed,
    })),
  ).toEqual([
    { name: 'Ben', fraction: 0.25, rank: 3, passed: true },
    { name: 'You', fraction: 0.5, rank: 2, passed: false },
    { name: 'Ada', fraction: 1, rank: 1, passed: false },
  ])
  expect(result.next?.name).toBe('You')
  expect(result.leader?.name).toBe('Ada')
})

test('passing first place keeps the bar full and reports the extra distance', () => {
  const result = flightProgress([{ name: 'Ada', best: 200, you: false }], 230)
  expect(result.fraction).toBe(1)
  expect(result.beyond).toBe(30)
  expect(result.next).toBeUndefined()
  expect(result.scores[0].passed).toBe(true)
})

test('ties share rank and players without a score are omitted', () => {
  const result = flightProgress(
    [
      { name: 'Ada', best: 100, you: false },
      { name: 'Ben', best: 100, you: false },
      { name: 'New', best: 0, you: false },
    ],
    0,
  )
  expect(result.scores.map((s) => s.rank)).toEqual([1, 1])
  expect(result.fraction).toBe(0)
  const empty = flightProgress([], 50)
  expect(empty.leader).toBeUndefined()
  expect(empty.fraction).toBe(0)
  expect(empty.beyond).toBe(0)
})
