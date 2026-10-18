// Matching NBA games to the NBA channel's full-game highlight uploads.
import type { Upload } from '../highlights.ts'
import { nbaTeamFromName } from './teams.ts'

export interface NbaHighlightCandidate {
  id: string
  night: string // YYYY-MM-DD
  home_team: string
  away_team: string
}

export interface ParsedNbaTitle {
  away: string
  home: string // with "vs" (neutral site) the order is the title's, so matching ignores it
  night: string
  extended: boolean
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * Parse an official full-game highlight title, e.g.
 *   "NUGGETS at LAKERS | FULL GAME HIGHLIGHTS | October 16, 2026"
 *   "#4 PACERS at #1 THUNDER | NBA FINALS GAME 7 HIGHLIGHTS | June 22, 2025"
 *   "SPURS vs KNICKS | EMIRATES NBA CUP CHAMPIONSHIP 🏆 | FULL GAME HIGHLIGHTS | December 16, 2025"
 * Null for anything else: preseason, series recaps, player clips, endings.
 */
export function parseNbaHighlightTitle(title: string): ParsedNbaTitle | null {
  const parts = title.split('|').map((p) => p.trim())
  if (parts.length < 3) return null
  let matchup = parts[0]
  const extended = /^EXTENDED:\s*/i.test(matchup)
  matchup = matchup.replace(/^EXTENDED:\s*/i, '')
  const m = /^(.+?)\s+(at|vs\.?)\s+(.+)$/i.exec(matchup)
  if (!m) return null
  const label = parts.slice(1, -1).join(' ')
  if (!/\b(FULL GAME( \d)?|FINALS GAME \d) HIGHLIGHTS\b/i.test(label) || /PRESEASON|SERIES/i.test(label)) return null
  const d = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(parts.at(-1)!)
  const month = d ? MONTHS.indexOf(d[1].toLowerCase()) : -1
  if (!d || month < 0) return null
  const away = nbaTeamFromName(m[1])
  const home = nbaTeamFromName(m[3])
  if (!away || !home || away === home) return null
  const night = `${d[3]}-${String(month + 1).padStart(2, '0')}-${d[2].padStart(2, '0')}`
  return { away, home, night, extended }
}

/**
 * Pair games with uploads: both teams and the night in the title agree. The
 * regular cut beats the longer "EXTENDED" one; the earliest upload wins ties.
 */
export function matchNbaHighlights(games: NbaHighlightCandidate[], uploads: Upload[]): Map<string, Upload> {
  const parsed = uploads
    .map((u) => ({ u, t: parseNbaHighlightTitle(u.title), at: Date.parse(u.publishedAt) }))
    .filter((p): p is { u: Upload; t: ParsedNbaTitle; at: number } => p.t !== null)
    .sort((x, y) => +x.t.extended - +y.t.extended || x.at - y.at)
  const out = new Map<string, Upload>()
  for (const g of games) {
    const hit = parsed.find(
      ({ t }) => t.night === g.night && [t.home, t.away].includes(g.home_team) && [t.home, t.away].includes(g.away_team),
    )
    if (hit) out.set(g.id, hit.u)
  }
  return out
}
