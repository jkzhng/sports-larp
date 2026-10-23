import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activateWeightSet, activeWeightSet, openDb, upsertNbaGames, upsertRating, upsertScores } from '../db.ts'
import { listNbaGames, listNights, revealGame } from '../queries.ts'
import { NBA_REFIT, refitWeights } from '../refit.ts'
import { DEFAULT_MODEL, scoreGames, type RawSignals } from '../scoring/score.ts'
import type { NbaGame, Summary } from '../sources/espn.ts'
import { matchNbaHighlights, parseNbaHighlightTitle } from './highlights.ts'
import { nbaTags } from './ingest.ts'
import { NBA_MODEL, SIGNALS, WEIGHTS, type NbaSignal } from './model.ts'
import { buildNbaRecap } from './recap.ts'
import { nbaGameSignals } from './signals.ts'
import { computeNbaStakes } from './stakes.ts'

test('parses full-game highlight titles: regular season, playoffs, Finals, Cup', () => {
  assert.deepEqual(parseNbaHighlightTitle('NUGGETS at LAKERS | FULL GAME HIGHLIGHTS | October 16, 2027'), {
    away: 'DEN', home: 'LAL', night: '2027-10-16', extended: false,
  })
  assert.equal(parseNbaHighlightTitle('#4 PACERS at #1 THUNDER | NBA FINALS GAME 7 HIGHLIGHTS | June 22, 2025')?.home, 'OKC')
  assert.equal(parseNbaHighlightTitle('#7 76ERS at #2 CELTICS | FULL GAME 7 HIGHLIGHTS | May 2, 2026')?.away, 'PHI')
  assert.equal(parseNbaHighlightTitle('TRAIL BLAZERS at WARRIORS | EMIRATES NBA CUP 🏆 | FULL GAME HIGHLIGHTS | November 21, 2025')?.away, 'POR')
  assert.equal(parseNbaHighlightTitle('EXTENDED: SPURS at THUNDER | EMIRATES NBA CUP 🏆 | FULL GAME HIGHLIGHTS | December 13, 2025')?.extended, true)
})

test('ignores preseason, series recaps, endings and player clips', () => {
  for (const title of [
    'JAZZ at SUNS | NBA PRESEASON FULL GAME HIGHLIGHTS | October 16, 2026',
    '#4 PACERS at #3 KNICKS | FULL SERIES RECAP | 2025 #NBAPlayoffs presented by Google',
    'Final 6:45 WILD GAME 7 ENDING #2 Spurs at #1 Thunder | May 30, 2026',
    "NBA's Top 10 Plays of the Night | October 16, 2026",
    'Ben Simmons Was BALLING vs Spurs in Preseason | October 16, 2026',
  ]) {
    assert.equal(parseNbaHighlightTitle(title), null, title)
  }
})

test('matches by teams and night, preferring the regular cut to the extended one', () => {
  const up = (videoId: string, title: string, publishedAt = '2025-12-14T05:00:00Z') => ({ videoId, channelId: 'UC', title, publishedAt })
  const matches = matchNbaHighlights(
    [
      { id: 'G1', night: '2025-12-13', home_team: 'OKC', away_team: 'SA' },
      { id: 'G2', night: '2025-12-14', home_team: 'OKC', away_team: 'SA' },
    ],
    [
      up('ext', 'EXTENDED: SPURS at THUNDER | EMIRATES NBA CUP 🏆 | FULL GAME HIGHLIGHTS | December 13, 2025', '2025-12-14T04:00:00Z'),
      up('reg', 'SPURS at THUNDER | EMIRATES NBA CUP 🏆 | FULL GAME HIGHLIGHTS | December 13, 2025'),
    ],
  )
  assert.equal(matches.get('G1')?.videoId, 'reg')
  assert.equal(matches.has('G2'), false)
})

