import { useState } from 'react'

interface RateGameProps {
  rating: number | null
  onRate: (stars: number) => void
}

/** "How was it?" 1-5 stars, shown after a game is watched or revealed. */
export function RateGame({ rating, onRate }: RateGameProps) {
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? rating ?? 0
  return (
    <div className="rate" onMouseLeave={() => setHover(null)}>
      <span className="rate-label">{rating ? 'Your rating' : 'How was it?'}</span>
      <span className="rate-stars" role="radiogroup" aria-label="Rate this game">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            className={n <= shown ? 'on' : ''}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onBlur={() => setHover(null)}
            onClick={() => onRate(n)}
          >
            ★
          </button>
        ))}
      </span>
    </div>
  )
}
