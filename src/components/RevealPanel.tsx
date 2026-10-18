import { useEffect, useState } from 'react'
import { fetchReveal, type RevealResponse } from '../api.ts'
import { WinProbabilityChart } from './WinProbabilityChart.tsx'

const quarterLabel = (q: number) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`)

export function RevealPanel({ gameId }: { gameId: string }) {
  const [data, setData] = useState<RevealResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    fetchReveal(gameId)
      .then((d) => !stale && setData(d))
      .catch((e: Error) => !stale && setError(e.message))
    return () => {
      stale = true
    }
  }, [gameId])

  if (error) return <p className="reveal-note">Couldn't load the result ({error}).</p>
  if (!data) return <p className="reveal-note">Loading…</p>

  const { away, home } = data
  const winner = away.score > home.score ? 'away' : home.score > away.score ? 'home' : null

  return (
    <div className="reveal">
      <p className="final">
        <span className={winner === 'away' ? 'won' : ''}>
          {away.abbr} {away.score}
        </span>
        <span className="dash">–</span>
        <span className={winner === 'home' ? 'won' : ''}>
          {home.score} {home.abbr}
        </span>
        <span className="final-label">Final{data.overtime ? ' (OT)' : ''}</span>
      </p>

      {data.talkingPoints.length > 0 && (
        <section>
          <h4>Talking points</h4>
          <ul className="talking-points">
            {data.talkingPoints.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      )}

      {data.winProbability.points.length > 1 && (
        <section>
          <h4>Win probability</h4>
          <WinProbabilityChart away={away.abbr} home={home.abbr} wp={data.winProbability} moments={data.keyMoments} />
        </section>
      )}

      {data.keyMoments.length > 0 && (
        <section>
          <h4>Key moments</h4>
          <ol className="moments">
            {data.keyMoments.map((m) => (
              <li key={`${m.qtr}-${m.clock}-${m.text}`}>
                <span className="moment-when">
                  {quarterLabel(m.qtr)} {m.clock}
                </span>
                <span className="moment-swing">
                  +{Math.round(Math.abs(m.swing) * 100)}% {m.swing >= 0 ? home.abbr : away.abbr}
                </span>
                <span className="moment-text">{m.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {data.why && (
        <section>
          <h4>
            Why it ranked here <span className="why-total">{data.why.total.toFixed(1)} / 100</span>
          </h4>
          <p className="why-model">
            {data.why.model.personalized
              ? `Weights personalized from ${data.why.model.ratingsUsed} of your ratings (${data.why.model.version}).`
              : 'Starting weights. Rate games to personalize them.'}
          </p>
          <ul className="why">
            {data.why.contributions.map((c) => (
              <li key={c.key}>
                <span className="why-label">{c.label}</span>
                <span className="why-bar" aria-hidden="true">
                  <span style={{ width: `${c.maxPoints > 0 ? (100 * c.points) / c.maxPoints : 0}%` }} />
                </span>
                <span className="why-points">
                  {c.points.toFixed(1)} / {c.maxPoints}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
