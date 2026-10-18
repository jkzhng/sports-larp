import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchHighlights, parseHighlightTitle, type HighlightCandidateGame, type Upload } from './highlights.ts'
import { teamFromName } from './teams.ts'

// Real titles from the NFL channel, 2026 weeks 5 and 6, including its typos and
// inconsistent season/week phrasing.
const WEEK5_TITLES: [string, string, string][] = [
  ['BUF', 'LA', 'Buffalo Bills vs Los Angeles Rams Game Highlights | 2026 NFL Season Week 5'],
  ['SF', 'SEA', 'San Francisco 49ers vs Seattle Seahawks Game Highlights | 2026 NFL Season Week 5'],
  ['LV', 'NE', 'Las Vegas Raiders vs. New England Patriots Game Highlights | 2026 NFL Season Week 5'],
  ['CLE', 'NYJ', 'Cleveland Browns vs New York Jets Game Highlights | 2026 NFL Season Week 5'],
  ['IND', 'PIT', 'Indianapolis Colts vs. Pittsburgh Steelers Game Highlights | 2026 NFL Season Week 5'],
  ['CHI', 'GB', 'Chicago Bears vs. Green Bay Packers Game Highlights | NFL 2026 Season Week 5'],
  ['MIN', 'NO', 'Minnesota Vikings vs New Orleans Saint Game Highlights | NFL 2026 Season Week 5'],
  ['DEN', 'LAC', 'Denver Broncos vs. Los Angeles Chargers Game Highlights | NFL 2026 Season Week 5'],
  ['HOU', 'TEN', 'Houston Texans vs. Tennessee Titans Game Highlights | NFL 2026 Season Week 5'],
  ['DET', 'ARI', 'Detroit Lions vs. Arizona Cardinals Game Highlights | NFL 2026 Week 5'],
  ['NYG', 'WAS', 'New York Giants vs Washington Commanders Game Highlights | 2026 NFL Season Week 5'],
  ['CIN', 'MIA', 'Cincinnati Bengals vs Miami Dolphins Game Highlights | 2026 NFL Season Week 5'],
  ['PHI', 'JAX', 'Philadelphia Eagles vs. Jacksonville Jaguars Game Highlights | 2026 NFL Season Week 5'],
  ['BAL', 'ATL', 'Baltimore Ravens vs Atlanta Falcons Game Highlights | 2026 NFL Season Week 5'],
  ['TB', 'DAL', 'Tampa Bay Buccaneers vs Dallas Cowboys Game Highlights | 2026 NFL Season Week 5'],
]

const NOT_GAME_HIGHLIGHTS = [
  'Best Plays From Sunday! | 2026 NFL Season Week 5',
  'Every Single Game Recap from Sunday Afternoon | NFL Season Week 5',
  'Top 15 Plays of Week 5! | 2026 NFL Season',
  "Drake Maye's best plays from 5-TD game vs. Raiders | Week 5",
  'Best Play From EVERY Team in Week 5 | 2026 NFL Season',
  'The NFL Report: Time to Panic for Seahawks? + Eagles Hire QB Joe Milton III',
]

test('parses every week 5 game highlight title, typos included', () => {
  for (const [away, home, title] of WEEK5_TITLES) {
    const p = parseHighlightTitle(title)
    assert.deepEqual(p, { teams: [away, home], season: 2026, week: 5 }, title)
  }
})

test('ignores recaps, top-play lists and player clips', () => {
  for (const title of NOT_GAME_HIGHLIGHTS) assert.equal(parseHighlightTitle(title), null, title)
})

test('team names resolve by nickname, one typo, or a unique city', () => {
  assert.equal(teamFromName('New Orleans Saint'), 'NO')
  assert.equal(teamFromName('49ers'), 'SF')
  assert.equal(teamFromName('Washington'), 'WAS')
  assert.equal(teamFromName('New York'), null) // Giants or Jets
  assert.equal(teamFromName('Los Angeles'), null) // Rams or Chargers
})

const game = (id: string, away: string, home: string, kickoff: string, week = 5): HighlightCandidateGame => ({
  id, season: 2026, game_type: 'REG', week, away_team: away, home_team: home, kickoff_at: kickoff,
})
const upload = (videoId: string, title: string, publishedAt: string): Upload => ({
  videoId, channelId: 'UCDVYQ4Zhbm3S2dlz7P1GBDg', title, publishedAt,
})

test('matches each game to its own highlight upload', () => {
  const games = WEEK5_TITLES.map(([away, home]) => game(`2026_05_${away}_${home}`, away, home, '2026-10-11T17:00:00Z'))
  const uploads = WEEK5_TITLES.map(([away, home, title]) => upload(`v_${away}_${home}`, title, '2026-10-11T21:30:00Z'))
  const matches = matchHighlights(games, [...uploads, ...NOT_GAME_HIGHLIGHTS.map((t, i) => upload(`x${i}`, t, '2026-10-11T22:00:00Z'))])
  assert.equal(matches.size, 15)
  for (const [away, home] of WEEK5_TITLES) assert.equal(matches.get(`2026_05_${away}_${home}`)?.videoId, `v_${away}_${home}`)
})

test('rejects uploads before kickoff, too long after, or from another week or season', () => {
  const g = game('2026_06_SEA_DEN', 'SEA', 'DEN', '2026-10-16T00:15:00Z', 6)
  const title = 'Seattle Seahawks vs Denver Broncos Game Highlights | 2026 NFL Season Week 6'
  assert.equal(matchHighlights([g], [upload('early', title, '2026-10-15T23:00:00Z')]).size, 0)
  assert.equal(matchHighlights([g], [upload('late', title, '2026-10-21T00:00:00Z')]).size, 0)
  assert.equal(matchHighlights([g], [upload('wk', title.replace('Week 6', 'Week 2'), '2026-10-16T04:00:00Z')]).size, 0)
  assert.equal(matchHighlights([g], [upload('yr', title.replace('2026', '2025'), '2026-10-16T04:00:00Z')]).size, 0)
  // Earliest qualifying upload wins over a later re-upload.
  const m = matchHighlights([g], [upload('reup', title, '2026-10-16T09:00:00Z'), upload('first', title, '2026-10-16T04:00:00Z')])
  assert.equal(m.get(g.id)?.videoId, 'first')
})
