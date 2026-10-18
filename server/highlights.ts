import { teamFromName } from './teams.ts'

export interface Upload {
  videoId: string
  channelId: string
  title: string
  publishedAt: string // ISO
}

export interface HighlightCandidateGame {
  id: string
  season: number
  game_type: string
  week: number
  home_team: string
  away_team: string
  kickoff_at: string // ISO UTC
}

export interface ParsedTitle {
  teams: [string, string]
  season: number | null
  week: number | null
}

// Highlights can lag a few hours; anything this long after kickoff is a different video.
const MATCH_WINDOW_MS = 4 * 86_400_000

// The matcher keeps looking for a game's video this long after kickoff, then gives up.
export const HIGHLIGHT_LOOKBACK_MS = 14 * 86_400_000
// After this long without a video, the UI says "not yet available".
export const HIGHLIGHT_OVERDUE_MS = 24 * 3_600_000

/**
 * Parse an official full-game highlight title, e.g.
 * "Buffalo Bills vs Los Angeles Rams Game Highlights | 2026 NFL Season Week 5".
 * Null for anything else (player clips, recaps, top-plays lists).
 */
export function parseHighlightTitle(title: string): ParsedTitle | null {
  const m = /^(.+?)\s+vs\.?\s+(.+?)\s+game highlights\b(.*)$/i.exec(title.trim())
  if (!m) return null
  const a = teamFromName(m[1])
  const b = teamFromName(m[2])
  if (!a || !b || a === b) return null
  const season = /\b(20\d\d)\b/.exec(m[3])
  const week = /\bweek\s+(\d{1,2})\b/i.exec(m[3])
  return { teams: [a, b], season: season ? Number(season[1]) : null, week: week ? Number(week[1]) : null }
}

/**
 * Pair games with highlight uploads: same two teams (either order), published
 * after kickoff and within the match window, and season/week agreeing when the
 * title states them. The earliest qualifying upload wins.
 */
export function matchHighlights(games: HighlightCandidateGame[], uploads: Upload[]): Map<string, Upload> {
  const parsed = uploads
    .map((u) => ({ u, t: parseHighlightTitle(u.title), at: Date.parse(u.publishedAt) }))
    .filter((p): p is { u: Upload; t: ParsedTitle; at: number } => p.t !== null)
    .sort((x, y) => x.at - y.at)
  const out = new Map<string, Upload>()
  for (const g of games) {
    const kickoff = Date.parse(g.kickoff_at)
    const hit = parsed.find(
      ({ t, at }) =>
        t.teams.includes(g.home_team) &&
        t.teams.includes(g.away_team) &&
        at >= kickoff &&
        at - kickoff <= MATCH_WINDOW_MS &&
        (t.season === null || t.season === g.season) &&
        (t.week === null || g.game_type !== 'REG' || t.week === g.week),
    )
    if (hit) out.set(g.id, hit.u)
  }
  return out
}
