// Learning weights from the user's star ratings. Pure functions; the refit job
// that reads and writes the database lives in server/refit.ts.
// Every function works for any sport: a model's signals are the keys of its weights.
import { RATINGS_TO_PERSONALIZE, type SignalName, type TierCutoffs } from './scoring/model.ts'
import { weightedTotal } from './scoring/score.ts'

const signalsOf = <S extends string>(weights: Record<S, number>) => Object.keys(weights) as S[]

export interface RatedGame<S extends string = SignalName> {
  pct: Record<S, number>
  bigMoment: boolean
  stars: number // 1 to 5
}

// Ridge strength relative to the sample size; steadies the fit when signals
// overlap (excitement and late closeness move together).
const RIDGE = 0.05

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    if (Math.abs(m[pivot][c]) < 1e-12) return null
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  return m.map((row, i) => row[n] / row[i])
}

/**
 * Weights that best predict star ratings from signal percentiles:
 * stars ~ intercept + scale * sum(w_i * pct_i), with w_i >= 0 and sum(w) = 1.
 * Solved exactly as non-negative ridge least squares over every subset of the
 * signals (2^7 = 128 small systems for seven). Null when no signal predicts the
 * ratings at all.
 */
export function fitWeights<S extends string = SignalName>(samples: RatedGame<S>[], signals: readonly S[]): Record<S, number> | null {
  const n = samples.length
  if (n < 2) return null
  const k = signals.length
  const X = samples.map((s) => signals.map((sig) => s.pct[sig]))
  const y = samples.map((s) => (s.stars - 1) / 4)
  const xMean = signals.map((_, j) => X.reduce((sum, row) => sum + row[j], 0) / n)
  const yMean = y.reduce((a, b) => a + b, 0) / n
  const Xc = X.map((row) => row.map((v, j) => v - xMean[j]))
  const yc = y.map((v) => v - yMean)
  const lambda = (RIDGE * n) / 12 // 1/12 is the variance of a uniform percentile

  let best: { beta: number[]; loss: number } = { beta: new Array(k).fill(0), loss: yc.reduce((a, v) => a + v * v, 0) }
  for (let mask = 1; mask < 1 << k; mask++) {
    const cols = signals.map((_, j) => j).filter((j) => mask & (1 << j))
    const A = cols.map((a) => cols.map((b) => Xc.reduce((sum, row) => sum + row[a] * row[b], 0) + (a === b ? lambda : 0)))
    const rhs = cols.map((a) => Xc.reduce((sum, row, i) => sum + row[a] * yc[i], 0))
    const sol = solve(A, rhs)
    if (!sol || sol.some((v) => v <= 0)) continue
    const beta = new Array(k).fill(0)
    cols.forEach((c, i) => (beta[c] = sol[i]))
    const residual = Xc.reduce((sum, row, i) => {
      const e = yc[i] - row.reduce((acc, v, j) => acc + v * beta[j], 0)
      return sum + e * e
    }, 0)
    const loss = residual + lambda * beta.reduce((a, v) => a + v * v, 0)
    if (loss < best.loss) best = { beta, loss }
  }

  const total = best.beta.reduce((a, b) => a + b, 0)
  if (total <= 1e-9) return null
  return Object.fromEntries(signals.map((s, j) => [s, best.beta[j] / total])) as Record<S, number>
}

/** Share of the fitted weights in the blend: 0 below 20 ratings, 0.5 at 20, 0.8 from 60 on. */
export function fittedShare(ratings: number): number {
  if (ratings < RATINGS_TO_PERSONALIZE) return 0
  return Math.min(0.8, 0.5 + (0.3 * (ratings - RATINGS_TO_PERSONALIZE)) / 40)
}

export function blend<S extends string>(fitted: Record<S, number>, defaults: Record<S, number>, share: number): Record<S, number> {
  const signals = signalsOf(defaults)
  const w = Object.fromEntries(signals.map((s) => [s, share * fitted[s] + (1 - share) * defaults[s]])) as Record<S, number>
  const total = signals.reduce((sum, s) => sum + w[s], 0)
  return Object.fromEntries(signals.map((s) => [s, Math.round((w[s] / total) * 10_000) / 10_000])) as Record<S, number>
}

/**
 * How well a weight set orders rated games: the share of pairs with different
 * star ratings that it puts in the same order (ties in score count half).
 * 0.5 is a coin flip.
 */
export function concordance<S extends string>(samples: RatedGame<S>[], weights: Record<S, number>): number {
  const scores = samples.map((s) => weightedTotal(s.pct, s.bigMoment, weights))
  let agree = 0
  let pairs = 0
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const ds = samples[i].stars - samples[j].stars
      if (ds === 0) continue
      pairs++
      const dp = scores[i] - scores[j]
      if (dp === 0) agree += 0.5
      else if (Math.sign(dp) === Math.sign(ds)) agree++
    }
  }
  return pairs === 0 ? 0.5 : agree / pairs
}

export interface ReferenceGame<S extends string = SignalName> {
  week: string // NFL "2025-5"; NBA the Monday of the night's week
  regular: boolean
  pct: Record<S, number>
  bigMoment: boolean
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Tier cutoffs for a new weight set: Must watch keeps its target count per
 * regular-season week (NFL 3, NBA 2.5), and Skippable keeps the share it has
 * under the starting weights.
 */
export function calibrateCutoffs<S extends string>(
  reference: ReferenceGame<S>[],
  weights: Record<S, number>,
  defaults: { weights: Record<S, number>; cutoffs: TierCutoffs },
  mustWatchPerWeek: number,
): TierCutoffs {
  const regular = reference.filter((g) => g.regular)
  const scores = regular.map((g) => weightedTotal(g.pct, g.bigMoment, weights)).sort((a, b) => a - b)
  const weeks = new Set(regular.map((g) => g.week)).size
  const gamesPerWeek = regular.length / weeks
  const must = quantile(scores, 1 - mustWatchPerWeek / gamesPerWeek)

  const worthCutoff = defaults.cutoffs.find(([, t]) => t === 'Worth it')![0]
  const skipShare = regular.filter((g) => weightedTotal(g.pct, g.bigMoment, defaults.weights) < worthCutoff).length / regular.length
  const worth = quantile(scores, skipShare)

  const round = (x: number) => Math.round(x * 10) / 10
  return [
    [round(must), 'Must watch'],
    [round(Math.min(worth, must)), 'Worth it'],
    [0, 'Skippable'],
  ]
}
