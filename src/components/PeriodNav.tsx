// Steps through NFL weeks or NBA nights.

export interface Period {
  key: string
  label: string // "Week 5", "Tue, Oct 20"
  detail: string // "Oct 9 – Oct 13", "Regular season · 7 games"
}

interface PeriodNavProps {
  periods: Period[]
  current: string
  noun: string // "week" or "night", for the button labels
  onChange: (key: string) => void
}

export function PeriodNav({ periods, current, noun, onChange }: PeriodNavProps) {
  const i = periods.findIndex((p) => p.key === current)
  const here = periods[i]
  const prev = periods[i - 1]
  const next = periods[i + 1]
  return (
    <nav className="week-nav" aria-label={noun}>
      <button type="button" className="icon-button" disabled={!prev} onClick={() => prev && onChange(prev.key)} aria-label={`Previous ${noun}`}>
        ‹
      </button>
      <div className="week-label">
        <select value={current} onChange={(e) => onChange(e.target.value)} aria-label={`Choose ${noun}`}>
          {periods.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        {here && <span className="week-dates">{here.detail}</span>}
      </div>
      <button type="button" className="icon-button" disabled={!next} onClick={() => next && onChange(next.key)} aria-label={`Next ${noun}`}>
        ›
      </button>
    </nav>
  )
}
