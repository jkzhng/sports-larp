import type { Play } from '../types.ts'
import {
  BIG_MOMENT_SECONDS,
  CLOSE_MARGIN,
  EXPLOSIVE_PASS_YDS,
  EXPLOSIVE_RUN_YDS,
  GARBAGE_FACTOR,
  GARBAGE_SECONDS,
  GARBAGE_WP,
  LEAD_CHANGE_BONUS_MIN,
  LONG_TD_YDS,
} from './model.ts'

export interface GameSignals {
  excitement: number
  late_closeness: number
  comeback: number
  explosive: number
  touchdowns: number
  turnovers: number
  big_moment: boolean
  lead_changes_late: number
  home_score: number
  away_score: number
}

const is1 = (v: number | null) => v === 1
const num = (v: number | null) => v ?? 0
const late = (p: Play) => p.qtr !== null && p.qtr >= 4

// Plays after the game is decided: final 5 minutes, leader's WP above 99%.
function isGarbage(p: Play): boolean {
  if (p.home_wp === null || p.game_seconds_remaining === null) return false
  const leaderWp = Math.max(p.home_wp, 1 - p.home_wp)
  return p.qtr === 4 && p.game_seconds_remaining <= GARBAGE_SECONDS && leaderWp > GARBAGE_WP
}

/** Raw signal values for one game. `plays` must be in published order (by seq). */
export function gameSignals(plays: Play[]): GameSignals {
  const n = plays.length
  const weight = plays.map((p) => (isGarbage(p) ? GARBAGE_FACTOR : 1))
  const real = plays.map((p) => p.play_type !== null && p.play_type !== 'no_play')

  // Running score, carried forward over rows that omit it.
  const diff: number[] = []
  let home = 0
  let away = 0
  for (const p of plays) {
    if (p.total_home_score !== null) home = p.total_home_score
    if (p.total_away_score !== null) away = p.total_away_score
    diff.push(home - away)
  }
  const finalDiff = diff[n - 1] ?? 0

  // Drama ---------------------------------------------------------------
  let excitement = 0
  for (const p of plays) excitement += Math.abs(num(p.wpa))

  // Clock seconds after each Q4/OT play until the next play in the same quarter.
  let closeSeconds = 0
  for (let i = 0; i < n - 1; i++) {
    const p = plays[i]
    const next = plays[i + 1]
    if (!late(p) || Math.abs(diff[i]) > CLOSE_MARGIN) continue
    if (p.qtr !== next.qtr || p.game_seconds_remaining === null || next.game_seconds_remaining === null) continue
    closeSeconds += Math.max(0, p.game_seconds_remaining - next.game_seconds_remaining)
  }

  // Lead changes in Q4/OT, counting from whoever led last before Q4.
  let leader = 0
  let leadChanges = 0
  for (let i = 0; i < n; i++) {
    const s = Math.sign(diff[i])
    if (s === 0) continue
    if (late(plays[i]) && leader !== 0 && s !== leader) leadChanges++
    leader = s
  }
  const lateCloseness = closeSeconds / 60 + LEAD_CHANGE_BONUS_MIN * leadChanges

  // Spread-adjusted WP, so beating the odds counts: a 10-point underdog starts
  // near 13%, not 50%, and a wire-to-wire upset still scores as a big comeback.
  const vegas = plays.map((p) => p.vegas_home_wp).filter((v): v is number => v !== null)
  let comeback = 0
  if (vegas.length > 0) {
    const minHome = Math.min(...vegas)
    const minAway = Math.min(...vegas.map((v) => 1 - v))
    if (finalDiff > 0) comeback = 1 - minHome
    else if (finalDiff < 0) comeback = 1 - minAway
    else comeback = 1 - Math.min(minHome, minAway) // tie: whichever side came back further
  }

  // Action --------------------------------------------------------------
  let explosive = 0
  let touchdowns = 0
  let turnovers = 0
  const td: boolean[] = []
  for (let i = 0; i < n; i++) {
    const p = plays[i]
    const yds = num(p.yards_gained)
    const isPass = p.play_type === 'pass' && num(p.sack) === 0
    const isRun = p.play_type === 'run'
    const isTd = real[i] && is1(p.touchdown)
    td.push(isTd)
    if ((isPass && yds >= EXPLOSIVE_PASS_YDS) || (isRun && yds >= EXPLOSIVE_RUN_YDS)) explosive += weight[i]
    if (isTd && (isPass || isRun) && yds >= LONG_TD_YDS) explosive += weight[i]
    if (isTd) touchdowns += weight[i]
    if (real[i] && (is1(p.interception) || is1(p.fumble_lost) || is1(p.fourth_down_failed))) {
      turnovers += weight[i] * Math.abs(num(p.wpa))
    }
  }

  return {
    excitement,
    late_closeness: lateCloseness,
    comeback,
    explosive,
    touchdowns,
    turnovers,
    big_moment: bigMoment(plays, diff, td),
    lead_changes_late: leadChanges,
    home_score: home,
    away_score: away,
  }
}

function bigMoment(plays: Play[], diff: number[], td: boolean[]): boolean {
  // Defensive or special-teams touchdown in Q4/OT. A missing team counts as a
  // mismatch, as it does in the pandas version.
  const nonOffenseTd = plays.some(
    (p, i) =>
      td[i] &&
      late(p) &&
      (p.td_team === null || p.posteam === null || p.td_team !== p.posteam || is1(p.special_teams_play)),
  )
  if (nonOffenseTd) return true

  const finalSign = Math.sign(diff[diff.length - 1] ?? 0)
  if (finalSign === 0) return false
  // The play that put the winner ahead for good.
  let lastNotWinning = -1
  for (let i = 0; i < diff.length; i++) if (Math.sign(diff[i]) !== finalSign) lastNotWinning = i
  if (lastNotWinning === -1 || lastNotWinning + 1 >= plays.length) return false // led wire to wire
  const goAhead = plays[lastNotWinning + 1]
  if (goAhead.qtr === null) return false
  if (goAhead.qtr >= 5) return true
  return goAhead.qtr === 4 && goAhead.game_seconds_remaining !== null && goAhead.game_seconds_remaining <= BIG_MOMENT_SECONDS
}
