import type { Vec3 } from './plane'

export const HATS = [
  {
    id: 'top-hat',
    name: 'Top hat',
    color: 0x343447,
    hint: 'Tucked behind the northern buildings',
  },
  {
    id: 'wizard-hat',
    name: 'Wizard hat',
    color: 0x8873c7,
    hint: 'Around the far side of the western block',
  },
  {
    id: 'crown',
    name: 'Crown',
    color: 0xffd166,
    hint: 'Hidden beyond the southeastern rooftops',
  },
] as const
export type HatId = (typeof HATS)[number]['id']
export interface Collection {
  owned: HatId[]
  equipped: HatId | null
}
export const PICKUPS: readonly { hat: HatId; p: Vec3; radius: number }[] = [
  { hat: 'top-hat', p: [-9, 28, -72], radius: 2.5 },
  { hat: 'wizard-hat', p: [-72, 18, -39], radius: 2.5 },
  { hat: 'crown', p: [43, 20, 72], radius: 2.5 },
]
export function isHat(value: unknown): value is HatId {
  return HATS.some((hat) => hat.id === value)
}
export function readCollection(value: unknown): Collection {
  if (!value || typeof value !== 'object' || !('owned' in value))
    return { owned: [], equipped: null }
  const owned = Array.isArray(value.owned)
    ? [...new Set(value.owned.filter(isHat))]
    : []
  const equipped =
    'equipped' in value &&
    isHat(value.equipped) &&
    owned.includes(value.equipped)
      ? value.equipped
      : null
  return { owned, equipped }
}
export function collectItems(
  from: Vec3,
  to: Vec3,
  owned: readonly HatId[],
): HatId[] {
  const delta = to.map((v, i) => v - from[i])
  const lengthSq = delta.reduce((sum, v) => sum + v * v, 0)
  return PICKUPS.filter(({ hat, p, radius }) => {
    if (owned.includes(hat)) return false
    const t = lengthSq
      ? Math.max(
          0,
          Math.min(
            1,
            p.reduce((sum, v, i) => sum + (v - from[i]) * delta[i], 0) /
              lengthSq,
          ),
        )
      : 0
    return (
      p.reduce((sum, v, i) => sum + (from[i] + delta[i] * t - v) ** 2, 0) <=
      radius ** 2
    )
  }).map((pickup) => pickup.hat)
}
