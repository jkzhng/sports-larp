// NFL watchability model. Ported from notebooks/watchability.py; keep the two in sync
// and bump MODEL_VERSION whenever weights, constants or signal definitions change.

export const MODEL_VERSION = 'nfl-v0.3'

// Drama (first three) 0.42, action (last four) 0.58. Late closeness is kept low
// because it moves almost in lockstep with excitement (Spearman 0.88).
export const WEIGHTS = {
  excitement: 0.2,
  late_closeness: 0.07,
  comeback: 0.15,
  explosive: 0.22,
  touchdowns: 0.18,
  turnovers: 0.1,
  stakes: 0.08,
} as const

export type SignalName = keyof typeof WEIGHTS
export const SIGNALS = Object.keys(WEIGHTS) as SignalName[]
export type Weights = Record<SignalName, number>

export type Tier = 'Must watch' | 'Worth it' | 'Skippable'
export type TierCutoffs = [number, Tier][]
// 67 gives about 3 Must watch games per regular-season week over 2023-2025.
// Fitted weight sets recalibrate these (server/tuning.ts).
export const TIERS: TierCutoffs = [
  [67, 'Must watch'],
  [45, 'Worth it'],
  [0, 'Skippable'],
]

export const CLOSE_MARGIN = 8 // points
export const LEAD_CHANGE_BONUS_MIN = 5 // each Q4/OT lead change counts as this many close minutes
export const EXPLOSIVE_PASS_YDS = 20
export const EXPLOSIVE_RUN_YDS = 15
export const LONG_TD_YDS = 40
export const GARBAGE_SECONDS = 300 // final 5 minutes of Q4
export const GARBAGE_WP = 0.99
export const GARBAGE_FACTOR = 0.5
export const BIG_MOMENT_BONUS = 5
export const BIG_MOMENT_SECONDS = 120 // game-winning score in the final 2:00
export const STAKES_POINTS = { division: 0.35, primetime: 0.25, race: 0.4 }
export const RACE_FROM_WEEK = 13
export const RACE_MIN_WIN_PCT = 0.5
export const REFERENCE_SEASON_COUNT = 3

// Learning from ratings (spec: "Learning from your ratings").
export const MUST_WATCH_PER_WEEK = 3
export const RATINGS_TO_PERSONALIZE = 20
export const HOLDOUT_RATINGS = 10
export const REFIT_INTERVAL_DAYS = 7
