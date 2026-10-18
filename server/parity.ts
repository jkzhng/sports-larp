// Checks the TypeScript ports against the Python notebooks: every game in
// data/scored_games.csv (notebooks/scoring.ipynb) and data/scored_nba_games.csv
// (notebooks/nba_scoring.ipynb) should get the same score from the ingestion
// job's database. Run `npm run ingest` first.
import { existsSync, readFileSync } from 'node:fs'
import { DATA_DIR } from './config.ts'
import { openDb } from './db.ts'
import { MODEL_VERSION as NBA_VERSION } from './nba/model.ts'
import { MODEL_VERSION } from './scoring/model.ts'
import { parseCsv } from './sources/nflverse.ts'

const db = openDb()

function compare(csv: string, version: string): void {
  const path = `${DATA_DIR}${csv}`
  if (!existsSync(path)) {
    console.log(`${version}: ${csv} not found; run the notebook first`)
    return
  }
  const [header, ...rows] = parseCsv(readFileSync(path, 'utf8'))
  const col = (name: string) => header.indexOf(name)
  const python = new Map(rows.filter((r) => r.length === header.length).map((r) => [r[col('game_id')], r]))
  const ts = db.prepare('select game_id, total, tier from watch_scores where model_version = ?').all(version) as {
    game_id: string
    total: number
    tier: string
  }[]

  let worst = 0
  const mismatches: string[] = []
  for (const t of ts) {
    const p = python.get(t.game_id)
    if (!p) continue
    if (p[col('model_version')] !== version) throw new Error(`${csv} is ${p[col('model_version')]}, job is ${version}; re-run the notebook`)
    const gap = Math.abs(Number(p[col('score')]) - t.total)
    worst = Math.max(worst, gap)
    if (gap > 0.1 || p[col('tier')] !== t.tier) mismatches.push(`${t.game_id}: python ${p[col('score')]} vs ts ${t.total}`)
  }
  const scoredIds = new Set(ts.map((t) => t.game_id))
  const missing = [...python.keys()].filter((id) => !scoredIds.has(id))
  console.log(`${version}: compared ${ts.length - missing.length} games; largest score gap ${worst.toFixed(2)}`)
  if (missing.length) console.log(`  in notebook but not scored by the job: ${missing.length}`)
  if (mismatches.length) {
    console.log(`  mismatches (${mismatches.length}):\n    ${mismatches.slice(0, 20).join('\n    ')}`)
    process.exitCode = 1
  }
}

compare('scored_games.csv', MODEL_VERSION)
compare('scored_nba_games.csv', NBA_VERSION)
db.close()
