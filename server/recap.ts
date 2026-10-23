// Post-reveal content for one game, built from its play-by-play: key moments,
// the win-probability series, and template talking points (no LLM).
import type { Play } from './types.ts'

export interface KeyMoment {
  qtr: number
  clock: string // "1:52"
  swing: number // change in home WP, -1 to 1
  text: string
}

export interface Recap {
  overtime: number // overtime periods played: 0, 1 (OT), 2 (2OT), ...
  keyMoments: KeyMoment[]
  talkingPoints: string[]
  wp: [number, number][] // [elapsed game seconds, home WP]
}

export interface RecapGame {
  game_type: string
  home_team: string
  away_team: string
}

const MAX_MOMENTS = 5
const MIN_MOMENTS = 3
const MOMENT_MIN_SWING = 0.08
const TURNOVER_EDGE = 2
const YARDAGE_EDGE = 150
const MAX_TALKING_POINTS = 4

const num = (v: number | null) => v ?? 0
const is1 = (v: number | null) => v === 1

/** "J.Allen" -> "J. Allen", "A.St. Brown" -> "A. St. Brown". */
export const playerName = (raw: string) => raw.replace(/^([A-Za-z]+)\.(?=\S)/, '$1. ')

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

export function quarterLabel(qtr: number): string {
  return qtr <= 4 ? `Q${qtr}` : qtr === 5 ? 'OT' : `${qtr - 4}OT`
}

function clock(seconds: number | null): string {
  const s = Math.max(0, Math.round(num(seconds)))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Seconds of game clock elapsed at a play; overtime periods follow regulation. */
export function elapsedSeconds(p: Play, gameType: string): number | null {
  if (p.qtr === null || p.quarter_seconds_remaining === null) return null
  if (p.qtr <= 4) return (p.qtr - 1) * 900 + (900 - p.quarter_seconds_remaining)
  const otLength = gameType === 'REG' ? 600 : 900
  return 3600 + (p.qtr - 5) * otLength + (otLength - p.quarter_seconds_remaining)
}

/** nflverse play text without the clock, formation and jersey numbers. */
export function cleanDescription(desc: string): string {
  return desc
    .replace(/^\(\d{0,2}:\d{2}\)\s*/, '')
    .replace(/^.*?\breported in as eligible\b[^.]*\.\s*/i, '')
    .replace(/^(\((?:Shotgun|No Huddle|No Huddle, Shotgun|Punt formation|Field Goal formation|Run formation)\)\s*)+/i, '')
    .replace(/\b\d{1,2}-(?=[A-Z])/g, '')
    .replace(/\s*\[[^\]]*\]/g, '') // pressure and recovery credits
    .replace(/\s+\([^()]*\)\.$/, '.') // trailing tackler credit
    .replace(/([A-Z][a-z]?)\.(?=[A-Z][a-z])/g, '$1. ')
    .trim()
}

const isReal = (p: Play) => p.play_type !== null && p.play_type !== 'no_play'
const isTry = (p: Play) => p.play_type === 'extra_point' || is1(p.two_point_attempt)
const isScrimmage = (p: Play) => (p.play_type === 'pass' || p.play_type === 'run' || p.play_type === 'qb_kneel' || p.play_type === 'qb_spike') && !is1(p.two_point_attempt)
const SNAP_TYPES = new Set(['pass', 'run', 'field_goal', 'punt'])
const isSnap = (p: Play) => p.play_type !== null && SNAP_TYPES.has(p.play_type) && !is1(p.two_point_attempt)

/**
 * Change in spread-adjusted home WP from each play to the next real snap, so a
 * touchdown carries its extra point and kickoff. nflverse's WP is unreliable
 * across tries and kickoffs (worst in overtime), so when a play changes the
 * score, the swing is forced to point toward the team that scored.
 */
function playSwings(plays: Play[]): number[] {
  const homeDiff: number[] = []
  let home = 0
  let away = 0
  for (const p of plays) {
    if (p.total_home_score !== null) home = p.total_home_score
    if (p.total_away_score !== null) away = p.total_away_score
    homeDiff.push(home - away)
  }
  const finalWp = plays.findLast((p) => p.vegas_home_wp !== null)?.vegas_home_wp ?? null

  const swings = new Array<number>(plays.length).fill(0)
  let nextSnap = -1 // index of the next snap after i with a known WP
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i]
    const before = p.vegas_home_wp
    const after = nextSnap >= 0 ? plays[nextSnap].vegas_home_wp : finalWp
    if (before !== null && after !== null) {
      let swing = after - before
      const scoreBefore = i > 0 ? homeDiff[i - 1] : 0
      const scoreAfter = nextSnap >= 0 ? homeDiff[nextSnap - 1] : homeDiff[plays.length - 1]
      const scored = Math.sign(scoreAfter - scoreBefore)
      if (scored !== 0 && Math.sign(swing) === -scored) swing = -swing
      swings[i] = swing
    }
    if (isSnap(p) && before !== null) nextSnap = i
  }
  return swings
}

