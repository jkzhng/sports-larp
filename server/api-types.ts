// API response shapes, shared with the React app (type-only imports).
// Spoiler rule: only RevealResponse may carry a score, winner, numeric rating or
// signal breakdown. Every other shape is safe to show before the user reveals.
import type { KeyMoment } from './recap.ts'
import type { Tier } from './scoring/model.ts'

export type { KeyMoment, Tier }

export type League = 'NFL' | 'NBA'

export interface TeamRef {
  abbr: string
  name: string // "Buffalo Bills"
}

export type Highlights =
  | { status: 'available'; videoId: string }
  | { status: 'pending' } // game ended recently; video not posted yet
  | { status: 'not_yet_available' } // still missing 24h after kickoff
  | { status: 'unavailable' } // the matcher stopped looking (14 days); none was found

export interface GameCard {
  id: string
  kickoffAt: string // ISO UTC
  slot: string // "Sunday early", "Monday night" (NFL); "Late game" (NBA)
  away: TeamRef
  home: TeamRef
  tags: string[] // pre-game context only: "Division rivalry", "ESPN", "West Finals · Game 3", ...
  state: 'ranked' | 'awaiting_data' | 'upcoming'
  tier: Tier | null // the only hint of how good a game was; no stars or score within a tier
  highlights: Highlights | null // null until the game is final
  rating: number | null // the user's own 1-5 stars
}

export interface WeekSummary {
  season: number
  week: number
  label: string // "Week 5", "Wild Card"
  firstKickoff: string
  lastKickoff: string
  games: number
  ranked: number
}

export interface ModelInfo {
  version: string
  personalized: boolean // scores use weights fitted from ratings
  ratings: number // ratings given so far
  ratingsNeeded: number // ratings before the first refit
  ratingsUsed: number // ratings behind the active weights
}

// NBA games are grouped by night (the US date of the scoreboard), not by week.
export interface NightSummary {
  night: string // YYYY-MM-DD
  games: number
  ranked: number
  phase: string // Regular season, Play-In, Playoffs
}

export interface NightsResponse {
  season: number // start year: 2026 = 2026-27
  seasonLabel: string // 2026-27
  defaultNight: string | null
  nights: NightSummary[]
  model: ModelInfo
}

export interface WeeksResponse {
  season: number
  defaultWeek: number | null
  weeks: WeekSummary[]
  model: ModelInfo
}

// ---------------------------------------------------------------- reveal (spoilers)

export interface Contribution {
  key: string
  label: string
  points: number // points this signal added to the 0-100 score
  maxPoints: number // its weight x 100 (or the bonus size)
}

export interface RevealResponse {
  id: string
  away: TeamRef & { score: number }
  home: TeamRef & { score: number }
  overtimes: number // overtime periods played: 0, 1 (OT), 2 (2OT), ...
  talkingPoints: string[]
  keyMoments: KeyMoment[]
  winProbability: {
    points: [number, number][] // [elapsed game seconds, home WP]
    periodSeconds: number // 900 NFL quarters, 720 NBA quarters
    overtimePeriodSeconds: number // NFL 600 regular season, 900 playoffs; NBA 300
  }
  why: { total: number; tier: Tier; contributions: Contribution[]; model: ModelInfo } | null // null until ranked
}

export interface GamesResponse {
  league: League
  season: number
  week: number | null // NFL
  night: string | null // NBA, YYYY-MM-DD
  label: string // Week 5, Wild Card, Tuesday, October 20
  games: GameCard[] // ranked games best first, then awaiting data, then upcoming by kickoff
}

// Data refresh from the UI's Update button. No log lines: they're not part of the spoiler-safe surface.
export interface IngestStatus {
  running: boolean
  startedAt: string | null // the running pass, ISO UTC
  lastFinishedAt: string | null // the last pass to finish, from any process
  lastOk: boolean | null // false when a league failed; details are in the server log
}
