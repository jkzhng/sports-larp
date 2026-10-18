import {
  BIG_MOMENT_BONUS,
  MODEL_VERSION,
  TIERS,
  WEIGHTS,
  type SignalName,
  type Tier,
  type TierCutoffs,
} from './model.ts'

// Shared by every sport. A model's signals are the keys of its weights, in
// order; the type parameter defaults to the NFL's signal names.

export type RawSignals<S extends string = SignalName> = Record<S, number> & { big_moment: boolean }

export interface WatchScore<S extends string = SignalName> {
  game_id: string
  model_version: string
  total: number // 0 to 100
  stars: number // 1 to 5
  tier: Tier
  raw: RawSignals<S>
  pct: Record<S, number>
}

export interface ScoringModel<S extends string = SignalName> {
  version: string
  weights: Record<S, number>
  cutoffs: TierCutoffs
}

export const DEFAULT_MODEL: ScoringModel = { version: MODEL_VERSION, weights: { ...WEIGHTS }, cutoffs: TIERS }

const sortedNumbers = (xs: number[]) => Float64Array.from(xs).sort()

const signalsOf = <S extends string>(weights: Record<S, number>) => Object.keys(weights) as S[]

// Index of the first element >= x (strict = false) or > x (strict = true).
function bisect(sorted: Float64Array, x: number, strict: boolean): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (strict ? sorted[mid] <= x : sorted[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Mid-rank percentile of x within a sorted reference distribution (0 to 1). */
export function percentile(sorted: Float64Array, x: number): number {
  return (bisect(sorted, x, false) + bisect(sorted, x, true)) / 2 / sorted.length
}

// numpy rounds halves to even; match it so scores agree with the notebook.
function roundHalfEven(x: number, digits = 0): number {
  const f = 10 ** digits
  const v = x * f
  const r = Math.round(v)
  return (Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) / f
}

export function tier(total: number, cutoffs: TierCutoffs = TIERS): Tier {
  return cutoffs.find(([cutoff]) => total >= cutoff)![1]
}

/** The 0-100 score from signal percentiles, before rounding. */
export function weightedTotal<S extends string>(pct: Record<S, number>, bigMoment: boolean, weights: Record<S, number>): number {
  const weighted = signalsOf(weights).reduce((sum, s) => sum + weights[s] * pct[s], 0)
  return Math.min(100, 100 * weighted + BIG_MOMENT_BONUS * +bigMoment)
}

/** Score games against the reference seasons' raw signals. */
export function scoreGames<S extends string = SignalName>(
  games: Map<string, RawSignals<S>>,
  reference: RawSignals<S>[],
  model: ScoringModel<S> = DEFAULT_MODEL as unknown as ScoringModel<S>,
): WatchScore<S>[] {
  const signals = signalsOf(model.weights)
  const ref = Object.fromEntries(signals.map((s) => [s, sortedNumbers(reference.map((r) => r[s]))])) as Record<S, Float64Array>
  const out: WatchScore<S>[] = []
  for (const [game_id, raw] of games) {
    const pct = Object.fromEntries(signals.map((s) => [s, percentile(ref[s], raw[s])])) as Record<S, number>
    const total = roundHalfEven(weightedTotal(pct, raw.big_moment, model.weights), 1)
    const stars = roundHalfEven(Math.min(5, 1 + total / 25))
    out.push({ game_id, model_version: model.version, total, stars, tier: tier(total, model.cutoffs), raw, pct })
  }
  return out
}
