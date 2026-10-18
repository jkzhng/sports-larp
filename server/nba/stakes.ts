// Pre-game NBA stakes. A port of _win_pct_entering and stakes in
// notebooks/nba_watchability.py.
import type { NbaGame } from '../sources/espn.ts'
import { MARQUEE_MIN_WIN_PCT, MIN_GAMES_FOR_PCT, NATIONAL_TV, RACE_MIN_GAMES, RACE_MIN_WIN_PCT, STAKES_POINTS } from './model.ts'

export interface NbaStakes {
  stakes: number
  playoff: boolean
  playIn: boolean
  cupKnockout: boolean
  national: boolean
  marquee: boolean
  race: boolean
}

interface Record {
  pct: number
  played: number
}

/**
 * Each team's regular-season record entering each game. Upcoming games use
 * every result before them too, so their tags match what the game gets once
 * it's final.
 */
function recordsEntering(schedule: NbaGame[]): Map<string, Record> {
  const tally = new Map<string, { wins: number; played: number }>()
  const out = new Map<string, Record>()
  for (const g of schedule) {
    for (const team of [g.home_team, g.away_team]) {
      const t = tally.get(`${g.season}|${team}`) ?? { wins: 0, played: 0 }
      out.set(`${g.game_id}|${team}`, { pct: t.played === 0 ? 0.5 : t.wins / t.played, played: t.played })
    }
    if (!g.completed || g.season_type !== 'REG' || g.home_score === null || g.away_score === null) continue
    for (const [team, won] of [
      [g.home_team, g.home_score > g.away_score],
      [g.away_team, g.away_score > g.home_score],
    ] as const) {
      const key = `${g.season}|${team}`
      const t = tally.get(key) ?? { wins: 0, played: 0 }
      tally.set(key, { wins: t.wins + +won, played: t.played + 1 })
    }
  }
  return out
}

/** Stakes for every game; `schedule` must be sorted by tipoff. */
export function computeNbaStakes(schedule: NbaGame[]): Map<string, NbaStakes> {
  const records = recordsEntering(schedule)
  const out = new Map<string, NbaStakes>()
  for (const g of schedule) {
    const home = records.get(`${g.game_id}|${g.home_team}`)!
    const away = records.get(`${g.game_id}|${g.away_team}`)!
    const reg = g.season_type === 'REG'
    const played = Math.min(home.played, away.played)
    const national = g.national_tv.some((n) => NATIONAL_TV.has(n))
    const marquee = reg && played >= MIN_GAMES_FOR_PCT && home.pct >= MARQUEE_MIN_WIN_PCT && away.pct >= MARQUEE_MIN_WIN_PCT
    const race = reg && played >= RACE_MIN_GAMES && home.pct >= RACE_MIN_WIN_PCT && away.pct >= RACE_MIN_WIN_PCT
    // 2023-24 called the Cup the "In-Season Tournament".
    const cupKnockout = /NBA Cup|In-Season Tournament/.test(g.notes) && !g.notes.includes('Group Play')
    let stakes: number
    if (g.season_type === 'POST') stakes = g.notes.includes('NBA Finals') || g.notes.includes('Game 7') ? 1.2 : 1.0
    else if (g.season_type === 'PLAYIN') stakes = 0.8
    else if (cupKnockout) stakes = g.comp_type === 'CC' ? 1.0 : 0.8
    else stakes = STAKES_POINTS.national_tv * +national + STAKES_POINTS.marquee * +marquee + STAKES_POINTS.race * +race
    out.set(g.game_id, { stakes, playoff: g.season_type === 'POST', playIn: g.season_type === 'PLAYIN', cupKnockout, national, marquee, race })
  }
  return out
}
