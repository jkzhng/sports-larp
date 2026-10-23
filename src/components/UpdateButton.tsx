// Runs an ingest pass for the shown league, then asks the app to reload.
import { useEffect, useState } from 'react'
import { fetchIngestStatus, postIngest, type IngestStatus, type League } from '../api.ts'

const POLL_MS = 3000
const timeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

interface UpdateButtonProps {
  league: League
  onUpdated: () => void
}

export function UpdateButton({ league, onUpdated }: UpdateButtonProps) {
  const [status, setStatus] = useState<IngestStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = status?.running ?? false

  // A pass may already be running (ingest:watch, or another tab).
  useEffect(() => {
    fetchIngestStatus().then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      fetchIngestStatus()
        .then((s) => {
          setStatus(s)
          if (s.running) return
          if (s.lastOk === false) setError('Update failed; see the server log')
          onUpdated()
        })
        .catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, onUpdated])

  const start = () => {
    setError(null)
    postIngest(league)
      .then(setStatus)
      .catch((e: Error) => setError(`Couldn't start an update (${e.message})`))
  }

  const last = status?.lastFinishedAt ? `Last updated ${timeFormat.format(new Date(status.lastFinishedAt))}` : 'Fetch new results'
  return (
    <button type="button" className={`update-button ${error ? 'failed' : ''}`} onClick={start} disabled={running} title={error ?? last}>
      {running ? 'Updating…' : error ? 'Retry update' : 'Update'}
    </button>
  )
}
