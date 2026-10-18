// ESPN's unofficial NBA site API: the scoreboard for the schedule, and the game
// summary for plays, per-play win probability and the box score.
//
// Responses are cached on disk in data/raw/espn_nba/, the same layout the
// notebook (notebooks/nba_watchability.py) writes, so a backfill done by either
// serves both: scoreboard/YYYYMMDD.json once every game that day is final, and
// summary/<id>.json.gz trimmed to the keys below.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { RAW_DIR } from '../config.ts'

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const CACHE = `${RAW_DIR}/espn_nba`

const SEASON_TYPES: Record<number, string> = { 1: 'PRE', 2: 'REG', 3: 'POST', 5: 'PLAYIN' }

export interface NbaGame {
  game_id: string
  season: number // start year: 2025 = 2025-26
  season_type: string // REG | POST | PLAYIN
  night: string // US date of the scoreboard, YYYY-MM-DD
  tipoff: string // ISO UTC as ESPN writes it, e.g. 2025-10-22T23:30Z
  home_team: string
  away_team: string
  home_score: number | null
  away_score: number | null
  completed: boolean
  notes: string // "West Semifinals - Game 6", "NBA Cup - Quarterfinals", ""
  comp_type: string // STD, RD16, QTR, SEMI, FINAL, CC (Cup championship)
  national_tv: string[]
}

interface Competitor {
  homeAway: 'home' | 'away'
  score?: string
  team: { id?: string; abbreviation?: string }
}

interface ScoreboardEvent {
  id: string
  date: string
  season: { type: number }
  status: { type: { completed: boolean; state: string } } // state: pre | in | post
  competitions: {
    competitors: Competitor[]
    notes?: { headline?: string }[]
    type?: { abbreviation?: string }
    geoBroadcasts?: { market: { type: string }; media: { shortName: string } }[]
  }[]
}

interface Scoreboard {
  events?: ScoreboardEvent[]
  leagues?: { calendar: string[] }[]
}

export interface Summary {
  header: { competitions: { competitors: { homeAway: string; team: { id: string; abbreviation: string } }[] }[] }
  plays: EspnPlay[] | null
  winprobability: { playId: string; homeWinPercentage: number }[] | null
  boxscore: {
    players?: {
      team: { abbreviation: string }
      statistics: { labels: string[]; athletes: { athlete?: { displayName?: string; shortName?: string }; stats: string[] }[] }[]
    }[]
  } | null
}

export interface EspnPlay {
  id: string
  type: { text: string }
  text?: string
  awayScore: number
  homeScore: number
  period: { number: number }
  clock: { displayValue: string }
  scoringPlay?: boolean
  scoreValue?: number
  shootingPlay?: boolean
  team?: { id: string }
}

const SUMMARY_KEYS = ['header', 'plays', 'winprobability', 'boxscore'] as const

class HttpError extends Error {
  status: number
  constructor(status: number, url: string) {
    super(`ESPN ${status} for ${url}`)
    this.status = status
  }
}

async function getJson<T>(url: string, tries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sports-larp/0.1' }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new HttpError(res.status, url)
      return (await res.json()) as T
    } catch (err) {
      const retryable = !(err instanceof HttpError) || err.status >= 500
      if (!retryable || attempt === tries - 1) throw err
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
}

