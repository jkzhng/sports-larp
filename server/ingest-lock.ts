// One ingest pass at a time, across processes: `npm run ingest`, `ingest:watch`
// and the UI's Update button (which runs the CLI as a child) all take this lock.
// It sits next to the database, so a test copy (SPORTS_LARP_DB) has its own.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DB_PATH } from './config.ts'

export const LOCK_PATH = `${DB_PATH}.ingest-lock`

export interface IngestLock {
  pid: number
  startedAt: string // ISO UTC
  leagues: string[]
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The lock held by a running process, or null. A lock left by a killed process doesn't count. */
export function readIngestLock(path = LOCK_PATH): IngestLock | null {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as IngestLock
    return alive(lock.pid) ? lock : null
  } catch {
    return null
  }
}

/** Takes the lock and returns its release function, or null when another process holds it. */
export function acquireIngestLock(leagues: string[], path = LOCK_PATH, now = new Date()): (() => void) | null {
  const lock: IngestLock = { pid: process.pid, startedAt: now.toISOString(), leagues }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: 'wx' })
      return () => rmSync(path, { force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (readIngestLock(path)) return null
      rmSync(path, { force: true }) // stale: its process is gone
    }
  }
  return null
}
