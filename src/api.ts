import type { GamesResponse, NightsResponse, RevealResponse, WeeksResponse } from '../server/api-types.ts'

export type * from '../server/api-types.ts'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export const fetchWeeks = (season?: number) => get<WeeksResponse>(season ? `/api/weeks?season=${season}` : '/api/weeks')

export const fetchGames = (season: number, week: number) =>
  get<GamesResponse>(`/api/games?season=${season}&week=${week}`)

export const fetchNights = (season?: number) => get<NightsResponse>(season ? `/api/nights?season=${season}` : '/api/nights')

export const fetchNbaGames = (night: string) => get<GamesResponse>(`/api/games?league=NBA&night=${night}`)

export async function postRating(gameId: string, stars: number): Promise<void> {
  const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/rating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stars }),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

// Spoilers: only call after the user explicitly reveals a game.
export const fetchReveal = (gameId: string) => get<RevealResponse>(`/api/games/${encodeURIComponent(gameId)}/reveal`)
