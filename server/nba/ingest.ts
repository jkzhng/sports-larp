// One NBA ingestion pass: schedule from ESPN's scoreboard, summaries for newly
// finished games, scores and recaps, then highlight matching.
import type { DatabaseSync } from 'node:sqlite'
import {
  activeWeightSet,
  getState,
  hasScores,
  insertHighlights,
  nbaGamesNeedingHighlights,
  setState,
  storedRawSignals,
  upsertNbaGames,
  upsertRecaps,
  upsertScores,
} from '../db.ts'
import { HIGHLIGHT_LOOKBACK_MS } from '../highlights.ts'
import type { Recap } from '../recap.ts'
import { NBA_REFIT, refitWeights } from '../refit.ts'
import { scoreGames, type RawSignals, type ScoringModel } from '../scoring/score.ts'
import { easternDate, fetchNbaSchedule, fetchSummary, hasSummary, pool, type NbaGame } from '../sources/espn.ts'
import { fetchUploads, NBA_CHANNEL_ID } from '../sources/youtube.ts'
import { matchNbaHighlights } from './highlights.ts'
import { currentNbaSeason, NATIONAL_TV, NBA_MODEL, REFERENCE_SEASON_COUNT, type NbaSignal } from './model.ts'
import { buildNbaRecap } from './recap.ts'
import { nbaGameSignals } from './signals.ts'
import { computeNbaStakes, type NbaStakes } from './stakes.ts'

export interface NbaIngestResult {
  season: number
  scored: number
  newSummaries: number
  highlightsMatched: number
  schedule: NbaGame[]
}

// ESPN 404s a handful of old games, and a few summaries have no win
// probability; stop retrying those once they're this old.
const MISSING_GIVE_UP_MS = 2 * 86_400_000
const MISSING_KEY = 'espn_nba_missing_summaries'

const ROUND = /^(East|West) (1st Round|Semifinals|Finals) - Game (\d)$/
const FINALS = /^NBA Finals - Game (\d)$/

/** Pre-game tags shown on the card. Never anything that depends on the result. */
export function nbaTags(g: NbaGame, s: NbaStakes): string[] {
  const tags: string[] = []
  const round = ROUND.exec(g.notes)
  const finals = FINALS.exec(g.notes)
  if (finals) tags.push(`NBA Finals · Game ${finals[1]}`)
  else if (round) tags.push(`${round[1]} ${round[2]} · Game ${round[3]}`)
  else if (s.playoff) tags.push('Playoffs')
  if (s.playIn) tags.push('Play-In')
  if (s.cupKnockout) tags.push(g.comp_type === 'CC' ? 'NBA Cup final' : 'NBA Cup knockout')
  if (s.race) tags.push('Playoff race')
  else if (s.marquee) tags.push('Top teams')
  const tv = g.national_tv.filter((n) => NATIONAL_TV.has(n))
  if (tv.length > 0) tags.push(tv.join(' / '))
  return tags
}

export async function runNbaIngest(
  db: DatabaseSync,
  opts: { now?: Date; force?: boolean; refit?: boolean; log?: (msg: string) => void } = {},
): Promise<NbaIngestResult> {
  const now = opts.now ?? new Date()
  const log = opts.log ?? console.log
  const season = currentNbaSeason(now)
  const seasons = Array.from({ length: REFERENCE_SEASON_COUNT + 1 }, (_, i) => season - REFERENCE_SEASON_COUNT + i)
  const referenceSeasons = seasons.slice(0, -1)

  // Schedule -------------------------------------------------------------
  const schedule = await fetchNbaSchedule(seasons, now)
  const stakes = computeNbaStakes(schedule)
  upsertNbaGames(db, schedule, new Map(schedule.map((g) => [g.game_id, nbaTags(g, stakes.get(g.game_id)!)])))
  const final = schedule.filter((g) => g.completed)
  const tonight = schedule.filter((g) => g.night === easternDate(now))
  log(`nba schedule: ${schedule.length} games in ${seasons[0]}-${season}, ${final.length} final, ${tonight.length} tonight`)

  // Summaries for newly finished games -------------------------------------
  const missing = new Set<string>(JSON.parse(getState(db, MISSING_KEY) ?? '[]') as string[])
  const toFetch = final.filter((g) => !hasSummary(g.game_id) && !missing.has(g.game_id))
  let newSummaries = 0
  let done = 0
  // A fresh clone backfills ~4,000 games here; later passes fetch a handful.
  await pool(toFetch, 6, async (g) => {
    try {
      const s = await fetchSummary(g.game_id)
      if (s) newSummaries++
      else if (now.getTime() - Date.parse(g.tipoff) > MISSING_GIVE_UP_MS) missing.add(g.game_id)
    } catch (err) {
      log(`nba summary ${g.game_id} skipped: ${(err as Error).message}`)
    }
    if (++done % 500 === 0) log(`nba summaries: ${done} of ${toFetch.length}`)
  })
  if (toFetch.length > 0) log(`nba summaries: ${newSummaries} new of ${toFetch.length} needed`)

  // Scoring ----------------------------------------------------------------
  const stored = opts.force ? new Map<string, RawSignals<NbaSignal>>() : storedRawSignals<NbaSignal>(db, NBA_MODEL.version)
  const unscored = final.filter((g) => hasSummary(g.game_id) && !stored.has(g.game_id) && !missing.has(g.game_id))
  const scoringCtx = { final, referenceSeasons, stakes, now, log }
  let count = 0
  if (unscored.length === 0 && !opts.force && hasScores(db, activeWeightSet(db, NBA_MODEL).version)) {
    log('nba: no new games; scores unchanged')
  } else {
    const result = await scoreNbaGames(db, { ...scoringCtx, stored })
    count = result.scored
    for (const g of final) {
      if (result.unusable.includes(g.game_id) && now.getTime() - Date.parse(g.tipoff) > MISSING_GIVE_UP_MS) missing.add(g.game_id)
    }
  }
  setState(db, MISSING_KEY, JSON.stringify([...missing]))

  // Weights from ratings: needs the starting-weight scores above for percentiles.
  const refit = refitWeights(db, now, { force: opts.refit, referenceSeasons, league: NBA_REFIT })
  if (refit.status === 'adopted') {
    const { set, holdout } = refit
    log(`nba refit: adopted ${set.version} from ${set.ratingsUsed} ratings (holdout ${holdout.candidate.toFixed(2)} vs ${holdout.previous.toFixed(2)})`)
    // Every game is scored by now, so this only re-ranks stored signals.
    count = (await scoreNbaGames(db, { ...scoringCtx, stored: storedRawSignals<NbaSignal>(db, NBA_MODEL.version) })).scored
  } else if (refit.status === 'kept' || opts.refit) log(`nba refit ${refit.status}: ${refit.reason}`)

  const highlightsMatched = await refreshNbaHighlights(db, now, log)
  return { season, scored: count, newSummaries, highlightsMatched, schedule }
}

