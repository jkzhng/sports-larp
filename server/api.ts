// HTTP server: the spoiler-safe list API, plus the built React app from dist/.
//   npm run api    (dev: Vite proxies /api here)
//   npm start      (after npm run build: serves UI and API together)
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentSeason } from './config.ts'
import type { IngestStatus } from './api-types.ts'
import { getState, openDb } from './db.ts'
import { readIngestLock } from './ingest-lock.ts'
import { currentNbaSeason } from './nba/model.ts'
import { listGames, listNbaGames, listNights, listWeeks, rateGame, revealGame } from './queries.ts'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1' // personal tool: local only unless told otherwise
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const INGEST_CLI = fileURLToPath(new URL('./main.ts', import.meta.url))

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

const db = openDb()

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 4096

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

// The Update button runs the ingest CLI as a child process: a pass does seconds of
// synchronous parsing and SQLite writes that would stall this server's requests.
// The child takes the shared ingest lock itself, so `running` also covers
// `npm run ingest:watch` passes and survives this server restarting.
let child: ChildProcess | null = null

function ingestStatus(): IngestStatus {
  const lock = readIngestLock()
  const ok = getState(db, 'ingest_last_ok')
  return {
    running: lock !== null || child !== null,
    startedAt: lock?.startedAt ?? null,
    lastFinishedAt: getState(db, 'ingest_last_finished_at'),
    lastOk: ok === null ? null : ok === '1',
  }
}

function startIngest(league: string | null): void {
  const args = ['--env-file-if-exists=.env', '--experimental-strip-types', '--disable-warning=ExperimentalWarning', INGEST_CLI]
  if (league) args.push('--league', league)
  console.log(`ingest started from the UI${league ? ` (${league})` : ''}`)
  child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  child.on('error', (err) => console.error('ingest failed to start:', err))
  child.on('close', (code) => {
    console.log(`ingest from the UI exited with code ${code}`)
    child = null
  })
}

/** Blocks other websites open in the browser from POSTing to this local server. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true // not a browser (curl); browsers always send Origin on POST
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const target = normalize(join(DIST, decodeURIComponent(pathname)))
  const inDist = target.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)
  const file = inDist && (await stat(target).catch(() => null))?.isFile() ? target : join(DIST, 'index.html')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('UI not built. Run `npm run build`, or use `npm run dev` for development.')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'cross-origin request' })

    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const league = (body as { league?: unknown } | null)?.league ?? null
      if (league !== null && league !== 'nfl' && league !== 'nba') return json(res, 400, { error: 'league must be nfl or nba' })
      if (ingestStatus().running) return json(res, 409, ingestStatus())
      startIngest(league)
      return json(res, 202, ingestStatus())
    }

    const rating = /^\/api\/games\/([\w-]+)\/rating$/.exec(url.pathname)
    if (rating && req.method === 'POST') {
      const body = await readJsonBody(req)
      const stars = (body as { stars?: unknown } | null)?.stars
      if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) {
        return json(res, 400, { error: 'stars must be a whole number from 1 to 5' })
      }
      return rateGame(db, rating[1], stars, new Date())
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: 'only finished games can be rated' })
    }

    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

    if (url.pathname === '/api/ingest') return json(res, 200, ingestStatus())

    if (url.pathname === '/api/weeks') {
      const season = Number(url.searchParams.get('season') ?? currentSeason(new Date()))
      return json(res, 200, listWeeks(db, season))
    }

    if (url.pathname === '/api/nights') {
      const season = Number(url.searchParams.get('season') ?? currentNbaSeason(new Date()))
      return json(res, 200, listNights(db, season, new Date()))
    }

    if (url.pathname === '/api/games' && url.searchParams.get('league') === 'NBA') {
      const night = url.searchParams.get('night') ?? ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) return json(res, 400, { error: 'night (YYYY-MM-DD) is required' })
      const body = listNbaGames(db, night, new Date())
      return body ? json(res, 200, body) : json(res, 404, { error: 'no games that night' })
    }

    if (url.pathname === '/api/games') {
      const season = Number(url.searchParams.get('season'))
      const week = Number(url.searchParams.get('week'))
      if (!Number.isInteger(season) || !Number.isInteger(week)) return json(res, 400, { error: 'season and week are required' })
      const body = listGames(db, season, week, new Date())
      return body ? json(res, 200, body) : json(res, 404, { error: 'no games for that week' })
    }

    // The only route that returns spoilers; the UI calls it after the user taps Reveal.
    const reveal = /^\/api\/games\/([\w-]+)\/reveal$/.exec(url.pathname)
    if (reveal) {
      const body = revealGame(db, reveal[1])
      return body ? json(res, 200, body) : json(res, 404, { error: 'no final result for that game' })
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
    return serveStatic(url.pathname, res)
  } catch (err) {
    console.error(err)
    return json(res, 500, { error: 'internal error' })
  }
})

server.listen(PORT, HOST, () => console.log(`Sports LARP on http://${HOST}:${PORT}`))
