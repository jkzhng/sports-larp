import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeWeightSet, openDb, upsertGames, upsertRating, upsertScores } from './db.ts'
import { refitWeights } from './refit.ts'
import { MODEL_VERSION, SIGNALS, TIERS, WEIGHTS, type SignalName, type Weights } from './scoring/model.ts'
import { DEFAULT_MODEL, weightedTotal, type WatchScore } from './scoring/score.ts'
import { blend, calibrateCutoffs, concordance, fittedShare, fitWeights, type RatedGame, type ReferenceGame } from './tuning.ts'
import type { ScheduleGame } from './types.ts'

// Deterministic random numbers (mulberry32) so failures reproduce.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const randomPct = (rand: () => number) => Object.fromEntries(SIGNALS.map((s) => [s, rand()])) as Record<SignalName, number>
const zero = Object.fromEntries(SIGNALS.map((s) => [s, 0])) as Weights

// Someone who only cares about action: explosive plays and touchdowns.
const ACTION_FAN: Weights = { ...zero, explosive: 0.6, touchdowns: 0.4 }

function ratingsFor(taste: Weights, n: number, seed: number, noise = 0): RatedGame[] {
  const rand = rng(seed)
  return Array.from({ length: n }, () => {
    const pct = randomPct(rand)
    const signal = weightedTotal(pct, false, taste) / 100
    const stars = Math.min(5, Math.max(1, Math.round(1 + 4 * signal + noise * (rand() - 0.5))))
    return { pct, bigMoment: false, stars }
  })
}

test('the fit recovers which signals a rater cares about', () => {
  const w = fitWeights(ratingsFor(ACTION_FAN, 200, 1))!
  assert.ok(Math.abs(SIGNALS.reduce((a, s) => a + w[s], 0) - 1) < 1e-9, 'weights sum to 1')
  assert.ok(SIGNALS.every((s) => w[s] >= 0), 'weights are non-negative')
  assert.ok(w.explosive > 0.45 && w.explosive < 0.75, `explosive ${w.explosive}`)
  assert.ok(w.touchdowns > 0.25 && w.touchdowns < 0.55, `touchdowns ${w.touchdowns}`)
  for (const s of ['excitement', 'late_closeness', 'comeback', 'turnovers', 'stakes'] as const) assert.ok(w[s] < 0.08, `${s} ${w[s]}`)
})

test('the fit gives up when ratings ignore every signal', () => {
  const flat = ratingsFor(ACTION_FAN, 30, 2).map((r) => ({ ...r, stars: 3 }))
  assert.equal(fitWeights(flat), null)
})

test('concordance counts correctly ordered pairs', () => {
  const games = ratingsFor(ACTION_FAN, 40, 3)
  assert.ok(concordance(games, ACTION_FAN) > 0.95)
  const backwards = games.map((g) => ({ ...g, stars: 6 - g.stars }))
  assert.ok(concordance(backwards, ACTION_FAN) < 0.05)
})

test('fitted share follows the spec: 50/50 at 20 ratings, 80/20 from 60', () => {
  assert.equal(fittedShare(19), 0)
  assert.equal(fittedShare(20), 0.5)
  assert.equal(fittedShare(40), 0.65)
  assert.equal(fittedShare(60), 0.8)
  assert.equal(fittedShare(200), 0.8)
  const b = blend(ACTION_FAN, WEIGHTS, 0.5)
  assert.ok(Math.abs(SIGNALS.reduce((a, s) => a + b[s], 0) - 1) < 1e-3)
  assert.equal(b.explosive, (0.6 + 0.22) / 2)
})

test('recalibrated cutoffs keep about 3 Must watch games a week', () => {
  const rand = rng(4)
  const reference: ReferenceGame[] = []
  for (let week = 1; week <= 18; week++) {
    for (let g = 0; g < 16; g++) reference.push({ season: 2025, week, regular: true, pct: randomPct(rand), bigMoment: false })
  }
  const cutoffs = calibrateCutoffs(reference, ACTION_FAN, DEFAULT_MODEL)
  const must = cutoffs[0][0]
  const perWeek = reference.filter((g) => weightedTotal(g.pct, false, ACTION_FAN) >= must).length / 18
  assert.ok(perWeek > 2.7 && perWeek < 3.3, `${perWeek} per week`)
  assert.ok(cutoffs[1][0] <= must)
})