/**
 * Minutes until the next pass: every 15 minutes on a game night and into the
 * small hours after it (late West Coast games), hourly otherwise.
 */
export function nextNbaIntervalMinutes(schedule: NbaGame[], now: Date): number {
  const today = easternDate(now)
  const yesterday = easternDate(new Date(now.getTime() - 86_400_000))
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }))
  const busy = schedule.some((g) => g.night === today || (g.night === yesterday && hour < 4))
  return busy ? 15 : 60
}

async function scoreNbaGames(
  db: DatabaseSync,
  ctx: {
    final: NbaGame[]
    stored: Map<string, RawSignals<NbaSignal>> // raw signals of games scored before; only the rest are parsed
    referenceSeasons: number[]
    stakes: Map<string, NbaStakes>
    now: Date
    log: (msg: string) => void
  },
): Promise<{ scored: number; unusable: string[] }> {
  const { final, stored, referenceSeasons, stakes, now, log } = ctx
  const unusable: string[] = []
  const raw = new Map<string, RawSignals<NbaSignal>>()
  const reference: RawSignals<NbaSignal>[] = []
  const recaps = new Map<string, Recap>()
  // One summary in memory at a time: all of them together are several hundred MB.
  for (const g of final) {
    const known = stored.get(g.game_id)
    if (known) {
      const r = { ...known, stakes: stakes.get(g.game_id)?.stakes ?? 0 }
      raw.set(g.game_id, r)
      if (referenceSeasons.includes(g.season)) reference.push(r)
      continue
    }
    if (!hasSummary(g.game_id)) continue
    const summary = await fetchSummary(g.game_id)
    if (!summary) continue
    const sig = nbaGameSignals(summary)
    if (!sig) {
      unusable.push(g.game_id) // no plays or no win probability
      continue
    }
    const r: RawSignals<NbaSignal> = {
      excitement: sig.excitement,
      late_closeness: sig.late_closeness,
      comeback: sig.comeback,
      highlight_plays: sig.highlight_plays,
      scoring: sig.scoring,
      star: sig.star,
      stakes: stakes.get(g.game_id)?.stakes ?? 0,
      big_moment: sig.big_moment,
    }
    raw.set(g.game_id, r)
    if (referenceSeasons.includes(g.season)) reference.push(r)
    const recap = buildNbaRecap(summary, g.home_team, g.away_team)
    if (recap) recaps.set(g.game_id, recap)
  }
  if (reference.length === 0) throw new Error(`no NBA reference games for ${referenceSeasons.join(', ')}; cannot score`)

  // Always score with the starting weights (percentiles for refits, parity with
  // the notebook), plus the active fitted set when there is one.
  const active = activeWeightSet(db, NBA_MODEL)
  const models: ScoringModel<NbaSignal>[] = active.version === NBA_MODEL.version ? [NBA_MODEL] : [NBA_MODEL, active]
  let count = 0
  for (const model of models) {
    const scores = scoreGames(raw, reference, model)
    upsertScores(db, scores, now.toISOString())
    count = scores.length
  }
  upsertRecaps(db, recaps, now.toISOString())
  log(`nba: scored ${count} games with ${models.map((m) => m.version).join(' and ')} (${recaps.size} new; reference: ${reference.length} games)`)
  return { scored: count, unusable }
}

async function refreshNbaHighlights(db: DatabaseSync, now: Date, log: (msg: string) => void): Promise<number> {
  const pending = nbaGamesNeedingHighlights(db, new Date(now.getTime() - HIGHLIGHT_LOOKBACK_MS))
  if (pending.length === 0) return 0
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) {
    log(`nba highlights skipped: YOUTUBE_API_KEY is not set (${pending.length} games waiting)`)
    return 0
  }
  try {
    // The NBA uploads about 50 videos a day, so 14 days can take 15+ pages.
    const uploads = await fetchUploads(NBA_CHANNEL_ID, new Date(pending[0].kickoff_at), apiKey, 30)
    const matches = matchNbaHighlights(pending, uploads)
    insertHighlights(db, matches, 'nba-uploads-title', now.toISOString())
    log(`nba highlights: matched ${matches.size} of ${pending.length} waiting games (${uploads.length} uploads checked)`)
    return matches.size
  } catch (err) {
    log(`nba highlights skipped: ${(err as Error).message}`)
    return 0
  }
}
