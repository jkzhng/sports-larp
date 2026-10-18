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
import { HOLDOUT_RATINGS, RATINGS_TO_PERSONALIZE, REFIT_INTERVAL_DAYS } from './scoring/model.ts'
import { DEFAULT_MODEL } from './scoring/score.ts'
import { blend, calibrateCutoffs, concordance, fittedShare, fitWeights } from './tuning.ts'

export type RefitResult =
  | { status: 'skipped'; reason: string }
  | { status: 'kept'; reason: string }
  | { status: 'adopted'; set: WeightSet; holdout: { candidate: number; previous: number } }

const ATTEMPT_AT = 'refit_attempted_at'
const ATTEMPT_RATINGS = 'refit_attempted_ratings'

/**
 * Fit new weights from the user's ratings if enough are new: the first time 20
 * ratings exist, then at most weekly. New weights must order the 10 most recent
 * ratings (held out of the fit) at least as well as the current ones.
 */
export function refitWeights(db: DatabaseSync, now: Date, opts: { force?: boolean; referenceSeasons: number[] }): RefitResult {
  const base = DEFAULT_MODEL
  const rated = ratedGames(db, base.version)
  const n = rated.length
  if (n < RATINGS_TO_PERSONALIZE) return { status: 'skipped', reason: `${n} of ${RATINGS_TO_PERSONALIZE} ratings needed to personalize` }

  const fitted = fittedWeightSets(db, base.version)
  if (!opts.force) {
    if (Number(getState(db, ATTEMPT_RATINGS)) === n) return { status: 'skipped', reason: 'no new ratings since the last refit' }
    const lastAttempt = getState(db, ATTEMPT_AT)
    const days = lastAttempt ? (now.getTime() - Date.parse(lastAttempt)) / 86_400_000 : Infinity
    if (fitted.length > 0 && days < REFIT_INTERVAL_DAYS) return { status: 'skipped', reason: `last refit ${days.toFixed(1)} days ago` }
  }
  setState(db, ATTEMPT_AT, now.toISOString())
  setState(db, ATTEMPT_RATINGS, String(n))

  const current = activeWeightSet(db, base)
  const share = fittedShare(n)
  const train = rated.slice(0, -HOLDOUT_RATINGS)
  const holdout = rated.slice(-HOLDOUT_RATINGS)
  const trainFit = fitWeights(train)
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
  const weights = blend(fitWeights(rated) ?? trainFit, base.weights, share)
  const set: WeightSet = {
    version: `${base.version}+w${fitted.length + 1}`,
    weights,
    cutoffs: calibrateCutoffs(referenceGames(db, base.version, opts.referenceSeasons), weights, base),
    ratingsUsed: n,
    fittedShare: share,
    createdAt: now.toISOString(),
  }
  activateWeightSet(db, set, scores)
  return { status: 'adopted', set, holdout: scores }
}
