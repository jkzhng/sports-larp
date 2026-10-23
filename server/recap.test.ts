import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRecap, cleanDescription, elapsedSeconds, playerName } from './recap.ts'
import { play } from './testing/fixtures.ts'

const game = { game_type: 'REG', home_team: 'HOM', away_team: 'AWY' }

const pass = (o: Parameters<typeof play>[0]) =>
  play({ play_type: 'pass', pass_attempt: 1, passer_player_name: 'J.Allen', ...o })

test('cleans nflverse play text for display', () => {
  assert.equal(
    cleanDescription('(1:52) (Shotgun) 17-J.Allen pass deep left to 10-K.Shakir for 34 yards, TOUCHDOWN.'),
    'J. Allen pass deep left to K. Shakir for 34 yards, TOUCHDOWN.',
  )
  assert.equal(cleanDescription('(9:23) 28-J.Taylor right guard to 50 for 8 yards (25-M.Bryant).'), 'J. Taylor right guard to 50 for 8 yards.')
  assert.equal(
    cleanDescription('(:19) 88-J.Hudson and 70-N.Harris reported in as eligible.  27-K.Hunt up the middle for 1 yard, TOUCHDOWN.'),
    'K. Hunt up the middle for 1 yard, TOUCHDOWN.',
  )
  assert.equal(
    cleanDescription('(:25) 14-S.Darnold pass short left to 11-J.Smith-Njigba for 14 yards, TOUCHDOWN [91-J.Verse].'),
    'S. Darnold pass short left to J. Smith-Njigba for 14 yards, TOUCHDOWN.',
  )
  assert.equal(playerName('A.St. Brown'), 'A. St. Brown')
})

test('elapsed time runs through regulation into overtime', () => {
  assert.equal(elapsedSeconds(play({ qtr: 1, quarter_seconds_remaining: 900 }), 'REG'), 0)
  assert.equal(elapsedSeconds(play({ qtr: 4, quarter_seconds_remaining: 0 }), 'REG'), 3600)
  assert.equal(elapsedSeconds(play({ qtr: 5, quarter_seconds_remaining: 300 }), 'REG'), 3900) // 10-minute OT
  assert.equal(elapsedSeconds(play({ qtr: 5, quarter_seconds_remaining: 300 }), 'DIV'), 4200) // 15-minute OT
})

test('key moments are the biggest WP swings, in game order', () => {
  const plays = [
    play({ qtr: 1, quarter_seconds_remaining: 800, vegas_home_wp: 0.5, desc: '(13:20) small gain' }),
    play({ qtr: 2, quarter_seconds_remaining: 500, vegas_home_wp: 0.52, desc: '(8:20) interception' }),
    play({ qtr: 3, quarter_seconds_remaining: 400, vegas_home_wp: 0.3, desc: '(6:40) touchdown' }),
    play({ qtr: 4, quarter_seconds_remaining: 60, vegas_home_wp: 0.6, desc: '(1:00) field goal' }),
    play({ qtr: 4, quarter_seconds_remaining: 0, vegas_home_wp: 0.98, desc: 'END GAME', play_type: null }),
  ]
  const r = buildRecap(plays, game)
  // The 0.02 swing is below the 0.08 floor and the top three are already filled.
  assert.deepEqual(r.keyMoments.map((m) => [m.qtr, m.clock, m.swing]), [
    [2, '8:20', -0.22],
    [3, '6:40', 0.3],
    [4, '1:00', 0.38],
  ])
  assert.equal(r.overtime, 0)
  assert.deepEqual(r.wp.at(0), [100, 0.5])
  assert.deepEqual(r.wp.at(-1), [3600, 0.98])
})

test('talking points: passing, rushing and receiving leaders, then a standout team stat', () => {
  const plays = [
    pass({ complete_pass: 1, passing_yards: 40, receiver_player_name: 'K.Shakir', receiving_yards: 40, yards_gained: 40, pass_touchdown: 1, touchdown: 1 }),
    pass({ complete_pass: 0 }),
    pass({ sack: 1 }), // sacks are not attempts
    play({ play_type: 'run', rush_attempt: 1, rusher_player_name: 'J.Cook', rushing_yards: 12, yards_gained: 12 }),
    play({ play_type: 'run', rush_attempt: 1, rusher_player_name: 'J.Cook', rushing_yards: 5, yards_gained: 5 }),
    // Away team throws two interceptions.
    pass({ posteam: 'AWY', defteam: 'HOM', passer_player_name: 'M.Stafford', interception: 1, interception_player_name: 'T.Bernard' }),
    pass({ posteam: 'AWY', defteam: 'HOM', passer_player_name: 'M.Stafford', interception: 1, interception_player_name: 'T.Bernard' }),
  ]
  assert.deepEqual(buildRecap(plays, game).talkingPoints, [
    'J. Allen (HOM) threw for 40 yards and 1 TD (1/2).',
    'J. Cook (HOM) ran for 17 yards on 2 carries.',
    'K. Shakir (HOM) caught 1 pass for 40 yards and 1 TD.',
    'HOM won the turnover battle 2-0.',
  ])
})

test('without a standout stat, the fourth point is the biggest play', () => {
  const plays = [
    pass({ qtr: 4, quarter_seconds_remaining: 112, vegas_home_wp: 0.4, complete_pass: 1, passing_yards: 34, receiver_player_name: 'K.Shakir', receiving_yards: 34, yards_gained: 34, touchdown: 1, pass_touchdown: 1, desc: 'td' }),
    play({ qtr: 4, quarter_seconds_remaining: 0, vegas_home_wp: 0.95, play_type: null }),
  ]
  assert.equal(buildRecap(plays, game).talkingPoints.at(-1), 'Q4 1:52: J. Allen 34-yard pass to K. Shakir for a touchdown.')
})
