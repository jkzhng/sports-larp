import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireIngestLock, readIngestLock } from './ingest-lock.ts'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'ingest-lock-')), 'db.ingest-lock')

test('only one holder at a time, and release frees the lock', () => {
  const path = lockPath()
  const release = acquireIngestLock(['nba'], path)
  assert.ok(release)
  assert.equal(acquireIngestLock(['nfl'], path), null)
  assert.deepEqual(readIngestLock(path)?.leagues, ['nba'])
  release()
  assert.equal(readIngestLock(path), null)
  assert.ok(acquireIngestLock(['nfl'], path))
})

test('a lock left by a dead process is taken over', () => {
  const path = lockPath()
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-10-01T00:00:00Z', leagues: ['nfl'] }))
  assert.equal(readIngestLock(path), null)
  assert.ok(acquireIngestLock(['nba'], path))
  assert.equal(readIngestLock(path)?.pid, process.pid)
})
