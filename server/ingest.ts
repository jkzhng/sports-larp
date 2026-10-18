import type { DatabaseSync } from 'node:sqlite'
import { currentSeason } from './config.ts'
import {
  activeWeightSet,
  gamesNeedingHighlights,
  gamesWithPlays,
  getState,
  hasScores,
  insertHighlights,
  loadPlays,
  replacePlays,
  setState,
  upsertGames,
  upsertRecaps,
  upsertScores,
} from './db.ts'
import { HIGHLIGHT_LOOKBACK_MS, HIGHLIGHT_OVERDUE_MS, matchHighlights } from './highlights.ts'
import { buildRecap, type Recap } from './recap.ts'
import { refitWeights } from './refit.ts'
import { REFERENCE_SEASON_COUNT } from './scoring/model.ts'
import { DEFAULT_MODEL, scoreGames, type RawSignals, type ScoringModel } from './scoring/score.ts'
import { gameSignals } from './scoring/signals.ts'
import { computeStakes, type Stakes } from './scoring/stakes.ts'
import { fetchPbp, fetchPbpAssets, fetchSchedule } from './sources/nflverse.ts'
import { fetchUploads, NFL_CHANNEL_ID } from './sources/youtube.ts'
import type { ScheduleGame } from './types.ts'

export interface IngestOptions {
  now?: Date
  force?: boolean // re-download everything and re-score
  refit?: boolean // refit weights from ratings now, ignoring the weekly schedule
  log?: (msg: string) => void
}

export interface IngestResult {
  season: number
  scheduleChanged: boolean
  seasonsRefreshed: number[]
  scored: number
  highlightsMatched: number
  awaitingPbp: string[] // final games with no play-by-play yet
  schedule: ScheduleGame[]
}

/**
 * One ingestion pass: refresh the schedule, pull any play-by-play that changed
 * upstream, then score every finished game against the reference seasons.
 */
export async function runIngest(db: DatabaseSync, opts: IngestOptions = {}): Promise<IngestResult> {
  const now = opts.now ?? new Date()
  const log = opts.log ?? console.log
  const season = currentSeason(now)
  const seasons = Array.from({ length: REFERENCE_SEASON_COUNT + 1 }, (_, i) => season - REFERENCE_SEASON_COUNT + i)
  const referenceSeasons = seasons.slice(0, -1)

  // Schedule -------------------------------------------------------------
  const etagKey = 'nflverse_games_etag'
  const sched = await fetchSchedule(opts.force ? null : getState(db, etagKey))
  const schedule = sched.games.filter((g) => seasons.includes(g.season))
  const stakes = computeStakes(schedule)
  if (sched.changed || opts.force) upsertGames(db, schedule, stakes)
  if (sched.etag) setState(db, etagKey, sched.etag)
  log(`schedule: ${schedule.length} games in ${seasons[0]}-${season}${sched.changed ? ' (updated)' : ' (unchanged)'}`)

  // Play-by-play -----------------------------------------------------------
  const refreshed: number[] = []
  try {
    const assets = await fetchPbpAssets()
    for (const s of seasons) {
      const asset = assets.get(s)
      if (!asset) continue
      const key = `nflverse_pbp_${s}_updated_at`
      if (!opts.force && getState(db, key) === asset.updatedAt) continue
      const plays = await fetchPbp(asset)
      replacePlays(db, plays)
      setState(db, key, asset.updatedAt)
      refreshed.push(s)
      log(`pbp ${s}: ${plays.length} plays (published ${asset.updatedAt})`)
    }
  } catch (err) {
    // Keep going with what is already stored; the next pass retries.
    log(`pbp refresh skipped: ${(err as Error).message}`)
  }

  // Scoring ----------------------------------------------------------------
  const final = schedule.filter((g) => g.result !== null)
  const withPlays = gamesWithPlays(db)
  const awaitingPbp = final.filter((g) => !withPlays.has(g.game_id)).map((g) => g.game_id)
  const scoringCtx = { final, seasons, referenceSeasons, stakes, now, log }
  const active = activeWeightSet(db, DEFAULT_MODEL)
  const nothingNew =
    !sched.changed && refreshed.length === 0 && !opts.force && hasScores(db, DEFAULT_MODEL.version) && hasScores(db, active.version)
  let scored = 0
  if (nothingNew) log('no new data; scores unchanged')
  else scored = scoreFinalGames(db, scoringCtx)
  if (awaitingPbp.length > 0) log(`awaiting play-by-play: ${awaitingPbp.join(', ')}`)

  // Weights from ratings: needs the starting-weight scores above for percentiles.
  const refit = refitWeights(db, now, { force: opts.refit, referenceSeasons })
  if (refit.status === 'adopted') {
    const { set, holdout } = refit
    log(`refit: adopted ${set.version} from ${set.ratingsUsed} ratings (holdout ${holdout.candidate.toFixed(2)} vs ${holdout.previous.toFixed(2)})`)
    scored = scoreFinalGames(db, scoringCtx)
  } else if (refit.status === 'kept' || opts.refit) log(`refit ${refit.status}: ${refit.reason}`)

  // Highlights run every pass: videos usually land after the play-by-play.
  const highlightsMatched = await refreshHighlights(db, now, log)

  return { season, scheduleChanged: sched.changed, seasonsRefreshed: refreshed, scored, highlightsMatched, awaitingPbp, schedule }
}

