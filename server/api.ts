// HTTP server: the spoiler-safe list API, plus the built React app from dist/.
//   npm run api    (dev: Vite proxies /api here)
//   npm start      (after npm run build: serves UI and API together)
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentSeason } from './config.ts'
import { openDb } from './db.ts'
import { currentNbaSeason } from './nba/model.ts'
import { listGames, listNbaGames, listNights, listWeeks, rateGame, revealGame } from './queries.ts'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1' // personal tool: local only unless told otherwise
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

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
