import type { DatabaseSync } from 'node:sqlite'
import type {
  Contribution,
  GameCard,
  GamesResponse,
  Highlights,
  KeyMoment,
  League,
  ModelInfo,
  NightsResponse,
  RevealResponse,
  TeamRef,
  WeekSummary,
  WeeksResponse,
} from './api-types.ts'
import { activeWeightSet, getRevealRow, ratingCount, upsertRating, type WeightSet } from './db.ts'
import { HIGHLIGHT_LOOKBACK_MS, HIGHLIGHT_OVERDUE_MS } from './highlights.ts'
import { NBA_MODEL, OT_PERIOD, REGULATION_PERIOD, type NbaSignal } from './nba/model.ts'
import { NBA_TEAMS } from './nba/teams.ts'
import { BIG_MOMENT_BONUS, RATINGS_TO_PERSONALIZE, type SignalName, type Tier } from './scoring/model.ts'
import { DEFAULT_MODEL } from './scoring/score.ts'
import { NFL_TEAMS } from './teams.ts'

const PLAYOFF_LABELS: Record<string, string> = {
  WC: 'Wild Card',
  DIV: 'Divisional',
  CON: 'Conference Championships',
  SB: 'Super Bowl',
}

const TAG_LABELS: Record<string, string> = {
  playoff: 'Playoffs',
  race: 'Playoff race',
  division: 'Division rivalry',
  primetime: 'Primetime',
}

const NBA_PHASES: Record<string, string> = { REG: 'Regular season', PLAYIN: 'Play-In', POST: 'Playoffs' }

const team = (league: string, abbr: string): TeamRef => {
  const t = (league === 'NBA' ? NBA_TEAMS : NFL_TEAMS)[abbr]
  return { abbr, name: t ? `${t.city} ${t.nickname}` : abbr }
}

const activeModel = (db: DatabaseSync) => activeWeightSet(db, DEFAULT_MODEL)

// NBA weights aren't tuned from ratings yet; ratings are stored for when they are.
const nbaModel = () => ({ version: NBA_MODEL.version, weights: NBA_MODEL.weights as Record<string, number>, ratingsUsed: 0 })

function modelInfo(db: DatabaseSync, set: Pick<WeightSet, 'version' | 'ratingsUsed'>, league: League = 'NFL'): ModelInfo {
  const base = league === 'NBA' ? NBA_MODEL.version : DEFAULT_MODEL.version
  return {
    version: set.version,
    personalized: set.version !== base,
    ratings: ratingCount(db, league),
    ratingsNeeded: RATINGS_TO_PERSONALIZE,
    ratingsUsed: set.ratingsUsed,
  }
}

function weekLabel(gameType: string, week: number): string {
  return PLAYOFF_LABELS[gameType] ?? `Week ${week}`
}

function easternParts(at: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  return { weekday: parts.find((p) => p.type === 'weekday')!.value, hour: Number(parts.find((p) => p.type === 'hour')!.value) }
}

/** "Sunday early", "Thursday night", ... from the kickoff in Eastern time. */
export function slotLabel(kickoffAt: string): string {
  const { weekday, hour } = easternParts(kickoffAt)
  if (hour >= 19) return `${weekday} night`
  if (weekday !== 'Sunday') return weekday
  if (hour < 12) return 'Sunday morning'
  return hour < 16 ? 'Sunday early' : 'Sunday late'
}

/** "Afternoon game", "Early game", "Late game" from the tipoff in Eastern time. */
export function nbaSlotLabel(tipoffAt: string): string {
  const { hour } = easternParts(tipoffAt)
  if (hour < 17) return 'Afternoon game'
  return hour < 21 ? 'Early game' : 'Late game'
}

