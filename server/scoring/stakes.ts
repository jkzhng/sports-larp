import type { ScheduleGame } from '../types.ts'
import { RACE_FROM_WEEK, RACE_MIN_WIN_PCT, STAKES_POINTS } from './model.ts'

export interface Stakes {
  stakes: number
  playoff: boolean
  division: boolean
  primetime: boolean
  race: boolean
}

/** Pre-game stakes for every game. Uses only information known before kickoff. */
export function computeStakes(schedule: ScheduleGame[]): Map<string, Stakes> {
  const pct = winPctEntering(schedule)
  const out = new Map<string, Stakes>()
  for (const g of schedule) {
    const regular = g.game_type === 'REG'
    const hour = Number(g.gametime.slice(0, 2))
    const primetime = regular && (hour >= 19 || g.weekday !== 'Sunday')
    const division = g.div_game === 1
    const homePct = pct.get(`${g.game_id}|${g.home_team}`)
    const awayPct = pct.get(`${g.game_id}|${g.away_team}`)
    const race =
      regular &&
      g.week >= RACE_FROM_WEEK &&
      homePct !== undefined &&
      awayPct !== undefined &&
      homePct >= RACE_MIN_WIN_PCT &&
      awayPct >= RACE_MIN_WIN_PCT
    const stakes = regular
      ? STAKES_POINTS.division * +division + STAKES_POINTS.primetime * +primetime + STAKES_POINTS.race * +race
      : g.game_type === 'SB'
        ? 1.2
        : 1.0
    out.set(g.game_id, { stakes, playoff: !regular, division, primetime, race })
  }
  return out
}

/** Each team's win percentage entering each finished game, within its season (ties = half). */
function winPctEntering(schedule: ScheduleGame[]): Map<string, number> {
  const done = schedule
    .filter((g) => g.result !== null)
    .sort((a, b) => a.season - b.season || a.gameday.localeCompare(b.gameday) || a.gametime.localeCompare(b.gametime))
  const record = new Map<string, { wins: number; played: number }>()
  const out = new Map<string, number>()
  for (const g of done) {
    const result = g.result ?? 0
    for (const [team, sign] of [
      [g.home_team, 1],
      [g.away_team, -1],
    ] as const) {
      const key = `${g.season}|${team}`
      const r = record.get(key) ?? { wins: 0, played: 0 }
      out.set(`${g.game_id}|${team}`, r.played === 0 ? 0.5 : r.wins / r.played)
      r.wins += result * sign > 0 ? 1 : result === 0 ? 0.5 : 0
      r.played++
      record.set(key, r)
    }
  }
  return out
}