export function buildRecap(plays: Play[], game: RecapGame): Recap {
  const swings = playSwings(plays)

  const wp: [number, number][] = []
  for (const p of plays) {
    const t = elapsedSeconds(p, game.game_type)
    if (t === null || p.vegas_home_wp === null) continue
    const point: [number, number] = [t, Math.round(p.vegas_home_wp * 1000) / 1000]
    if (wp.length > 0 && wp.at(-1)![0] === t) wp[wp.length - 1] = point
    else wp.push(point)
  }

  const candidates = plays
    .map((p, i) => ({ p, swing: swings[i] }))
    .filter(({ p }) => isReal(p) && !isTry(p) && p.play_type !== 'kickoff' && p.desc && p.qtr !== null)
    .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing))
  const picked = candidates.filter((c, i) => i < MIN_MOMENTS || Math.abs(c.swing) >= MOMENT_MIN_SWING).slice(0, MAX_MOMENTS)
  const keyMoments = picked
    .sort((a, b) => plays.indexOf(a.p) - plays.indexOf(b.p))
    .map(({ p, swing }) => ({
      qtr: p.qtr!,
      clock: clock(p.quarter_seconds_remaining),
      swing: Math.round(swing * 1000) / 1000,
      text: cleanDescription(p.desc!),
    }))

  const biggest = candidates.find(({ p }) => biggestPlayPhrase(p) !== null)?.p ?? null

  return {
    overtime: Math.max(0, ...plays.map((p) => (p.qtr ?? 0) - 4)),
    keyMoments,
    talkingPoints: talkingPoints(plays, game, biggest),
    wp,
  }
}

// ---------------------------------------------------------------- talking points

interface Line {
  player: string
  team: string
  yds: number
  td: number
  count: number // completions, carries or receptions
  attempts: number
}

function leader(plays: Play[], name: (p: Play) => string | null, team: (p: Play) => string | null,
  add: (line: Line, p: Play) => void): Line | null {
  const lines = new Map<string, Line>()
  for (const p of plays) {
    const n = name(p)
    if (!n) continue
    const key = `${n}|${team(p)}`
    const line = lines.get(key) ?? { player: playerName(n), team: team(p) ?? '', yds: 0, td: 0, count: 0, attempts: 0 }
    add(line, p)
    lines.set(key, line)
  }
  return [...lines.values()].sort((a, b) => b.yds - a.yds)[0] ?? null
}

function biggestPlayPhrase(p: Play): string | null {
  const yds = Math.round(num(p.yards_gained))
  const td = is1(p.touchdown) ? ' for a touchdown' : ''
  if (is1(p.interception) && p.interception_player_name && p.passer_player_name) {
    return `${playerName(p.interception_player_name)} picked off ${playerName(p.passer_player_name)}${td ? ' and took it back for a touchdown' : ''}`
  }
  if (p.play_type === 'pass' && p.passer_player_name && p.receiver_player_name && is1(p.complete_pass)) {
    return `${playerName(p.passer_player_name)} ${yds}-yard pass to ${playerName(p.receiver_player_name)}${td}`
  }
  if (p.play_type === 'run' && p.rusher_player_name && yds > 0) {
    return `${playerName(p.rusher_player_name)} ${yds}-yard run${td}`
  }
  return null
}

