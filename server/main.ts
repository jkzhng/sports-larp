// Ingestion job CLI.
//   npm run ingest                one pass, NFL then NBA
//   npm run ingest -- --league nba  one league only (nfl | nba)
//   npm run ingest -- --force     re-download all seasons and re-score
//   npm run ingest:watch          keep running: every 15 min around game days, hourly otherwise
//   npm run refit                 refit weights from your ratings now, both leagues (normally weekly)
import { parseArgs } from 'node:util'
import { openDb, setState } from './db.ts'
import { nextIntervalMinutes, runIngest } from './ingest.ts'
import { acquireIngestLock, readIngestLock } from './ingest-lock.ts'
import { nextNbaIntervalMinutes, runNbaIngest } from './nba/ingest.ts'

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    refit: { type: 'boolean', default: false },
    league: { type: 'string' },
  },
})

const leagues = values.league ? [values.league.toLowerCase()] : ['nfl', 'nba']
if (leagues.some((l) => l !== 'nfl' && l !== 'nba')) throw new Error(`unknown league ${values.league}; use nfl or nba`)

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`)
const db = openDb()

let force = values.force
for (;;) {
  const intervals: number[] = []
  // Held per pass, so the UI's Update button can run between watch passes.
  const release = acquireIngestLock(leagues)
  if (!release) {
    log(`another ingest is running (pid ${readIngestLock()?.pid ?? '?'}); skipping this pass`)
    if (!values.watch) break
    await new Promise((resolve) => setTimeout(resolve, 60_000))
    continue
  }
  let ok = true
  for (const league of leagues) {
    try {
      if (league === 'nfl') {
        const result = await runIngest(db, { force, refit: values.refit, log })
        intervals.push(nextIntervalMinutes(result.schedule, new Date()))
      } else {
        const result = await runNbaIngest(db, { force, refit: values.refit, log })
        intervals.push(nextNbaIntervalMinutes(result.schedule, new Date()))
      }
    } catch (err) {
      log(`${league} ingest failed: ${(err as Error).stack ?? err}`)
      if (!values.watch) process.exitCode = 1
      intervals.push(60)
      ok = false
    }
  }
  setState(db, 'ingest_last_finished_at', new Date().toISOString())
  setState(db, 'ingest_last_ok', ok ? '1' : '0')
  release()
  force = false
  if (!values.watch) break
  const minutes = Math.min(...intervals)
  log(`next pass in ${minutes} min`)
  await new Promise((resolve) => setTimeout(resolve, minutes * 60_000))
}
db.close()