function writeCache(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

const ymd = (d: string) => d.replaceAll('-', '')

/** US date (YYYY-MM-DD) in Eastern time, which is how ESPN's scoreboard groups games. */
export function easternDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/** Every date ESPN lists for a season, preseason through the Finals. Cached once the season is over. */
export async function fetchSeasonDates(season: number, now: Date): Promise<string[]> {
  const path = `${CACHE}/calendar/${season}.json`
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as string[]
  const sb = await getJson<Scoreboard>(`${ESPN}/scoreboard?dates=${season}1201`)
  const dates = (sb.leagues?.[0]?.calendar ?? []).map((d) => d.slice(0, 10))
  if (dates.length > 0 && dates.at(-1)! < easternDate(now)) writeCache(path, JSON.stringify(dates))
  return dates
}

// Postponed and canceled games end in state "post" without completing. ESPN
// lists the rescheduled game as a new event, so these are dropped.
const isDead = (e: ScoreboardEvent) => e.status.type.state === 'post' && !e.status.type.completed

/** One day's scoreboard. Cached once every game on it is over (or called off). */
export async function fetchScoreboard(day: string, now: Date): Promise<Scoreboard> {
  const path = `${CACHE}/scoreboard/${ymd(day)}.json`
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Scoreboard
  const data = await getJson<Scoreboard>(`${ESPN}/scoreboard?dates=${ymd(day)}`)
  if ((data.events ?? []).every((e) => e.status.type.state === 'post') && day < easternDate(now)) writeCache(path, JSON.stringify(data))
  return data
}

// All-Star events and exhibitions against non-NBA teams.
const isLeagueGame = (e: ScoreboardEvent) =>
  e.competitions[0].competitors.every((c) => c.team.abbreviation !== undefined && Number(c.team.id ?? 0) <= 30)

export function parseScoreboard(sb: Scoreboard, night: string, season: number): NbaGame[] {
  const out: NbaGame[] = []
  for (const e of sb.events ?? []) {
    if (!isLeagueGame(e) || isDead(e)) continue
    const type = SEASON_TYPES[e.season.type] ?? String(e.season.type)
    if (type === 'PRE') continue
    const c = e.competitions[0]
    const home = c.competitors.find((t) => t.homeAway === 'home')!
    const away = c.competitors.find((t) => t.homeAway === 'away')!
    const completed = e.status.type.completed
    out.push({
      game_id: e.id,
      season,
      season_type: type,
      night,
      tipoff: e.date,
      home_team: home.team.abbreviation!,
      away_team: away.team.abbreviation!,
      home_score: completed ? Number(home.score) : null,
      away_score: completed ? Number(away.score) : null,
      completed,
      notes: (c.notes ?? []).map((n) => n.headline ?? '').join(' / '),
      comp_type: c.type?.abbreviation ?? '',
      national_tv: [...new Set((c.geoBroadcasts ?? []).filter((b) => b.market.type === 'National').map((b) => b.media.shortName))].sort(),
    })
  }
  return out
}

async function pool<T, R>(items: T[], workers: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

// How far ahead the schedule looks, so the UI can list the coming nights.
const SCHEDULE_AHEAD_DAYS = 7

/** Every game of the seasons up to a week ahead, sorted by tipoff. */
export async function fetchNbaSchedule(seasons: number[], now: Date): Promise<NbaGame[]> {
  const horizon = easternDate(new Date(now.getTime() + SCHEDULE_AHEAD_DAYS * 86_400_000))
  const games = new Map<string, NbaGame>()
  for (const season of seasons) {
    const days = (await fetchSeasonDates(season, now)).filter((d) => d <= horizon)
    const boards = await pool(days, 6, (d) => fetchScoreboard(d, now))
    days.forEach((day, i) => {
      for (const g of parseScoreboard(boards[i], day, season)) if (!games.has(g.game_id)) games.set(g.game_id, g)
    })
  }
  return [...games.values()].sort((a, b) => (a.tipoff < b.tipoff ? -1 : a.tipoff > b.tipoff ? 1 : 0))
}

const summaryPath = (gameId: string) => `${CACHE}/summary/${gameId}.json.gz`

export const hasSummary = (gameId: string) => existsSync(summaryPath(gameId))

/** Plays, win probability and box score for one finished game. Null when ESPN has none (404). */
export async function fetchSummary(gameId: string): Promise<Summary | null> {
  const path = summaryPath(gameId)
  if (existsSync(path)) return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Summary
  let data: Record<string, unknown>
  try {
    data = await getJson<Record<string, unknown>>(`${ESPN}/summary?event=${gameId}`)
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null
    throw err
  }
  const trimmed = Object.fromEntries(SUMMARY_KEYS.map((k) => [k, data[k] ?? null])) as unknown as Summary
  writeCache(path, gzipSync(JSON.stringify(trimmed)))
  return trimmed
}

export async function fetchSummaries(gameIds: string[], workers = 6): Promise<Map<string, Summary>> {
  const found = await pool(gameIds, workers, fetchSummary)
  const out = new Map<string, Summary>()
  gameIds.forEach((id, i) => found[i] && out.set(id, found[i]))
  return out
}