const nightLabel = (night: string) =>
  new Date(`${night}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

export function listWeeks(db: DatabaseSync, season: number): WeeksResponse {
  const model = activeModel(db)
  const rows = db
    .prepare(
      `select g.week, max(g.game_type) as game_type, count(*) as games,
              count(w.game_id) as ranked, min(g.kickoff_at) as first, max(g.kickoff_at) as last
       from games g
       left join watch_scores w on w.game_id = g.id and w.model_version = ?
       where g.league = 'NFL' and g.season = ?
       group by g.week order by g.week`,
    )
    .all(model.version, season) as { week: number; game_type: string; games: number; ranked: number; first: string; last: string }[]
  const weeks: WeekSummary[] = rows.map((r) => ({
    season,
    week: r.week,
    label: weekLabel(r.game_type, r.week),
    firstKickoff: r.first,
    lastKickoff: r.last,
    games: r.games,
    ranked: r.ranked,
  }))
  // The latest week with a couple of ranked games, so a lone Thursday game
  // doesn't hide the weekend before it.
  const withRanked = weeks.filter((w) => w.ranked > 0)
  const preferred = withRanked.filter((w) => w.ranked >= 2).at(-1) ?? withRanked.at(-1)
  return { season, defaultWeek: preferred?.week ?? weeks[0]?.week ?? null, weeks, model: modelInfo(db, model) }
}

/** NBA nights of a season. Defaults to the latest night with a ranked game, else the next night with games. */
export function listNights(db: DatabaseSync, season: number, now: Date): NightsResponse {
  const rows = db
    .prepare(
      `select g.night, max(g.game_type) as game_type, count(*) as games, count(w.game_id) as ranked
       from games g
       left join watch_scores w on w.game_id = g.id and w.model_version = ?
       where g.league = 'NBA' and g.season = ? and g.night is not null
       group by g.night order by g.night`,
    )
    .all(NBA_MODEL.version, season) as { night: string; game_type: string; games: number; ranked: number }[]
  const nights = rows.map((r) => ({ night: r.night, games: r.games, ranked: r.ranked, phase: NBA_PHASES[r.game_type] ?? r.game_type }))
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const lastRanked = nights.filter((n) => n.ranked > 0).at(-1)
  const next = nights.find((n) => n.night >= today)
  return {
    season,
    seasonLabel: `${season}-${String((season + 1) % 100).padStart(2, '0')}`,
    defaultNight: lastRanked?.night ?? next?.night ?? nights.at(-1)?.night ?? null,
    nights,
    model: modelInfo(db, nbaModel(), 'NBA'),
  }
}

const SIGNAL_LABELS: Record<SignalName | NbaSignal | 'big_moment', string> = {
  excitement: 'Win-probability swings',
  late_closeness: 'Close late',
  comeback: 'Comeback or upset',
  explosive: 'Explosive plays',
  touchdowns: 'Touchdowns',
  turnovers: 'Turnovers',
  highlight_plays: 'Highlight plays',
  scoring: 'Scoring',
  star: 'Star performance',
  stakes: 'Stakes',
  big_moment: 'Big-moment bonus',
}

/** Score, recap and score breakdown for one final game. The only spoiler response. */
export function revealGame(db: DatabaseSync, gameId: string): RevealResponse | null {
  const league = (db.prepare('select league from games where id = ?').get(gameId) as { league: League } | undefined)?.league
  if (!league) return null
  const model: { version: string; weights: Record<string, number>; ratingsUsed: number } = league === 'NBA' ? nbaModel() : activeModel(db)
  const r = getRevealRow(db, gameId, model.version)
  if (!r) return null
  let why: RevealResponse['why'] = null
  if (r.signals && r.total !== null && r.tier) {
    const { raw, pct } = JSON.parse(r.signals) as { raw: { big_moment: boolean }; pct: Record<string, number> }
    const { weights } = model
    const contributions: Contribution[] = Object.keys(weights).map((s) => ({
      key: s,
      label: SIGNAL_LABELS[s as SignalName] ?? s,
      points: Math.round(100 * weights[s] * pct[s] * 10) / 10,
      maxPoints: Math.round(100 * weights[s] * 10) / 10,
    }))
    contributions.push({ key: 'big_moment', label: SIGNAL_LABELS.big_moment, points: raw.big_moment ? BIG_MOMENT_BONUS : 0, maxPoints: BIG_MOMENT_BONUS })
    why = {
      total: r.total,
      tier: r.tier as Tier,
      contributions: contributions.sort((a, b) => b.points - a.points),
      model: modelInfo(db, model, league),
    }
  }
  const nba = league === 'NBA'
  return {
    id: r.id,
    away: { ...team(league, r.away_team), score: r.away_score },
    home: { ...team(league, r.home_team), score: r.home_score },
    overtime: r.overtime === 1,
    talkingPoints: JSON.parse(r.talking_points) as string[],
    keyMoments: JSON.parse(r.key_moments) as KeyMoment[],
    winProbability: {
      points: JSON.parse(r.wp_series) as [number, number][],
      periodSeconds: nba ? REGULATION_PERIOD : 900,
      overtimePeriodSeconds: nba ? OT_PERIOD : r.game_type === 'REG' ? 600 : 900,
    },
    why,
  }
}

interface GameRow {
  id: string
  game_type: string
  kickoff_at: string
  home_team: string
  away_team: string
  status: string
  stakes_tags: string
  tier: Tier | null
  stars: number | null
  video_id: string | null
  rating: number | null
}

function toCards(rows: GameRow[], league: League, now: Date): GameCard[] {
  return rows.map((r) => {
    const state = r.tier !== null ? 'ranked' : r.status === 'final' ? 'awaiting_data' : 'upcoming'
    let highlights: Highlights | null = null
    if (state !== 'upcoming') {
      const age = now.getTime() - Date.parse(r.kickoff_at)
      if (r.video_id) highlights = { status: 'available', videoId: r.video_id }
      else if (age > HIGHLIGHT_LOOKBACK_MS) highlights = { status: 'unavailable' }
      else if (age > HIGHLIGHT_OVERDUE_MS) highlights = { status: 'not_yet_available' }
      else highlights = { status: 'pending' }
    }
    // NFL rows store tag keys; NBA rows store the labels themselves.
    const stored = JSON.parse(r.stakes_tags) as string[]
    const tags = league === 'NBA' ? stored : stored.map((t) => TAG_LABELS[t]).filter(Boolean)
    return {
      id: r.id,
      kickoffAt: r.kickoff_at,
      slot: league === 'NBA' ? nbaSlotLabel(r.kickoff_at) : slotLabel(r.kickoff_at),
      away: team(league, r.away_team),
      home: team(league, r.home_team),
      tags,
      state,
      tier: r.tier,
      stars: r.stars,
      highlights,
      rating: r.rating,
    }
  })
}

// `total` orders the list but is never returned.
const GAME_ROWS = `
  select g.id, g.game_type, g.kickoff_at, g.home_team, g.away_team, g.status, g.stakes_tags,
         w.tier, w.stars, h.video_id, r.stars as rating
  from games g
  left join watch_scores w on w.game_id = g.id and w.model_version = ?
  left join highlight_videos h on h.game_id = g.id
  left join ratings r on r.game_id = g.id and r.user_id = 'local'`
const GAME_ORDER = `order by (w.total is null), w.total desc, (g.status != 'final'), g.kickoff_at, g.id`

export function listGames(db: DatabaseSync, season: number, week: number, now: Date): GamesResponse | null {
  const rows = db
    .prepare(`${GAME_ROWS} where g.league = 'NFL' and g.season = ? and g.week = ? ${GAME_ORDER}`)
    .all(activeModel(db).version, season, week) as unknown as GameRow[]
  if (rows.length === 0) return null
  return { league: 'NFL', season, week, night: null, label: weekLabel(rows[0].game_type, week), games: toCards(rows, 'NFL', now) }
}

export function listNbaGames(db: DatabaseSync, night: string, now: Date): GamesResponse | null {
  const rows = db
    .prepare(`${GAME_ROWS} where g.league = 'NBA' and g.night = ? ${GAME_ORDER}`)
    .all(NBA_MODEL.version, night) as unknown as GameRow[]
  if (rows.length === 0) return null
  const season = (db.prepare("select season from games where league = 'NBA' and night = ? limit 1").get(night) as { season: number }).season
  return { league: 'NBA', season, week: null, night, label: nightLabel(night), games: toCards(rows, 'NBA', now) }
}

/** Save the user's rating. Only finished games can be rated. */
export function rateGame(db: DatabaseSync, gameId: string, stars: number, now: Date): boolean {
  const game = db.prepare("select league from games where id = ? and status = 'final'").get(gameId) as { league: League } | undefined
  if (!game) return false
  upsertRating(db, gameId, stars, now.toISOString(), game.league === 'NBA' ? NBA_MODEL.version : activeModel(db).version)
  return true
}
