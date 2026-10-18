import { useState } from 'react'
import type { GameCard as Game } from '../api.ts'
import { RateGame } from './RateGame.tsx'
import { RevealPanel } from './RevealPanel.tsx'

const kickoffFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const TIER_CLASS = { 'Must watch': 'must', 'Worth it': 'worth', Skippable: 'skip' } as const

function Stars({ count }: { count: number }) {
  return (
    <span className="stars" aria-label={`${count} out of 5 stars`}>
      {'★'.repeat(count)}
      <span className="stars-empty">{'★'.repeat(5 - count)}</span>
    </span>
  )
}

function WatchButton({ game, onWatch }: { game: Game; onWatch: (g: Game) => void }) {
  const h = game.highlights
  if (!h) return null
  if (h.status === 'available') {
    // NFL blocks embedding on other sites, so highlights open on YouTube itself.
    return (
      <a
        className="watch"
        href={`https://www.youtube.com/watch?v=${h.videoId}`}
        target="_blank"
        rel="noreferrer"
        onClick={() => onWatch(game)}
      >
        ▶ Watch highlights
      </a>
    )
  }
  const label = {
    pending: 'Highlights coming soon',
    not_yet_available: 'Highlights not yet available',
    unavailable: 'No official highlights found',
  }[h.status]
  return <span className="watch-status">{label}</span>
}

interface GameCardProps {
  game: Game
  rank?: number
  watched: boolean
  revealed: boolean // revealed before; skip the confirmation
  onWatch: (g: Game) => void
  onReveal: (g: Game) => void
  onRate: (g: Game, stars: number) => void
}

export function GameCard({ game, rank, watched, revealed, onWatch, onReveal, onRate }: GameCardProps) {
  const tierClass = game.tier ? TIER_CLASS[game.tier] : 'none'
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)

  const reveal = () => {
    setConfirming(false)
    setOpen(true)
    onReveal(game)
  }
  return (
    <article className={`card tier-${tierClass}`}>
      {rank !== undefined && <div className="rank">{rank}</div>}
      <div className="card-body">
        <div className="card-top">
          <h3 className="matchup">
            <span title={game.away.name}>{game.away.abbr}</span>
            <span className="at">@</span>
            <span title={game.home.name}>{game.home.abbr}</span>
          </h3>
          {game.tier && <span className={`tier-badge ${tierClass}`}>{game.tier}</span>}
          {game.state === 'awaiting_data' && <span className="tier-badge none">Ranking soon</span>}
        </div>
        <p className="teams">
          {game.away.name} at {game.home.name}
        </p>
        <p className="meta">
          <span>{game.slot}</span>
          <span>{kickoffFormat.format(new Date(game.kickoffAt))}</span>
          {game.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </p>
        <div className="card-bottom">
          {game.stars !== null ? <Stars count={game.stars} /> : <span />}
          <div className="card-actions">
            {watched && <span className="watched">✓ Watched</span>}
            {game.state !== 'upcoming' && !confirming && (
              <button
                type="button"
                className="reveal-button"
                aria-expanded={open}
                onClick={() => (open ? setOpen(false) : revealed ? reveal() : setConfirming(true))}
              >
                {open ? 'Hide result' : 'Reveal'}
              </button>
            )}
            <WatchButton game={game} onWatch={onWatch} />
          </div>
        </div>
        {confirming && (
          <div className="confirm">
            <span>Show the final score and recap?</span>
            <button type="button" className="confirm-yes" onClick={reveal}>
              Show it
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Not yet
            </button>
          </div>
        )}
        {game.state !== 'upcoming' && (watched || revealed || open || game.rating !== null) && (
          <RateGame rating={game.rating} onRate={(stars) => onRate(game, stars)} />
        )}
        {open && <RevealPanel gameId={game.id} />}
      </div>
    </article>
  )
}