function scoreFinalGames(
  db: DatabaseSync,
  ctx: {
    final: ScheduleGame[]
    seasons: number[]
    referenceSeasons: number[]
    stakes: Map<string, Stakes>
    now: Date
    log: (msg: string) => void
  },
): number {
  const { final, seasons, referenceSeasons, stakes, now, log } = ctx
  const plays = loadPlays(db, seasons)
  const raw = new Map<string, RawSignals>()
  const reference: RawSignals[] = []
  const recaps = new Map<string, Recap>()
  for (const g of final) {
    const gamePlays = plays.get(g.game_id)
    if (!gamePlays) continue
    recaps.set(g.game_id, buildRecap(gamePlays, g))
    const sig = gameSignals(gamePlays)
    const r: RawSignals = {
      excitement: sig.excitement,
      late_closeness: sig.late_closeness,
      comeback: sig.comeback,
      explosive: sig.explosive,
      touchdowns: sig.touchdowns,
      turnovers: sig.turnovers,
      stakes: stakes.get(g.game_id)?.stakes ?? 0,
      big_moment: sig.big_moment,
    }
    raw.set(g.game_id, r)
    if (referenceSeasons.includes(g.season)) reference.push(r)
  }
  if (reference.length === 0) throw new Error(`no reference games for ${referenceSeasons.join(', ')}; cannot score`)

  // Always score with the starting weights (percentiles for refits, parity with
  // the notebook), plus the active fitted set when there is one.
  const active = activeWeightSet(db, DEFAULT_MODEL)
  const models: ScoringModel[] = active.version === DEFAULT_MODEL.version ? [DEFAULT_MODEL] : [DEFAULT_MODEL, active]
  let count = 0
  for (const model of models) {
    const scores = scoreGames(raw, reference, model)
    upsertScores(db, scores, now.toISOString())
    count = scores.length
  }
  upsertRecaps(db, recaps, now.toISOString())
  log(`scored ${count} games with ${models.map((m) => m.version).join(' and ')} (reference: ${reference.length} games)`)
  return count
}

/** Match recent final games to official highlight uploads. Returns how many were matched. */
async function refreshHighlights(db: DatabaseSync, now: Date, log: (msg: string) => void): Promise<number> {
  const pending = gamesNeedingHighlights(db, new Date(now.getTime() - HIGHLIGHT_LOOKBACK_MS))
  if (pending.length === 0) return 0
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) {
    log(`highlights skipped: YOUTUBE_API_KEY is not set (${pending.length} games waiting)`)
    return 0
  }
  try {
    const uploads = await fetchUploads(NFL_CHANNEL_ID, new Date(pending[0].kickoff_at), apiKey)
    const matches = matchHighlights(pending, uploads)
    insertHighlights(db, matches, 'nfl-uploads-title', now.toISOString())
    const overdue = pending.filter((g) => !matches.has(g.id) && now.getTime() - Date.parse(g.kickoff_at) > HIGHLIGHT_OVERDUE_MS)
    log(`highlights: matched ${matches.size} of ${pending.length} waiting games (${uploads.length} uploads checked)`)
    if (overdue.length > 0) log(`highlights not yet available after 24h: ${overdue.map((g) => g.id).join(', ')}`)
    return matches.size
  } catch (err) {
    log(`highlights skipped: ${(err as Error).message}`)
    return 0
  }
}

/**
 * Minutes until the next pass: every 15 minutes from kickoff day through the day
 * after (nflverse often publishes overnight), hourly otherwise.
 */
export function nextIntervalMinutes(schedule: ScheduleGame[], now: Date): number {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const today = day(now)
  const yesterday = day(new Date(now.getTime() - 86_400_000))
  return schedule.some((g) => g.gameday === today || g.gameday === yesterday) ? 15 : 60
}
