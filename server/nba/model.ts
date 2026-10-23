// NBA watchability model. Ported from notebooks/nba_watchability.py; keep the two
// in sync and bump MODEL_VERSION whenever weights, constants or signal definitions change.
import type { TierCutoffs } from '../scoring/model.ts'
import type { ScoringModel } from '../scoring/score.ts'

export const MODEL_VERSION = 'nba-v0.1'

// Drama (first three) 0.42, action 0.46, stakes 0.12. As in the NFL model, late
// closeness is kept low: it moves almost in lockstep with excitement (Spearman
// 0.87 over 2023-24 to 2025-26).
export const WEIGHTS = {
  excitement: 0.2,
  late_closeness: 0.07,
  comeback: 0.15,
  highlight_plays: 0.2,
  scoring: 0.1,
  star: 0.16,
  stakes: 0.12,
} as const

export type NbaSignal = keyof typeof WEIGHTS
export const SIGNALS = Object.keys(WEIGHTS) as NbaSignal[]

// 78 gives about 2.4 Must watch games per regular-season week over 2023-24 to
// 2025-26 (about 5% of games). 60 makes about 1.8 games a night Worth it.
export const TIERS: TierCutoffs = [
  [78, 'Must watch'],
  [60, 'Worth it'],
  [0, 'Skippable'],
]

export const NBA_MODEL: ScoringModel<NbaSignal> = { version: MODEL_VERSION, weights: { ...WEIGHTS }, cutoffs: TIERS }

export const REGULATION_PERIOD = 720 // seconds
export const OT_PERIOD = 300
export const CLOSE_MARGIN = 5 // points
export const LEAD_CHANGE_BONUS_MIN = 1 // each Q4/OT lead change counts as this many close minutes
export const DEEP_THREE_FT = 30
export const GARBAGE_SECONDS = 300 // final 5 minutes of Q4
export const GARBAGE_WP = 0.99
export const GARBAGE_FACTOR = 0.5
export const BIG_MOMENT_SECONDS = 24 // winner goes ahead for good in the final 24 s
export const TYING_BUZZER_SECONDS = 3 // a shot this late that ties the game and forces OT
export const TRIPLE_DOUBLE_BONUS = 10 // star signal: points of the best player, plus this
export const SIGNAL_DECIMALS = 6 // raw float signals are rounded to this before ranking
export const NATIONAL_TV = new Set(['ABC', 'ESPN', 'TNT', 'NBC', 'Prime Video'])
export const STAKES_POINTS = { national_tv: 0.35, marquee: 0.25, race: 0.4 }
export const MARQUEE_MIN_WIN_PCT = 0.6 // both teams, after MIN_GAMES_FOR_PCT games
export const MIN_GAMES_FOR_PCT = 10
export const RACE_MIN_GAMES = 55 // last ~27 games of an 82-game season
export const RACE_MIN_WIN_PCT = 0.5
export const REFERENCE_SEASON_COUNT = 3
// Fitted weight sets recalibrate Must watch to this many regular-season games a week.
export const MUST_WATCH_PER_WEEK = 2.5

/** NBA season a date falls in, named by its start year: 2026-27 is 2026. */
export function currentNbaSeason(now: Date): number {
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1
}
