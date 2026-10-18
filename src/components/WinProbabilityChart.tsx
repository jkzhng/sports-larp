import type { KeyMoment, RevealResponse } from '../api.ts'

const W = 640
const H = 200
const PAD = { left: 44, right: 12, top: 12, bottom: 24 }

interface Props {
  away: string
  home: string
  wp: RevealResponse['winProbability']
  moments: KeyMoment[]
}

function momentSeconds(m: KeyMoment, period: number, otLength: number): number {
  const [min, sec] = m.clock.split(':').map(Number)
  const remaining = min * 60 + sec
  if (m.qtr <= 4) return (m.qtr - 1) * period + (period - remaining)
  return 4 * period + (m.qtr - 5) * otLength + (otLength - remaining)
}

/** Home team's win probability across the game; up is the home team, down is the away team. */
export function WinProbabilityChart({ away, home, wp, moments }: Props) {
  const points = wp.points
  if (points.length < 2) return null
  const period = wp.periodSeconds
  const regulation = 4 * period
  const end = Math.max(regulation, points.at(-1)![0])
  const x = (t: number) => PAD.left + (t / end) * (W - PAD.left - PAD.right)
  const y = (p: number) => PAD.top + (1 - p) * (H - PAD.top - PAD.bottom)
  const line = points.map(([t, p], i) => `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join('')
  // Each period as [start, end, label]; overtime periods only if the game got there.
  const ot = wp.overtimePeriodSeconds
  const otCount = Math.ceil((end - regulation) / ot)
  const periods: [number, number, string][] = [
    ...[1, 2, 3, 4].map((q): [number, number, string] => [(q - 1) * period, q * period, `Q${q}`]),
    ...Array.from({ length: otCount }, (_, k): [number, number, string] => [
      regulation + k * ot,
      Math.min(end, regulation + (k + 1) * ot),
      k === 0 ? 'OT' : `${k + 1}OT`,
    ]),
  ]

  return (
    <svg className="wp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Win probability, ${home} above the line and ${away} below`}>
      <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={(H - PAD.top - PAD.bottom) / 2} className="wp-home-zone" />
      {periods.slice(1).map(([start]) => (
        <line key={start} x1={x(start)} x2={x(start)} y1={PAD.top} y2={H - PAD.bottom} className="wp-grid" />
      ))}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(0.5)} y2={y(0.5)} className="wp-mid" />
      <text x={PAD.left - 8} y={y(0.95)} textAnchor="end" className="wp-team">
        {home}
      </text>
      <text x={PAD.left - 8} y={y(0.05)} textAnchor="end" className="wp-team">
        {away}
      </text>
      <text x={PAD.left - 8} y={y(0.5) + 4} textAnchor="end" className="wp-axis">
        50%
      </text>
      {periods.map(([start, stop, label]) => (
        <text key={label} x={x((start + stop) / 2)} y={H - 6} textAnchor="middle" className="wp-axis">
          {label}
        </text>
      ))}
      <path d={line} className="wp-line" />
      {moments.map((m) => {
        const t = momentSeconds(m, period, wp.overtimePeriodSeconds)
        const nearest = points.reduce((best, pt) => (Math.abs(pt[0] - t) < Math.abs(best[0] - t) ? pt : best), points[0])
        return <circle key={`${m.qtr}-${m.clock}`} cx={x(nearest[0])} cy={y(nearest[1])} r={4} className="wp-moment" />
      })}
    </svg>
  )
}
