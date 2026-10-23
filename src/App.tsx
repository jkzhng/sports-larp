import { useCallback, useEffect, useState } from 'react'
import {
  fetchGames,
  fetchNbaGames,
  fetchNights,
  fetchWeeks,
  postRating,
  type GameCard as Game,
  type GamesResponse,
  type League,
  type ModelInfo,
  type NightsResponse,
  type Tier,
  type WeeksResponse,
} from './api.ts'
import { GameCard } from './components/GameCard.tsx'
import { PeriodNav, type Period } from './components/PeriodNav.tsx'
import { UpdateButton } from './components/UpdateButton.tsx'
import { readJson, writeJson } from './storage.ts'
import './App.css'

const LEAGUES: League[] = ['NFL', 'NBA']

const BLURBS: Record<League, Record<Tier, string>> = {
  NFL: { 'Must watch': 'The best of the week', 'Worth it': 'Good games if you have time', Skippable: 'Safe to skip' },
  NBA: { 'Must watch': 'Rare: about 2–3 a week', 'Worth it': 'Good games if you have time', Skippable: 'Safe to skip' },
}
const TIERS: Tier[] = ['Must watch', 'Worth it', 'Skippable']

// NFL play-by-play lands 35–75 min after the final whistle; ESPN's NBA data is
// there at the buzzer, so NBA games rank on the next ingest pass.
const AWAITING_BLURB: Record<League, string> = {
  NFL: 'Ranked once the play-by-play lands, usually within an hour',
  NBA: 'Ranked on the next update, usually within 15 minutes',
}

/** Weeks (NFL) or nights (NBA) of one season, in a common shape. */
interface Nav {
  league: League
  season: number
  periods: Period[]
  defaultKey: string | null
  model: ModelInfo
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const nightFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

function fromWeeks(w: WeeksResponse): Nav {
  return {
    league: 'NFL',
    season: w.season,
    periods: w.weeks.map((x) => ({
      key: String(x.week),
      label: x.label,
      detail: `${dayFormat.format(new Date(x.firstKickoff))} – ${dayFormat.format(new Date(x.lastKickoff))}`,
    })),
    defaultKey: w.defaultWeek === null ? null : String(w.defaultWeek),
    model: w.model,
  }
}

function fromNights(n: NightsResponse): Nav {
  return {
    league: 'NBA',
    season: n.season,
    periods: n.nights.map((x) => ({
      key: x.night,
      label: nightFormat.format(new Date(`${x.night}T12:00:00Z`)),
      detail: `${n.seasonLabel} ${x.phase.toLowerCase()} · ${x.games} ${x.games === 1 ? 'game' : 'games'}`,
    })),
    defaultKey: n.defaultNight,
    model: n.model,
  }
}

function modelStatus(m: ModelInfo): string {
  if (m.personalized) return `Personalized from ${m.ratingsUsed} of your ratings`
  if (m.ratings >= m.ratingsNeeded) return `${m.ratings} ratings in; personalizing on the next refit`
  return `Rate games you watch: ${m.ratings} of ${m.ratingsNeeded} to personalize`
}

function initialLeague(): League {
  const param = new URLSearchParams(window.location.search).get('league')?.toUpperCase()
  if (param === 'NFL' || param === 'NBA') return param
  return readJson<League>('league', 'NFL')
}

function App() {
  const [league, setLeague] = useState<League>(initialLeague)
  const [nav, setNav] = useState<Nav | null>(null)
  const [period, setPeriod] = useState<string | null>(null)
  const [data, setData] = useState<GamesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tipDismissed, setTipDismissed] = useState<boolean>(() => readJson('youtubeTipDismissed', false))
  const [showSkippable, setShowSkippable] = useState(false)
  const [watched, setWatched] = useState<string[]>(() => readJson('watched', []))
  const [revealed, setRevealed] = useState<string[]>(() => readJson('revealed', []))
  const [shieldOn, setShieldOn] = useState<boolean>(() => readJson('shield', false))
  const [shieldLifted, setShieldLifted] = useState(false)
  const [refreshes, setRefreshes] = useState(0) // bumped after an update to reload everything

  useEffect(() => {
    // `?season=2025` browses a past season; the default is the current one.
    const season = Number(new URLSearchParams(window.location.search).get('season')) || undefined
    let stale = false
    const load = league === 'NBA' ? fetchNights(season).then(fromNights) : fetchWeeks(season).then(fromWeeks)
    load
      .then((n) => {
        if (stale) return
        setNav(n)
        // After an update, stay on the week or night being viewed.
        setPeriod((p) => (p !== null && n.periods.some((x) => x.key === p) ? p : n.defaultKey))
      })
      .catch((e: Error) => !stale && setError(e.message))
    return () => {
      stale = true
    }
  }, [league, refreshes])

  useEffect(() => {
    if (!nav || period === null || nav.league !== league) return
    let stale = false
    const load = league === 'NBA' ? fetchNbaGames(period) : fetchGames(nav.season, Number(period))
    load.then((d) => !stale && setData(d)).catch((e: Error) => !stale && setError(e.message))
    return () => {
      stale = true
    }
  }, [nav, period, league])

