// NBA signals for one game, from an ESPN summary. A port of plays_frame,
// box_players, game_signals and _big_moment in notebooks/nba_watchability.py.
import type { Summary } from '../sources/espn.ts'
import {
  BIG_MOMENT_SECONDS,
  CLOSE_MARGIN,
  DEEP_THREE_FT,
  GARBAGE_FACTOR,
  GARBAGE_SECONDS,
  GARBAGE_WP,
  LEAD_CHANGE_BONUS_MIN,
  REGULATION_PERIOD,
  SIGNAL_DECIMALS,
  TRIPLE_DOUBLE_BONUS,
  TYING_BUZZER_SECONDS,
} from './model.ts'

export interface NbaPlay {
  id: string
  period: number
  clock: number // seconds left in the period
  type: string
  text: string
  homeScore: number
  awayScore: number
  scoring: boolean
  scoreValue: number
  shooting: boolean
  isHome: boolean
  homeWp: number | null // after this play, carried forward over plays without one
}

export interface BoxPlayer {
  name: string
  team: string
  PTS: number
  REB: number
  AST: number
  STL: number
  BLK: number
}

export interface NbaGameSignals {
  excitement: number
  late_closeness: number
  comeback: number
  highlight_plays: number
  scoring: number
  star: number
  big_moment: boolean
  lead_changes: number
  lead_changes_late: number
  overtime: boolean
  home_score: number
  away_score: number
}

export function clockSeconds(display: string): number {
  if (display.includes(':')) {
    const [m, s] = display.split(':')
    return Number(m) * 60 + Number(s)
  }
  return Number(display)
}

/** Seconds left in regulation (Q1-Q4) or in the current overtime. */
export const secondsLeft = (p: NbaPlay) => (p.period <= 4 ? (4 - p.period) * REGULATION_PERIOD + p.clock : p.clock)

export function nbaPlays(summary: Summary): NbaPlay[] {
  const homeId = summary.header.competitions[0].competitors.find((t) => t.homeAway === 'home')?.team.id
  const wp = new Map((summary.winprobability ?? []).map((w) => [w.playId, w.homeWinPercentage]))
  let lastWp: number | null = null
  return (summary.plays ?? []).map((p) => {
    lastWp = wp.get(p.id) ?? lastWp
    return {
      id: p.id,
      period: p.period.number,
      clock: clockSeconds(p.clock.displayValue),
      type: p.type.text,
      text: p.text ?? '',
      homeScore: p.homeScore,
      awayScore: p.awayScore,
      scoring: Boolean(p.scoringPlay),
      scoreValue: p.scoreValue ?? 0,
      shooting: Boolean(p.shootingPlay),
      isHome: p.team?.id === homeId,
      homeWp: lastWp,
    }
  })
}

const STAT_KEYS = ['PTS', 'REB', 'AST', 'STL', 'BLK'] as const

export function boxPlayers(summary: Summary): BoxPlayer[] {
  const out: BoxPlayer[] = []
  for (const team of summary.boxscore?.players ?? []) {
    const { labels, athletes } = team.statistics[0]
    for (const a of athletes) {
      if (!a.stats || a.stats.length === 0) continue
      const s = Object.fromEntries(labels.map((l, i) => [l, a.stats[i]]))
      const stat = (k: string) => (/^\d+$/.test(s[k] ?? '') ? Number(s[k]) : 0)
      out.push({
        name: a.athlete?.displayName || a.athlete?.shortName || '',
        team: team.team.abbreviation,
        PTS: stat('PTS'),
        REB: stat('REB'),
        AST: stat('AST'),
        STL: stat('STL'),
        BLK: stat('BLK'),
      })
    }
  }
  return out
}

export const isTripleDouble = (b: BoxPlayer) => STAT_KEYS.filter((k) => b[k] >= 10).length >= 3

// Plays after the game is decided: final 5 minutes of Q4, leader's WP above 99%.
function isGarbage(p: NbaPlay): boolean {
  if (p.homeWp === null) return false
  return p.period === 4 && p.clock <= GARBAGE_SECONDS && Math.max(p.homeWp, 1 - p.homeWp) > GARBAGE_WP
}

const FOOT = /(\d+)-foot/

const round = (x: number) => Math.round(x * 10 ** SIGNAL_DECIMALS) / 10 ** SIGNAL_DECIMALS