function talkingPoints(plays: Play[], game: RecapGame, biggest: Play | null): string[] {
  const scrimmage = plays.filter(isScrimmage)
  const out: string[] = []

  const passing = leader(scrimmage, (p) => p.passer_player_name, (p) => p.posteam, (l, p) => {
    l.yds += num(p.passing_yards)
    l.td += num(p.pass_touchdown)
    l.count += num(p.complete_pass)
    if (is1(p.pass_attempt) && !is1(p.sack)) l.attempts++
  })
  if (passing) {
    const tds = passing.td === 0 ? 'no touchdowns' : plural(passing.td, 'TD')
    out.push(`${passing.player} (${passing.team}) threw for ${passing.yds} yards and ${tds} (${passing.count}/${passing.attempts}).`)
  }

  const rushing = leader(scrimmage, (p) => p.rusher_player_name, (p) => p.posteam, (l, p) => {
    l.yds += num(p.rushing_yards)
    l.td += num(p.rush_touchdown)
    if (is1(p.rush_attempt)) l.count++
  })
  if (rushing) {
    const tds = rushing.td > 0 ? ` and ${plural(rushing.td, 'TD')}` : ''
    out.push(`${rushing.player} (${rushing.team}) ran for ${rushing.yds} yards on ${plural(rushing.count, 'carry', 'carries')}${tds}.`)
  }

  const receiving = leader(scrimmage, (p) => p.receiver_player_name, (p) => p.posteam, (l, p) => {
    l.yds += num(p.receiving_yards)
    l.td += num(p.pass_touchdown)
    l.count += num(p.complete_pass)
  })
  if (receiving) {
    const tds = receiving.td > 0 ? ` and ${plural(receiving.td, 'TD')}` : ''
    out.push(`${receiving.player} (${receiving.team}) caught ${plural(receiving.count, 'pass', 'passes')} for ${receiving.yds} yards${tds}.`)
  }

  const extra = standoutTeamStat(plays, scrimmage, game) ?? defensiveStandout(plays)
  if (extra) out.push(extra)
  else if (biggest) {
    const phrase = biggestPlayPhrase(biggest)!
    out.push(`${quarterLabel(biggest.qtr!)} ${clock(biggest.quarter_seconds_remaining)}: ${phrase}.`)
  }
  return out.slice(0, MAX_TALKING_POINTS)
}

function standoutTeamStat(plays: Play[], scrimmage: Play[], game: RecapGame): string | null {
  const teams = [game.home_team, game.away_team]
  const giveaways = Object.fromEntries(teams.map((t) => [t, 0]))
  for (const p of plays) {
    if (!isReal(p) || !p.posteam || !(p.posteam in giveaways)) continue
    giveaways[p.posteam] += num(p.interception) + num(p.fumble_lost)
  }
  const [a, b] = teams
  const margin = giveaways[b] - giveaways[a] // positive: `a` took the ball away more
  if (Math.abs(margin) >= TURNOVER_EDGE) {
    const [winner, loser] = margin > 0 ? [a, b] : [b, a]
    return `${winner} won the turnover battle ${giveaways[loser]}-${giveaways[winner]}.`
  }

  const yards = Object.fromEntries(teams.map((t) => [t, 0]))
  for (const p of scrimmage) if (p.posteam && p.posteam in yards) yards[p.posteam] += num(p.yards_gained)
  const gap = yards[a] - yards[b]
  if (Math.abs(gap) >= YARDAGE_EDGE) {
    const [more, less] = gap > 0 ? [a, b] : [b, a]
    return `${more} outgained ${less} ${Math.round(yards[more])} to ${Math.round(yards[less])}.`
  }
  return null
}

function defensiveStandout(plays: Play[]): string | null {
  const players = new Map<string, { team: string; sacks: number; ints: number }>()
  const credit = (name: string | null, team: string | null, sacks: number, ints: number) => {
    if (!name) return
    const key = `${name}|${team}`
    const s = players.get(key) ?? { team: team ?? '', sacks: 0, ints: 0 }
    s.sacks += sacks
    s.ints += ints
    players.set(key, s)
  }
  for (const p of plays) {
    if (!isReal(p)) continue
    credit(p.sack_player_name, p.defteam, 1, 0)
    credit(p.half_sack_1_player_name, p.defteam, 0.5, 0)
    credit(p.half_sack_2_player_name, p.defteam, 0.5, 0)
    if (is1(p.interception)) credit(p.interception_player_name, p.defteam, 0, 1)
  }
  const best = [...players.entries()]
    .filter(([, s]) => s.sacks >= 2 || s.ints >= 2)
    .sort(([, x], [, y]) => y.sacks + 2 * y.ints - (x.sacks + 2 * x.ints))[0]
  if (!best) return null
  const [key, s] = best
  const parts = [s.sacks > 0 ? plural(s.sacks, 'sack') : null, s.ints > 0 ? plural(s.ints, 'interception') : null].filter(Boolean)
  return `${playerName(key.split('|')[0])} (${s.team}) had ${parts.join(' and ')}.`
}
