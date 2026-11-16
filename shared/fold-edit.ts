import {
  angleOn,
  buildPlane,
  type Design,
  type Flap,
  type Fold,
  lineX,
  onSide,
  RULES,
} from './plane'
import { selfIntersects } from './selfhit'

export function splitFold<T extends Fold | Flap>(fold: T) {
  if (fold.side) return [fold]
  const { angleL: _, ...rest } = fold
  return ([1, -1] as const).map((side) => ({
    ...rest,
    side,
    angle: angleOn(fold, side),
  }))
}

export function limitAngle(
  design: Design,
  kind: 'fold' | 'flap',
  index: number,
  field: 'angle' | 'angleL',
  requested: number,
) {
  const items = kind === 'fold' ? design.folds : design.flaps
  const item = items[index]
  const start = field === 'angleL' ? (item.angleL ?? item.angle) : item.angle
  let max = kind === 'flap' ? RULES.maxFlapAngle : 180
  if (kind === 'fold') {
    const fold = design.folds[index]
    const affected =
      field === 'angleL'
        ? ([-1] as const)
        : item.side
          ? [item.side]
          : item.angleL === undefined
            ? ([1, -1] as const)
            : ([1] as const)
    if (
      affected.some((side) =>
        design.folds
          .filter((other) => onSide(other, side))
          .every((other) => lineX(other, 0) >= lineX(fold, 0)),
      )
    )
      max = 0
  }
  const target = Math.max(
    kind === 'flap' ? -RULES.maxFlapAngle : -180,
    Math.min(max, requested),
  )
  const blocked = (angle: number) => {
    const next = {
      ...design,
      [kind === 'fold' ? 'folds' : 'flaps']: items.map((fold, j) =>
        j === index ? { ...fold, [field]: angle } : fold,
      ),
    }
    return selfIntersects(buildPlane(next).pos)
  }
  if (target === start || !blocked(target)) return target
  let safe = start
  let stop = target
  while (Math.abs(stop - safe) > 0.25) {
    const middle = (safe + stop) / 2
    if (blocked(middle)) stop = middle
    else safe = middle
  }
  return safe
}