/** Raw signal values for one game, or null without plays or win probability. */
export function nbaGameSignals(summary: Summary): NbaGameSignals | null {
  const plays = nbaPlays(summary)
  if (plays.length === 0 || plays.every((p) => p.homeWp === null)) return null
  const n = plays.length
  const diff = plays.map((p) => p.homeScore - p.awayScore)
  const finalDiff = diff[n - 1]
  const late = (p: NbaPlay) => p.period >= 4

  // Drama ---------------------------------------------------------------
  const wps = plays.map((p) => p.homeWp).filter((v): v is number => v !== null)
  let excitement = 0
  for (let i = 1; i < wps.length; i++) excitement += Math.abs(wps[i] - wps[i - 1])

  let closeSeconds = 0
  for (let i = 0; i < n - 1; i++) {
    const p = plays[i]
    const next = plays[i + 1]
    if (!late(p) || Math.abs(diff[i]) > CLOSE_MARGIN || p.period !== next.period) continue
    closeSeconds += Math.max(0, p.clock - next.clock)
  }

  // Lead changes in Q4/OT counting from whoever led last before Q4, and overall.
  let leader = 0
  let leadChangesLate = 0
  let leadChanges = 0
  for (let i = 0; i < n; i++) {
    const s = Math.sign(diff[i])
    if (s === 0) continue
    if (leader !== 0 && s !== leader) {
      leadChanges++
      if (late(plays[i])) leadChangesLate++
    }
    leader = s
  }
  const lateCloseness = closeSeconds / 60 + LEAD_CHANGE_BONUS_MIN * leadChangesLate

  // ESPN's WP starts from a pregame prior, so a wire-to-wire upset still counts.
  const comeback = finalDiff > 0 ? 1 - Math.min(...wps) : 1 - Math.min(...wps.map((w) => 1 - w))

  // Action --------------------------------------------------------------
  let highlightPlays = 0
  for (const p of plays) {
    const made = p.scoring && p.shooting && !p.type.startsWith('Free Throw')
    const feet = FOOT.exec(p.text)
    const dunk = made && p.type.includes('Dunk')
    const alleyOop = made && p.type.includes('Alley Oop') && !dunk
    const deepThree = made && p.scoreValue === 3 && feet !== null && Number(feet[1]) >= DEEP_THREE_FT
    const block = p.text.includes(' blocks ')
    const andOne = p.type === 'Free Throw - 1 of 1'
    if (dunk || alleyOop || deepThree || block || andOne) highlightPlays += isGarbage(p) ? GARBAGE_FACTOR : 1
  }

  const last = plays[n - 1]
  const box = boxPlayers(summary)
  const star = box.length === 0 ? 0 : Math.max(...box.map((b) => b.PTS + TRIPLE_DOUBLE_BONUS * +isTripleDouble(b)))

  // Rounded as in the notebook: pandas adds floats in a different order, and
  // unrounded sums would break ties differently.
  return {
    excitement: round(excitement),
    late_closeness: round(lateCloseness),
    comeback: round(comeback),
    highlight_plays: highlightPlays,
    scoring: last.homeScore + last.awayScore,
    star,
    big_moment: bigMoment(plays, diff),
    lead_changes: leadChanges,
    lead_changes_late: leadChangesLate,
    overtime: plays.some((p) => p.period > 4),
    home_score: last.homeScore,
    away_score: last.awayScore,
  }
}

/** Go-ahead-for-good shot in the final 24 s, or a buzzer shot that forces OT. */
function bigMoment(plays: NbaPlay[], diff: number[]): boolean {
  const tyingBuzzer = plays.some(
    (p, i) =>
      p.period >= 4 &&
      p.scoring &&
      Math.sign(diff[i]) === 0 &&
      (i === 0 ? 0 : Math.sign(diff[i - 1])) !== 0 &&
      p.clock <= TYING_BUZZER_SECONDS,
  )
  if (tyingBuzzer) return true

  const finalSign = Math.sign(diff[diff.length - 1])
  let lastNotWinning = -1
  for (let i = 0; i < diff.length; i++) if (Math.sign(diff[i]) !== finalSign) lastNotWinning = i
  if (lastNotWinning === -1 || lastNotWinning + 1 >= plays.length) return false // led wire to wire
  const goAhead = plays[lastNotWinning + 1]
  return goAhead.period >= 4 && goAhead.clock <= BIG_MOMENT_SECONDS
}
