// Post-reveal content for one NBA game: key moments, the win-probability series
// and template talking points (no LLM). The NFL version is server/recap.ts.
import type { KeyMoment, Recap } from '../recap.ts'
import type { Summary } from '../sources/espn.ts'
import { NBA_TEAMS } from './teams.ts'
import { OT_PERIOD, REGULATION_PERIOD } from './model.ts'
import { boxPlayers, isTripleDouble, nbaPlays, type BoxPlayer, type NbaPlay } from './signals.ts'

const MAX_MOMENTS = 5
const MIN_MOMENTS = 3
const MOMENT_MIN_SWING = 0.08
const MAX_TALKING_POINTS = 4
const BIG_COMEBACK = 15 // points the winner trailed by
const THREES_EDGE = 8
const REBOUND_EDGE = 12
const BIG_GAME_POINTS = 40

// Plays that move the clock or the ball but say nothing worth reading.
const QUIET_TYPES = /Substitution|Timeout|End Period|End Game|Jumpball|Challenge|Review/i

/** Seconds of game clock elapsed at a play; overtime periods follow regulation. */
export function nbaElapsedSeconds(p: { period: number; clock: number }): number {
  if (p.period <= 4) return (p.period - 1) * REGULATION_PERIOD + (REGULATION_PERIOD - p.clock)
  return 4 * REGULATION_PERIOD + (p.period - 5) * OT_PERIOD + (OT_PERIOD - p.clock)
}

function clockLabel(seconds: number): string {
  if (seconds < 60) return `0:${seconds.toFixed(1).padStart(4, '0')}`
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const nickname = (abbr: string) => NBA_TEAMS[abbr]?.nickname ?? abbr

// ESPN moves win probability on fouls, rebounds and timeouts too. A swing is
// carried forward to the next shot or turnover, so a foul's swing lands on its
// free throws, the way the NFL recap carries extra points to the next snap.
const isMomentPlay = (p: NbaPlay) => (p.shooting || /Turnover/i.test(p.type)) && !QUIET_TYPES.test(p.type) && p.text !== ''

function keyMoments(plays: NbaPlay[], home: string, away: string): KeyMoment[] {
  const swings: { i: number; swing: number }[] = []
  let before = plays[0]?.homeWp ?? null
  for (let i = 1; i < plays.length; i++) {
    const p = plays[i]
    if (p.homeWp === null || !isMomentPlay(p)) continue
    if (before !== null) swings.push({ i, swing: p.homeWp - before })
    before = p.homeWp
  }
  const ranked = swings.sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing))
  const big = ranked.filter((s) => Math.abs(s.swing) >= MOMENT_MIN_SWING)
  const picked = (big.length >= MIN_MOMENTS ? big : ranked.slice(0, MIN_MOMENTS)).slice(0, MAX_MOMENTS)
  return picked
    .sort((a, b) => a.i - b.i)
    .map(({ i, swing }) => {
      const p = plays[i]
      return {
        qtr: p.period,
        clock: clockLabel(p.clock),
        swing: Math.round(swing * 1000) / 1000,
        text: `${p.text} (${away} ${p.awayScore}–${p.homeScore} ${home})`,
      }
    })
}

function statLine(b: BoxPlayer): string {
  const parts = [`${b.PTS} points`]
  if (b.REB >= 5) parts.push(`${b.REB} rebounds`)
  if (b.AST >= 5) parts.push(`${b.AST} assists`)
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

function talkingPoints(plays: NbaPlay[], box: BoxPlayer[], home: string, away: string): string[] {
  const last = plays[plays.length - 1]
  const winner = last.homeScore > last.awayScore ? home : away
  const loser = winner === home ? away : home
  const out: string[] = []
  const leaders: BoxPlayer[] = []
  for (const team of [winner, loser]) {
    const top = box.filter((b) => b.team === team).sort((a, b) => b.PTS - a.PTS)[0]
    if (!top) continue
    leaders.push(top)
    const td = isTripleDouble(top) ? ' for a triple-double' : ''
    out.push(`${top.name} led the ${nickname(team)} with ${statLine(top)}${td}.`)
  }

  // One more line: the first of these that stands out.
  const extra: (() => string | null)[] = [
    () => {
      const td = box.find((b) => isTripleDouble(b) && !leaders.includes(b))
      return td ? `${td.name} had a triple-double: ${td.PTS} points, ${td.REB} rebounds and ${td.AST} assists.` : null
    },
    () => {
      const big = box.find((b) => b.PTS >= BIG_GAME_POINTS && !leaders.includes(b))
      return big ? `${big.name} scored ${big.PTS} for the ${nickname(big.team)}.` : null
    },
    () => {
      const sign = winner === home ? 1 : -1
      const deficit = Math.max(0, ...plays.map((p) => -sign * (p.homeScore - p.awayScore)))
      return deficit >= BIG_COMEBACK ? `The ${nickname(winner)} came back from ${deficit} points down.` : null
    },
    () => {
      const threes = (team: string) =>
        plays.filter((p) => p.scoring && p.shooting && p.scoreValue === 3 && p.isHome === (team === home)).length
      const [w, l] = [threes(winner), threes(loser)]
      if (Math.abs(w - l) < THREES_EDGE) return null
      const [more, fewer, mt, ft] = w > l ? [winner, loser, w, l] : [loser, winner, l, w]
      return `The ${nickname(more)} made ${mt} threes to the ${nickname(fewer)}' ${ft}.`
    },
    () => {
      const reb = (team: string) => box.filter((b) => b.team === team).reduce((s, b) => s + b.REB, 0)
      const [w, l] = [reb(winner), reb(loser)]
      if (Math.abs(w - l) < REBOUND_EDGE) return null
      const [more, fewer, mt, ft] = w > l ? [winner, loser, w, l] : [loser, winner, l, w]
      return `The ${nickname(more)} outrebounded the ${nickname(fewer)} ${mt} to ${ft}.`
    },
  ]
  for (const line of extra) {
    if (out.length >= MAX_TALKING_POINTS) break
    const text = line()
    if (text) {
      out.push(text)
      break
    }
  }
  return out
}

export function buildNbaRecap(summary: Summary, home: string, away: string): Recap | null {
  const plays = nbaPlays(summary)
  if (plays.length === 0) return null
  const wp: [number, number][] = []
  for (const p of plays) {
    if (p.homeWp === null) continue
    const t = nbaElapsedSeconds(p)
    const point: [number, number] = [Math.round(t), Math.round(p.homeWp * 1000) / 1000]
    if (wp.length > 0 && wp.at(-1)![0] === point[0]) wp[wp.length - 1] = point
    else wp.push(point)
  }
  return {
    overtime: plays.some((p) => p.period > 4),
    keyMoments: keyMoments(plays, home, away),
    talkingPoints: talkingPoints(plays, boxPlayers(summary), home, away),
    wp,
  }
}