// A tiny ESPN summary: home BOS, away NY. Each play is [period, clock, type, text, away, home, wp, flags].
type P = [number, string, string, string, number, number, number, { scoring?: boolean; value?: number; home?: boolean }?]
function summary(plays: P[], box: [string, string, string[]][] = []): Summary {
  return {
    header: { competitions: [{ competitors: [
      { homeAway: 'home', team: { id: '2', abbreviation: 'BOS' } },
      { homeAway: 'away', team: { id: '18', abbreviation: 'NY' } },
    ] }] },
    plays: plays.map(([period, clock, type, text, awayScore, homeScore, , f = {}], i) => ({
      id: String(i), period: { number: period }, clock: { displayValue: clock }, type: { text: type }, text,
      awayScore, homeScore, scoringPlay: f.scoring ?? false, scoreValue: f.value ?? 0,
      shootingPlay: f.scoring !== undefined || type.includes('Shot') || type.includes('Free Throw'),
      team: { id: f.home ? '2' : '18' },
    })),
    winprobability: plays.map((p, i) => ({ playId: String(i), homeWinPercentage: p[6] })),
    boxscore: { players: box.map(([team, name, stats]) => ({
      team: { abbreviation: team },
      statistics: [{ labels: ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK'], athletes: [{ athlete: { displayName: name }, stats }] }],
    })) },
  }
}

const made = { scoring: true, value: 2 }
const GAME = summary(
  [
    [1, '12:00', 'Jumpball', 'Jump ball', 0, 0, 0.6],
    [1, '11:40', 'Driving Dunk Shot', 'Jaylen Brown makes driving dunk', 0, 2, 0.65, { ...made, home: true }],
    [1, '10:00', 'Jump Shot', "Mitchell Robinson blocks Jayson Tatum 's 5-foot jumper", 0, 2, 0.63],
    [2, '5:00', 'Jump Shot', 'Jalen Brunson makes 33-foot three point jumper', 3, 2, 0.55, { scoring: true, value: 3 }],
    [4, '5:00', 'Jump Shot', 'Jayson Tatum makes 20-foot jumper', 100, 98, 0.45, { ...made, home: true }],
    [4, '0:10.0', 'Jump Shot', 'Jalen Brunson makes 18-foot jumper', 102, 100, 0.2, made],
    [4, '0:01.0', 'Pullup Jump Shot', 'Jayson Tatum makes 26-foot three point pullup jump shot', 102, 103, 0.97, { scoring: true, value: 3, home: true }],
    [4, '0:00.0', 'End Game', 'End of Game', 102, 103, 1],
  ],
  [
    ['BOS', 'Jayson Tatum', ['40', '41', '15-25', '5-9', '6-6', '12', '10', '2', '1', '0']],
    ['NY', 'Jalen Brunson', ['40', '33', '12-24', '3-8', '6-6', '3', '8', '2', '1', '0']],
  ],
)

test('signals: highlight plays, a late winner, and a triple-double star', () => {
  const s = nbaGameSignals(GAME)!
  assert.equal(s.highlight_plays, 3) // dunk, block, 33-foot three
  assert.equal(s.big_moment, true) // winner went ahead for good with 1 s left
  assert.equal(s.star, 41 + 10)
  assert.equal(s.scoring, 205)
  assert.equal(s.comeback, 0.8) // BOS fell to 20%
  assert.ok(s.late_closeness > 5) // close for the last 5 minutes of Q4, plus a lead change
  assert.equal(nbaGameSignals(summary([])), null)
})

test('recap: talking points lead with the winner, moments are shots in game order', () => {
  const r = buildNbaRecap(GAME, 'BOS', 'NY')!
  assert.equal(r.talkingPoints[0], 'Jayson Tatum led the Celtics with 41 points, 12 rebounds and 10 assists for a triple-double.')
  assert.equal(r.talkingPoints[1], 'Jalen Brunson led the Knicks with 33 points and 8 assists.')
  assert.equal(r.keyMoments.at(-1)!.text, 'Jayson Tatum makes 26-foot three point pullup jump shot (NY 102–103 BOS)')
  assert.equal(r.keyMoments.at(-1)!.clock, '0:01.0')
  assert.deepEqual(r.wp.at(-1), [2880, 1])
})

const game = (o: Partial<NbaGame>): NbaGame => ({
  game_id: 'X', season: 2026, season_type: 'REG', night: '2026-10-21', tipoff: '2026-10-21T23:30Z',
  home_team: 'BOS', away_team: 'NY', home_score: null, away_score: null, completed: false,
  notes: '', comp_type: 'STD', national_tv: [], ...o,
})

test('pre-game tags come from the schedule, never the result', () => {
  const games = [
    game({ game_id: 'P', season_type: 'POST', notes: 'East Semifinals - Game 7', national_tv: ['ESPN', 'ESPN+'] }),
    game({ game_id: 'C', notes: 'NBA In-Season Tournament - Quarterfinals', comp_type: 'QTR' }),
    game({ game_id: 'F', season_type: 'POST', notes: 'NBA Finals - Game 1', national_tv: ['ABC'] }),
  ]
  const stakes = computeNbaStakes(games)
  assert.deepEqual(nbaTags(games[0], stakes.get('P')!), ['East Semifinals · Game 7', 'ESPN'])
  assert.deepEqual(nbaTags(games[1], stakes.get('C')!), ['NBA Cup knockout'])
  assert.deepEqual(nbaTags(games[2], stakes.get('F')!), ['NBA Finals · Game 1', 'ABC'])
  assert.equal(stakes.get('P')!.stakes, 1.2)
  assert.equal(stakes.get('C')!.stakes, 0.8)
})

test('the NBA list API never carries scores, and reveal does', () => {
  const db = openDb(':memory:')
  const games = [
    game({ game_id: 'N1', completed: true, home_score: 103, away_score: 102, national_tv: ['TNT'] }),
    game({ game_id: 'N2', home_team: 'LAL', away_team: 'GS', tipoff: '2026-10-22T02:00Z' }),
  ]
  const stakes = computeNbaStakes(games)
  upsertNbaGames(db, games, new Map(games.map((g) => [g.game_id, nbaTags(g, stakes.get(g.game_id)!)])))
  const raw = (x: number): RawSignals<NbaSignal> => ({
    excitement: x, late_closeness: x, comeback: x, highlight_plays: x, scoring: x, star: x, stakes: x, big_moment: true,
  })
  upsertScores(db, scoreGames(new Map([['N1', raw(9)]]), [raw(0), raw(9)], NBA_MODEL), '2026-10-22T05:00:00Z')

  const body = listNbaGames(db, '2026-10-21', new Date('2026-10-22T06:00:00Z'))!
  const text = JSON.stringify(body)
  for (const key of ['score', 'result', 'total', 'winner', 'pct', 'signals', 'raw', 'overtime', 'stars']) {
    assert.ok(!new RegExp(`"\\w*${key}\\w*"\\s*:`, 'i').test(text), `response has a "${key}" field`)
  }
  assert.ok(!text.includes('103') && !text.includes('102'), 'response contains a final score')
  assert.deepEqual(body.games.map((g) => [g.id, g.state]), [['N1', 'ranked'], ['N2', 'upcoming']])
  assert.deepEqual(body.games[0].tags, ['TNT'])
  assert.equal(body.games[0].home.name, 'Boston Celtics')
  assert.equal(body.label, 'Wednesday, October 21')

  const nights = listNights(db, 2026, new Date('2026-10-22T06:00:00Z'))
  assert.equal(nights.defaultNight, '2026-10-21')
  assert.equal(nights.seasonLabel, '2026-27')

  const reveal = revealGame(db, 'N1')!
  assert.equal(reveal.home.score, 103)
  assert.equal(reveal.why?.contributions.find((c) => c.key === 'star')?.label, 'Star performance')
  assert.equal(reveal.winProbability.periodSeconds, 720)
})

test('overtime counts every period: a double-overtime game is 2', () => {
  const r = buildNbaRecap(summary([
    [1, '12:00', 'Jumpball', 'Jump ball', 0, 0, 0.5],
    [5, '2:00', 'Jump Shot', 'Jalen Brunson makes 18-foot jumper', 110, 108, 0.6, made],
    [6, '0:00.0', 'End Game', 'End of Game', 120, 118, 0],
  ]), 'BOS', 'NY')!
  assert.equal(r.overtime, 2)
  assert.equal(r.wp.at(-1)![0], 2880 + 600)
})

test('schema 5 turns the old overtime flag into a period count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sports-larp-'))
  const path = join(dir, 'old.db')
  try {
    const old = openDb(path)
    upsertNbaGames(old, [
      game({ game_id: 'OT2', completed: true, home_score: 120, away_score: 118 }),
      game({ game_id: 'OT1', completed: true, home_score: 110, away_score: 108 }),
    ], new Map())
    // As schema 4 stored them: a 0/1 flag.
    old.prepare("update recaps set overtime = 1, wp_series = ? where game_id = 'OT2'").run('[[0,0.5],[3480,0]]')
    old.prepare("update recaps set overtime = 1, wp_series = ? where game_id = 'OT1'").run('[[0,0.5],[3180,1]]')
    old.exec('pragma user_version = 4')
    old.close()
    const db = openDb(path)
    const ot = (id: string) => (db.prepare('select overtime from recaps where game_id = ?').get(id) as { overtime: number }).overtime
    assert.equal(ot('OT2'), 2)
    assert.equal(ot('OT1'), 1)
    assert.equal(revealGame(db, 'OT2')!.overtimes, 2)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('NBA ratings personalize NBA weights and leave the NFL set alone', () => {
  const db = openDb(':memory:')
  // Deterministic pseudo-random percentiles.
  let seed = 11
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const games: NbaGame[] = []
  const scores: ReturnType<typeof scoreGames<NbaSignal>> = []
  const add = (id: string, season: number, night: string, pct: Record<NbaSignal, number>) => {
    games.push(game({ game_id: id, season, night, tipoff: `${night}T23:30Z`, completed: true, home_score: 100, away_score: 90 }))
    scores.push({ game_id: id, model_version: NBA_MODEL.version, total: 50, stars: 3, tier: 'Worth it', raw: { ...pct, big_moment: false }, pct })
  }
  const randomPct = () => Object.fromEntries(SIGNALS.map((s) => [s, rand()])) as Record<NbaSignal, number>
  // 20 reference weeks of 50 games each.
  for (let i = 0; i < 1000; i++) {
    const day = new Date(Date.UTC(2025, 10, 3) + Math.floor(i / 7) * 86_400_000).toISOString().slice(0, 10)
    add(`REF_${i}`, 2025, day, randomPct())
  }
  // A rater who only cares about highlight plays and stars.
  const ratings = Array.from({ length: 40 }, () => randomPct())
  ratings.forEach((pct, i) => add(`RATED_${i}`, 2026, '2026-10-21', pct))
  upsertNbaGames(db, games, new Map())
  upsertScores(db, scores, '2026-10-22T00:00:00Z')
  ratings.forEach((pct, i) => {
    const stars = Math.min(5, Math.max(1, Math.round(1 + 4 * (0.6 * pct.highlight_plays + 0.4 * pct.star))))
    upsertRating(db, `RATED_${i}`, stars, new Date(Date.UTC(2026, 9, 22) + i * 3_600_000).toISOString(), NBA_MODEL.version)
  })
  const nflSet = { ...DEFAULT_MODEL, version: `${DEFAULT_MODEL.version}+w1`, ratingsUsed: 20, fittedShare: 0.5, createdAt: '2026-10-01T00:00:00Z' }
  activateWeightSet(db, nflSet, null)

  const result = refitWeights(db, new Date('2026-10-24T00:00:00Z'), { referenceSeasons: [2025], league: NBA_REFIT })
  assert.equal(result.status, 'adopted')
  const active = activeWeightSet(db, NBA_MODEL)
  assert.equal(active.version, 'nba-v0.1+w1')
  assert.ok(active.weights.highlight_plays > WEIGHTS.highlight_plays && active.weights.star > WEIGHTS.star)
  assert.ok(active.weights.late_closeness < WEIGHTS.late_closeness)
  // Must watch keeps about 2.5 regular-season games a week under the new weights.
  const must = active.cutoffs[0][0]
  const refScores = scores.filter((s) => s.game_id.startsWith('REF_')).map((s) => 100 * SIGNALS.reduce((a, k) => a + active.weights[k] * s.pct[k], 0))
  const perWeek = refScores.filter((x) => x >= must).length / (1000 / 7 / 7)
  assert.ok(perWeek > 2.2 && perWeek < 2.8, `${perWeek} per week`)
  assert.equal(activeWeightSet(db, DEFAULT_MODEL).version, nflSet.version, 'the NFL set stays active')
  // The NFL refit is a separate schedule and sees no NFL ratings.
  assert.equal(refitWeights(db, new Date('2026-10-24T00:00:00Z'), { referenceSeasons: [2025] }).status, 'skipped')

  upsertScores(db, scoreGames(new Map(scores.map((s) => [s.game_id, s.raw])), scores.map((s) => s.raw), active), '2026-10-24T00:00:00Z')
  const nights = listNights(db, 2026, new Date('2026-10-24T00:00:00Z'))
  assert.equal(nights.model.personalized, true)
  assert.equal(nights.model.ratingsUsed, 40)
  assert.equal(listNbaGames(db, '2026-10-21', new Date('2026-10-24T00:00:00Z'))!.games.filter((g) => g.state === 'ranked').length, 40)
})
