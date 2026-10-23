import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertHighlights, openDb, upsertGames, upsertScores } from './db.ts'
import { listGames, listWeeks, revealGame, slotLabel } from './queries.ts'
import { scoreGames, type RawSignals } from './scoring/score.ts'
import type { ScheduleGame } from './types.ts'

const sched = (o: Partial<ScheduleGame>): ScheduleGame => ({
  game_id: 'X', season: 2026, game_type: 'REG', week: 5, gameday: '2026-10-11', weekday: 'Sunday',
  gametime: '13:00', away_team: 'BUF', home_team: 'LA', away_score: null, home_score: null,
  result: null, div_game: 0, spread_line: 3, ...o,
})
const raw = (x: number): RawSignals => ({
  excitement: x, late_closeness: x, comeback: x, explosive: x, touchdowns: x, turnovers: x, stakes: x, big_moment: false,
})

function fixture() {
  const db = openDb(':memory:')
  const games = [
    sched({ game_id: 'G_DULL', away_team: 'LV', home_team: 'KC', away_score: 0, home_score: 31, result: 31 }),
    sched({ game_id: 'G_WILD', away_team: 'BUF', home_team: 'LA', gametime: '20:20', away_score: 37, home_score: 34, result: -3, div_game: 1 }),
    sched({ game_id: 'G_WAIT', away_team: 'NYG', home_team: 'WAS', gametime: '16:25', away_score: 27, home_score: 27, result: 0 }),
    sched({ game_id: 'G_NEXT', away_team: 'SEA', home_team: 'DEN', gameday: '2026-10-15', weekday: 'Thursday', gametime: '20:15' }),
  ]
  upsertGames(db, games, new Map([['G_WILD', { stakes: 0.6, playoff: false, division: true, primetime: true, race: false }]]))
  const scores = scoreGames(new Map([['G_DULL', raw(0)], ['G_WILD', raw(9)]]), [raw(0), raw(5), raw(9)])
  upsertScores(db, scores, '2026-10-12T00:00:00Z')
  insertHighlights(db, new Map([['G_WILD', { videoId: 'vid123', channelId: 'UC', title: 'ignored', publishedAt: '2026-10-12T04:00:00Z' }]]), 'test', 'now')
  return db
}

test('the list API never carries scores, winners or signal values', () => {
  const body = listGames(fixture(), 2026, 5, new Date('2026-10-13T12:00:00Z'))!
  const text = JSON.stringify(body)
  for (const key of ['score', 'result', 'total', 'winner', 'pct', 'signals', 'raw', 'overtime', 'stars']) {
    assert.ok(!new RegExp(`"\\w*${key}\\w*"\\s*:`, 'i').test(text), `response has a "${key}" field`)
  }
  for (const value of ['37', '34', '31']) assert.ok(!text.includes(`:${value},`), `response contains final score ${value}`)
  assert.ok(!text.includes('ignored'), 'source video title leaked')
})

test('ranked games come first, best first, then awaiting data, then upcoming', () => {
  const body = listGames(fixture(), 2026, 5, new Date('2026-10-13T12:00:00Z'))!
  assert.deepEqual(body.games.map((g) => [g.id, g.state]), [
    ['G_WILD', 'ranked'],
    ['G_DULL', 'ranked'],
    ['G_WAIT', 'awaiting_data'],
    ['G_NEXT', 'upcoming'],
  ])
  const [wild, dull, wait, next] = body.games
  assert.deepEqual(wild.highlights, { status: 'available', videoId: 'vid123' })
  assert.deepEqual(wild.tags, ['Division rivalry', 'Primetime'])
  assert.equal(wild.away.name, 'Buffalo Bills')
  assert.deepEqual(dull.highlights, { status: 'not_yet_available' }) // 24h+ after kickoff, no video
  assert.equal(wait.tier, null)
  assert.equal(next.highlights, null)
})

test('weeks default to the latest week with at least two ranked games', () => {
  const weeks = listWeeks(fixture(), 2026)
  assert.equal(weeks.defaultWeek, 5)
  assert.equal(weeks.weeks[0].label, 'Week 5')
})

test('reveal returns the score and breakdown for final games only', () => {
  const db = fixture()
  const wild = revealGame(db, 'G_WILD')!
  assert.equal(wild.away.score, 37)
  assert.equal(wild.home.score, 34)
  assert.equal(wild.why?.tier, 'Must watch')
  assert.equal(wild.why?.contributions.length, 8)
  assert.equal(revealGame(db, 'G_WAIT')?.why, null) // final but not ranked yet: score, no breakdown
  assert.equal(revealGame(db, 'G_NEXT'), null) // not played
  assert.equal(revealGame(db, 'NOPE'), null)
})

test('slot labels follow Eastern kickoff times', () => {
  assert.equal(slotLabel('2026-10-11T17:00:00Z'), 'Sunday early')
  assert.equal(slotLabel('2026-10-11T20:25:00Z'), 'Sunday late')
  assert.equal(slotLabel('2026-10-12T00:20:00Z'), 'Sunday night')
  assert.equal(slotLabel('2026-10-11T13:30:00Z'), 'Sunday morning')
  assert.equal(slotLabel('2026-10-13T00:15:00Z'), 'Monday night')
})
