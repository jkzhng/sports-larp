import type { DatabaseSync } from 'node:sqlite'
import {
  activateWeightSet,
  activeWeightSet,
  fittedWeightSets,
  getState,
  ratedGames,
  referenceGames,
  setState,
  type WeightSet,
} from './db.ts'
import { NBA_MODEL, MUST_WATCH_PER_WEEK as NBA_MUST_WATCH_PER_WEEK } from './nba/model.ts'
import { HOLDOUT_RATINGS, MUST_WATCH_PER_WEEK, RATINGS_TO_PERSONALIZE, REFIT_INTERVAL_DAYS } from './scoring/model.ts'
import { DEFAULT_MODEL, type ScoringModel } from './scoring/score.ts'
import { blend, calibrateCutoffs, concordance, fittedShare, fitWeights } from './tuning.ts'

export type RefitResult<S extends string = string> =
  | { status: 'skipped'; reason: string }
  | { status: 'kept'; reason: string }
  | { status: 'adopted'; set: WeightSet<S>; holdout: { candidate: number; previous: number } }

/** What a league's refit needs: its starting model, Must-watch target and where attempts are recorded. */
export interface RefitLeague<S extends string> {
  base: ScoringModel<S>
  mustWatchPerWeek: number
  stateKey: string // source_state prefix for the last attempt
}

// The NFL keys predate the NBA refit; keep them so its schedule carries on.
export const NFL_REFIT: RefitLeague<string> = { base: DEFAULT_MODEL, mustWatchPerWeek: MUST_WATCH_PER_WEEK, stateKey: 'refit' }
export const NBA_REFIT: RefitLeague<string> = { base: NBA_MODEL, mustWatchPerWeek: NBA_MUST_WATCH_PER_WEEK, stateKey: 'nba_refit' }

/**
 * Fit new weights from the user's ratings if enough are new: the first time 20
 * ratings exist, then at most weekly. New weights must order the 10 most recent
 * ratings (held out of the fit) at least as well as the current ones.
 */
export function refitWeights<S extends string>(
  db: DatabaseSync,
  now: Date,
  opts: { force?: boolean; referenceSeasons: number[]; league?: RefitLeague<S> },
): RefitResult<S> {
  const { base, mustWatchPerWeek, stateKey } = opts.league ?? (NFL_REFIT as unknown as RefitLeague<S>)
  const attemptAt = `${stateKey}_attempted_at`
  const attemptRatings = `${stateKey}_attempted_ratings`
  const signals = Object.keys(base.weights) as S[]
  const rated = ratedGames<S>(db, base.version)
  const n = rated.length
  if (n < RATINGS_TO_PERSONALIZE) return { status: 'skipped', reason: `${n} of ${RATINGS_TO_PERSONALIZE} ratings needed to personalize` }

  const fitted = fittedWeightSets<S>(db, base.version)
  if (!opts.force) {
    if (Number(getState(db, attemptRatings)) === n) return { status: 'skipped', reason: 'no new ratings since the last refit' }
    const lastAttempt = getState(db, attemptAt)
    const days = lastAttempt ? (now.getTime() - Date.parse(lastAttempt)) / 86_400_000 : Infinity
    if (fitted.length > 0 && days < REFIT_INTERVAL_DAYS) return { status: 'skipped', reason: `last refit ${days.toFixed(1)} days ago` }
  }
  setState(db, attemptAt, now.toISOString())
  setState(db, attemptRatings, String(n))

  const current = activeWeightSet(db, base)
  const share = fittedShare(n)
  const train = rated.slice(0, -HOLDOUT_RATINGS)
  const holdout = rated.slice(-HOLDOUT_RATINGS)
  const trainFit = fitWeights(train, signals)
  if (!trainFit) return { status: 'kept', reason: "your ratings don't line up with any signal yet" }

  const candidate = blend(trainFit, base.weights, share)
  const scores = { candidate: concordance(holdout, candidate), previous: concordance(holdout, current.weights) }
  if (scores.candidate < scores.previous) {
    return {
      status: 'kept',
      reason: `new weights ordered your ${HOLDOUT_RATINGS} latest ratings worse (${scores.candidate.toFixed(2)} vs ${scores.previous.toFixed(2)})`,
    }
  }

  // Passed the holdout: refit on every rating for the weights that go live.
  const weights = blend(fitWeights(rated, signals) ?? trainFit, base.weights, share)
  const set: WeightSet<S> = {
    version: `${base.version}+w${fitted.length + 1}`,
    weights,
    cutoffs: calibrateCutoffs(referenceGames<S>(db, base.version, opts.referenceSeasons), weights, base, mustWatchPerWeek),
    ratingsUsed: n,
    fittedShare: share,
    createdAt: now.toISOString(),
  }
  activateWeightSet(db, set, scores)
  return { status: 'adopted', set, holdout: scores }
}
