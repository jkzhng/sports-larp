import assert from 'node:assert/strict'
import { test } from 'node:test'
import { play } from '../testing/fixtures.ts'
import { percentile, scoreGames, tier, type RawSignals } from './score.ts'
import { gameSignals } from './signals.ts'

test('counts explosive plays, long touchdowns twice, and discounts garbage time', () => {
  const s = gameSignals([
    play({ play_type: 'pass', yards_gained: 25 }),
    play({ play_type: 'pass', yards_gained: 30, sack: 1 }), // sack never counts
    play({ play_type: 'run', yards_gained: 45, touchdown: 1, td_team: 'HOM', total_home_score: 7 }),
    play({ play_type: 'no_play', yards_gained: 50, touchdown: 1 }), // nullified
    // Final 5 minutes, leader above 99%: counts half.
    play({ qtr: 4, game_seconds_remaining: 120, home_wp: 0.995, play_type: 'run', yards_gained: 20, total_home_score: 7 }),
  ])
  assert.equal(s.explosive, 1 + 2 + 0.5)
  assert.equal(s.touchdowns, 1)
})

test('late closeness counts close Q4 minutes plus lead changes', () => {
  const s = gameSignals([
    play({ qtr: 3, game_seconds_remaining: 1000, total_home_score: 3 }),
    play({ qtr: 4, game_seconds_remaining: 900, total_home_score: 3 }),
    play({ qtr: 4, game_seconds_remaining: 600, total_home_score: 3, total_away_score: 7 }), // away takes lead
    play({ qtr: 4, game_seconds_remaining: 300, total_home_score: 10, total_away_score: 7 }), // home retakes it
    play({ qtr: 4, game_seconds_remaining: 0, total_home_score: 10, total_away_score: 7 }),
  ])
  assert.equal(s.lead_changes_late, 2)
  assert.equal(s.late_closeness, 15 + 2 * 5) // 900 seconds within 8 points, plus 2 lead changes
  assert.equal(s.big_moment, false) // go-ahead score came with 5:00 left
})

test('comeback uses spread-adjusted WP of the eventual winner', () => {
  const s = gameSignals([
    play({ vegas_home_wp: 0.2 }), // home is a big underdog
    play({ vegas_home_wp: 0.1 }),
    play({ vegas_home_wp: 0.9, total_home_score: 21, total_away_score: 3 }),
  ])
  assert.ok(Math.abs(s.comeback - 0.9) < 1e-12)
})

test('a go-ahead score in the final 2:00 or OT is a big moment', () => {
  const s = gameSignals([
    play({ qtr: 4, game_seconds_remaining: 200, total_away_score: 3 }),
    play({ qtr: 4, game_seconds_remaining: 90, total_home_score: 7, total_away_score: 3 }),
  ])
  assert.equal(s.big_moment, true)
})

test('percentile is mid-rank and tiers follow the cutoffs', () => {
  const ref = Float64Array.from([1, 2, 2, 3])
  assert.equal(percentile(ref, 2), 0.5)
  assert.equal(percentile(ref, 0), 0)
  assert.equal(percentile(ref, 9), 1)
  assert.equal(tier(67), 'Must watch')
  assert.equal(tier(66.9), 'Worth it')
  assert.equal(tier(44.9), 'Skippable')
})

test('a game at the top of every signal scores 100 and five stars', () => {
  const low: RawSignals = { excitement: 0, late_closeness: 0, comeback: 0, explosive: 0, touchdowns: 0, turnovers: 0, stakes: 0, big_moment: false }
  const high: RawSignals = { excitement: 9, late_closeness: 9, comeback: 9, explosive: 9, touchdowns: 9, turnovers: 9, stakes: 9, big_moment: true }
  const [s] = scoreGames(new Map([['G', high]]), [low, low])
  assert.equal(s.total, 100)
  assert.equal(s.stars, 5)
})