// ---------------------------------------------------------------- refit job

function refitFixture(ratings: RatedGame[]) {
  const db = openDb(':memory:')
  const sched = (id: string, season: number, week: number): ScheduleGame => ({
    game_id: id, season, game_type: 'REG', week, gameday: `${season}-10-11`, weekday: 'Sunday', gametime: '13:00',
    away_team: 'BUF', home_team: 'LA', away_score: 20, home_score: 17, result: -3, div_game: 0, spread_line: 3,
  })
  const rand = rng(5)
  const games: ScheduleGame[] = []
  const scores: WatchScore[] = []
  const add = (id: string, season: number, week: number, pct: Record<SignalName, number>) => {
    games.push(sched(id, season, week))
    const raw = { ...pct, big_moment: false }
    scores.push({ game_id: id, model_version: MODEL_VERSION, total: 50, stars: 3, tier: 'Worth it', raw, pct })
  }
  for (let i = 0; i < 160; i++) add(`REF_${i}`, 2025, 1 + (i % 10), randomPct(rand))
  ratings.forEach((r, i) => add(`RATED_${i}`, 2026, 1, r.pct))
  upsertGames(db, games, new Map())
  upsertScores(db, scores, '2026-10-01T00:00:00Z')
  // One rating an hour, in order, so the last ones are the most recent.
  ratings.forEach((r, i) => upsertRating(db, `RATED_${i}`, r.stars, new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString(), MODEL_VERSION))
  return db
}

test('refit waits for 20 ratings, then adopts a personalized, versioned weight set', () => {
  const few = refitFixture(ratingsFor(ACTION_FAN, 12, 6))
  const skipped = refitWeights(few, new Date('2026-10-17T00:00:00Z'), { referenceSeasons: [2025] })
  assert.deepEqual(skipped, { status: 'skipped', reason: '12 of 20 ratings needed to personalize' })
  assert.equal(activeWeightSet(few, DEFAULT_MODEL).version, MODEL_VERSION)

  const db = refitFixture(ratingsFor(ACTION_FAN, 40, 7, 0.5))
  const now = new Date('2026-10-17T00:00:00Z')
  const result = refitWeights(db, now, { referenceSeasons: [2025] })
  assert.equal(result.status, 'adopted')
  const active = activeWeightSet(db, DEFAULT_MODEL)
  assert.equal(active.version, `${MODEL_VERSION}+w1`)
  assert.equal(active.ratingsUsed, 40)
  assert.equal(active.fittedShare, 0.65)
  assert.ok(active.weights.explosive > WEIGHTS.explosive, 'moves toward what the ratings reward')
  assert.ok(active.weights.late_closeness < WEIGHTS.late_closeness)
  assert.notDeepEqual(active.cutoffs, TIERS, 'cutoffs recalibrated')

  // Nothing new: no refit until more ratings arrive and a week has passed.
  assert.equal(refitWeights(db, now, { referenceSeasons: [2025] }).status, 'skipped')
})

test('refit keeps the current weights when the new ones rank recent ratings worse', () => {
  // Older ratings reward action; the 10 most recent reward the opposite.
  const older = ratingsFor(ACTION_FAN, 20, 8)
  const recent = ratingsFor(ACTION_FAN, 10, 9).map((r) => ({ ...r, stars: 6 - r.stars }))
  const db = refitFixture([...older, ...recent])
  const result = refitWeights(db, new Date('2026-10-17T00:00:00Z'), { referenceSeasons: [2025] })
  assert.equal(result.status, 'kept')
  assert.equal(activeWeightSet(db, DEFAULT_MODEL).version, MODEL_VERSION)
})