  const markWatched = useCallback((id: string) => {
    setWatched((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id].slice(-500)
      writeJson('watched', next)
      return next
    })
  }, [])

  const changePeriod = (key: string) => {
    setPeriod(key)
    setData(null)
    setShowSkippable(false)
  }

  const changeLeague = (l: League) => {
    if (l === league) return
    writeJson('league', l)
    setLeague(l)
    setNav(null)
    setPeriod(null)
    setData(null)
    setError(null)
    setShowSkippable(false)
  }

  const refresh = useCallback(() => setRefreshes((n) => n + 1), [])

  const watch = useCallback((g: Game) => markWatched(g.id), [markWatched])

  const reveal = useCallback((g: Game) => {
    setRevealed((prev) => {
      if (prev.includes(g.id)) return prev
      const next = [...prev, g.id].slice(-500)
      writeJson('revealed', next)
      return next
    })
  }, [])

  // Optimistic: show the stars at once, roll back if the save fails.
  const rate = useCallback((g: Game, stars: number) => {
    const setRating = (value: number | null) =>
      setData((d) => d && { ...d, games: d.games.map((x) => (x.id === g.id ? { ...x, rating: value } : x)) })
    const bump = (by: number) => setNav((n) => n && { ...n, model: { ...n.model, ratings: n.model.ratings + by } })
    const firstRating = g.rating === null
    setRating(stars)
    if (firstRating) bump(1)
    postRating(g.id, stars).catch((e: Error) => {
      setRating(g.rating)
      if (firstRating) bump(-1)
      setError(`Couldn't save your rating (${e.message})`)
    })
  }, [])

  const dismissTip = () => {
    writeJson('youtubeTipDismissed', true)
    setTipDismissed(true)
  }

  const toggleShield = () => {
    writeJson('shield', !shieldOn)
    setShieldOn(!shieldOn)
    setShieldLifted(true)
  }

  if (shieldOn && !shieldLifted) {
    return (
      <div className="shield">
        <p>Spoiler shield is on.</p>
        <button type="button" className="watch" onClick={() => setShieldLifted(true)}>
          Show games
        </button>
      </div>
    )
  }

  const shown = data && data.league === league ? data : null
  const ranked = shown?.games.filter((g) => g.state === 'ranked') ?? []
  const awaiting = shown?.games.filter((g) => g.state === 'awaiting_data') ?? []
  const upcoming = shown?.games.filter((g) => g.state === 'upcoming') ?? []
  const rankOf = (g: Game) => ranked.indexOf(g) + 1
  const mustCount = ranked.filter((g) => g.tier === 'Must watch').length
  const noun = league === 'NBA' ? 'night' : 'week'

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Sports LARP</h1>
          <p className="tagline">The best games to watch, no spoilers.</p>
        </div>
        <div className="masthead-actions">
          <UpdateButton league={league} onUpdated={refresh} />
          <button type="button" className={`shield-toggle ${shieldOn ? 'on' : ''}`} onClick={toggleShield} aria-pressed={shieldOn}>
            Spoiler shield {shieldOn ? 'on' : 'off'}
          </button>
        </div>
      </header>

      <div className="league-switch" role="tablist" aria-label="League">
        {LEAGUES.map((l) => (
          <button key={l} type="button" role="tab" aria-selected={l === league} className={l === league ? 'on' : ''} onClick={() => changeLeague(l)}>
            {l}
          </button>
        ))}
      </div>

      {nav && nav.league === league && period !== null && (
        <PeriodNav periods={nav.periods} current={period} noun={noun} onChange={changePeriod} />
      )}
      {nav && nav.league === league && period === null && <p className="notice">No {league} games yet this season.</p>}

      {error && <p className="notice">Couldn't load games ({error}). Is the API running? Try `npm run api`.</p>}
      {!error && !shown && period !== null && <p className="notice">Loading…</p>}

      {shown && (
        <main>
          {ranked.length > 0 && (
            <p className="summary">
              {ranked.length} {ranked.length === 1 ? 'game' : 'games'} ranked · {mustCount} must watch
              {nav && <span className="model-status"> · {modelStatus(nav.model)}</span>}
            </p>
          )}

          {!tipDismissed && ranked.length > 0 && (
            <div className="tip">
              <p>
                Highlights open on YouTube. Its suggested videos and comments can show other scores, so go full screen and
                don't scroll down.
              </p>
              <button type="button" onClick={dismissTip}>
                Got it
              </button>
            </div>
          )}

          {TIERS.map((tier) => {
            const games = ranked.filter((g) => g.tier === tier)
            if (games.length === 0) return null
            const collapsed = tier === 'Skippable' && !showSkippable
            return (
              <section key={tier} className="tier-section">
                <div className="section-head">
                  <h2>
                    {tier} <span className="count">{games.length}</span>
                  </h2>
                  <span className="blurb">{BLURBS[league][tier]}</span>
                </div>
                {collapsed ? (
                  <button type="button" className="reveal-skippable" onClick={() => setShowSkippable(true)}>
                    Show {games.length} skippable {games.length === 1 ? 'game' : 'games'}
                  </button>
                ) : (
                  games.map((g) => (
                    <GameCard key={g.id} game={g} rank={rankOf(g)} watched={watched.includes(g.id)} onWatch={watch} revealed={revealed.includes(g.id)} onReveal={reveal} onRate={rate} />
                  ))
                )}
              </section>
            )
          })}

          {awaiting.length > 0 && (
            <section className="tier-section">
              <div className="section-head">
                <h2>
                  Just finished <span className="count">{awaiting.length}</span>
                </h2>
                <span className="blurb">{AWAITING_BLURB[league]}</span>
              </div>
              {awaiting.map((g) => (
                <GameCard key={g.id} game={g} watched={watched.includes(g.id)} onWatch={watch} revealed={revealed.includes(g.id)} onReveal={reveal} onRate={rate} />
              ))}
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="tier-section">
              <div className="section-head">
                <h2>
                  Upcoming <span className="count">{upcoming.length}</span>
                </h2>
              </div>
              <ul className="upcoming">
                {upcoming.map((g) => (
                  <li key={g.id}>
                    <strong>
                      {g.away.abbr} @ {g.home.abbr}
                    </strong>
                    <span>{g.slot}</span>
                    <span>
                      {new Date(g.kickoffAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      )}
    </div>
  )
}

export default App
