import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'
import { RAW_DIR } from '../config.ts'
import { PLAY_COLUMNS, type Play, type ScheduleGame } from '../types.ts'

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'
const PBP_RELEASE_URL = 'https://api.github.com/repos/nflverse/nflverse-data/releases/tags/pbp'


async function download(url: string, dest: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers })
  if (res.status === 304) return res
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  return res
}

// ---------------------------------------------------------------- schedule

export interface ScheduleFetch {
  games: ScheduleGame[]
  etag: string | null
  changed: boolean
}

/** nflverse games.csv. Skips the download when the ETag matches the last fetch. */
export async function fetchSchedule(lastEtag: string | null): Promise<ScheduleFetch> {
  const dest = `${RAW_DIR}/games.csv`
  const headers: Record<string, string> = lastEtag ? { 'If-None-Match': lastEtag } : {}
  let res: Response
  try {
    res = await download(GAMES_URL, dest, headers)
  } catch (err) {
    // A stale schedule is better than none; fall back to the cached copy.
    const cached = await readFile(dest, 'utf8').catch(() => null)
    if (cached === null) throw err
    console.warn(`schedule download failed, using cached copy: ${(err as Error).message}`)
    return { games: parseSchedule(cached), etag: lastEtag, changed: false }
  }
  const games = parseSchedule(await readFile(dest, 'utf8'))
  return { games, etag: res.headers.get('etag') ?? lastEtag, changed: res.status !== 304 }
}

function parseSchedule(csv: string): ScheduleGame[] {
  const [header, ...rows] = parseCsv(csv)
  const col = Object.fromEntries(header.map((h, i) => [h, i]))
  const str = (r: string[], k: string) => r[col[k]] ?? ''
  const numOrNull = (r: string[], k: string) => {
    const v = str(r, k)
    return v === '' || v === 'NA' ? null : Number(v)
  }
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => ({
      game_id: str(r, 'game_id'),
      season: Number(str(r, 'season')),
      game_type: str(r, 'game_type'),
      week: Number(str(r, 'week')),
      gameday: str(r, 'gameday'),
      weekday: str(r, 'weekday'),
      gametime: str(r, 'gametime'),
      away_team: str(r, 'away_team'),
      home_team: str(r, 'home_team'),
      away_score: numOrNull(r, 'away_score'),
      home_score: numOrNull(r, 'home_score'),
      result: numOrNull(r, 'result'),
      div_game: Number(str(r, 'div_game')),
      spread_line: numOrNull(r, 'spread_line'),
    }))
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) rows.push([...row, field])
  return rows
}

// ---------------------------------------------------------------- play-by-play

export interface PbpAsset {
  season: number
  url: string
  updatedAt: string
}

/** Every season's play-by-play parquet in the nflverse release, with its last-updated time. */
export async function fetchPbpAssets(): Promise<Map<number, PbpAsset>> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(PBP_RELEASE_URL, { headers })
  if (!res.ok) throw new Error(`GitHub release lookup failed: ${res.status} ${res.statusText}`)
  const release = (await res.json()) as { assets: { name: string; browser_download_url: string; updated_at: string }[] }
  const out = new Map<number, PbpAsset>()
  for (const a of release.assets) {
    const m = /^play_by_play_(\d{4})\.parquet$/.exec(a.name)
    if (m) out.set(Number(m[1]), { season: Number(m[1]), url: a.browser_download_url, updatedAt: a.updated_at })
  }
  return out
}

/** Download one season's play-by-play and return its rows, numbered in published order per game. */
export async function fetchPbp(asset: PbpAsset): Promise<Play[]> {
  const dest = `${RAW_DIR}/pbp_${asset.season}.parquet`
  await download(asset.url, dest)
  const file = await asyncBufferFromFile(dest)
  const rows = (await parquetReadObjects({ file, columns: [...PLAY_COLUMNS] })) as Omit<Play, 'seq'>[]
  const seq = new Map<string, number>()
  return rows.map((r) => {
    const n = seq.get(r.game_id) ?? 0
    seq.set(r.game_id, n + 1)
    const play = { seq: n } as Play
    for (const c of PLAY_COLUMNS) (play as unknown as Record<string, unknown>)[c] = r[c] ?? null
    return play
  })
}
