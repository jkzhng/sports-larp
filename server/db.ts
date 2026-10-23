import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config.ts'
import type { HighlightCandidateGame, Upload } from './highlights.ts'
import type { NbaHighlightCandidate } from './nba/highlights.ts'
import type { Recap } from './recap.ts'
import type { SignalName, TierCutoffs } from './scoring/model.ts'
import type { RawSignals, ScoringModel, WatchScore } from './scoring/score.ts'
import type { Stakes } from './scoring/stakes.ts'
import type { NbaGame } from './sources/espn.ts'
import type { RatedGame, ReferenceGame } from './tuning.ts'
import { PLAY_COLUMNS, type Play, type ScheduleGame } from './types.ts'

// Spoiler boundary: `games` holds only what is known before kickoff. Final scores
// live in `recaps`, which only the reveal endpoint may read.
const SCHEMA = `
create table if not exists games (
  id           text primary key,
  league       text not null,
  season       integer not null,
  game_type    text not null,
  week         integer not null,
  kickoff_at   text not null,            -- ISO 8601 UTC
  weekday      text not null,
  home_team    text not null,
  away_team    text not null,
  status       text not null,            -- scheduled | final
  stakes_tags  text not null default '[]', -- JSON: division, primetime, race, playoff
  night        text                      -- NBA: the US date the game is grouped under
);
create index if not exists games_week on games (league, season, week);

create table if not exists plays (
  game_id                text not null,
  seq                    integer not null,
  qtr                    integer,
  game_seconds_remaining real,
  posteam                text,
  play_type              text,
  yards_gained           real,
  sack                   integer,
  touchdown              integer,
  td_team                text,
  special_teams_play     integer,
  interception           integer,
  fumble_lost            integer,
  fourth_down_failed     integer,
  home_wp                real,
  vegas_home_wp          real,
  wpa                    real,
  total_home_score       integer,
  total_away_score       integer,
  "desc"                 text,
  -- Recap-only columns (key moments, talking points, chart clock).
  quarter_seconds_remaining real,
  defteam                text,
  passer_player_name     text,
  receiver_player_name   text,
  rusher_player_name     text,
  passing_yards          real,
  receiving_yards        real,
  rushing_yards          real,
  complete_pass          integer,
  pass_attempt           integer,
  rush_attempt           integer,
  pass_touchdown         integer,
  rush_touchdown         integer,
  two_point_attempt      integer,
  interception_player_name text,
  sack_player_name       text,
  half_sack_1_player_name text,
  half_sack_2_player_name text,
  primary key (game_id, seq)
);

create table if not exists watch_scores (
  game_id        text not null,
  model_version  text not null,
  total          real not null,
  tier           text not null,
  stars          integer not null,
  signals        text not null,          -- JSON: { raw, pct }
  scored_at      text not null,
  primary key (game_id, model_version)
);

create table if not exists recaps (
  game_id         text primary key,
  home_score      integer not null,
  away_score      integer not null,
  overtime        integer not null default 0, -- overtime periods played: 0, 1 (OT), 2 (2OT), ...
  key_moments     text not null default '[]', -- JSON: KeyMoment[]
  talking_points  text not null default '[]', -- JSON: string[]
  wp_series       text not null default '[]', -- JSON: [elapsedSeconds, homeWp][]
  built_at        text
);

-- Official highlight video per game. Source titles and thumbnails are never
-- stored: they often carry the score.
create table if not exists highlight_videos (
  game_id       text primary key,
  provider      text not null,           -- youtube
  video_id      text not null,
  channel_id    text not null,
  published_at  text not null,
  matched_by    text not null,           -- how it was found, e.g. nfl-uploads-title
  matched_at    text not null
);

create table if not exists source_state (
  key    text primary key,
  value  text not null
);

-- The user's 1-5 star rating of a game, given after watching or revealing it.
create table if not exists ratings (
  user_id                  text not null default 'local',
  game_id                  text not null,
  stars                    integer not null check (stars between 1 and 5),
  rated_at                 text not null,
  model_version_at_rating  text not null,
  primary key (user_id, game_id)
);

-- Scoring weights: the starting set plus each set fitted from ratings.
-- Exactly one row is active; scores are stored under its version.
create table if not exists weight_sets (
  version        text primary key,
  weights        text not null,          -- JSON: { signal: weight }
  cutoffs        text not null,          -- JSON: [[cutoff, tier], ...]
  ratings_used   integer not null default 0,
  fitted_share   real not null default 0, -- share of fitted weights in the blend
  holdout_new    real,                    -- concordance on the holdout ratings
  holdout_prev   real,
  created_at     text not null,
  active         integer not null default 0
);
`

// Bump on any schema change. New tables only need the bump (SCHEMA creates
// them). Changed columns on a derived table also need a step below that drops
// it and forgets upstream state, so the next ingest rebuilds it from nflverse.
// Never drop `ratings` or `weight_sets`: they can't be rebuilt.
const SCHEMA_VERSION = 5

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('pragma user_version').get() as { user_version: number }
  if (version === SCHEMA_VERSION) return
  if (version > 0 && version < 2) {
    db.exec(`drop table if exists plays; drop table if exists recaps; delete from source_state;`)
    console.log(`database schema ${version} -> ${SCHEMA_VERSION}: plays and recaps will be rebuilt on the next ingest`)
  }
  if (version > 0 && version < 4) db.exec('alter table games add column night text')
  if (version > 0 && version < 5) countOvertimes(db)
  db.exec(SCHEMA)
  db.exec('create index if not exists games_night on games (league, season, night)')
  db.exec(`pragma user_version = ${SCHEMA_VERSION}`)
}

/**
 * Schema 5: `recaps.overtime` holds the number of overtime periods instead of
 * a 0/1 flag. NFL counts come from the stored plays; NBA ones from where the
 * win-probability series ends (regulation is 48 minutes, each OT 5).
 */
function countOvertimes(db: DatabaseSync): void {
  db.exec(`
    update recaps set overtime = (select max(qtr) - 4 from plays p where p.game_id = recaps.game_id)
    where overtime = 1 and exists (select 1 from plays p where p.game_id = recaps.game_id and p.qtr > 5)`)
  const nba = db
    .prepare(`select r.game_id, r.wp_series from recaps r join games g on g.id = r.game_id where g.league = 'NBA' and r.overtime = 1`)
    .all() as { game_id: string; wp_series: string }[]
  const stmt = db.prepare('update recaps set overtime = ? where game_id = ?')
  for (const r of nba) {
    const end = (JSON.parse(r.wp_series) as [number, number][]).at(-1)?.[0] ?? 0
    if (end > 2880) stmt.run(Math.ceil((end - 2880) / 300), r.game_id)
  }
}

export function openDb(path = DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma busy_timeout = 5000') // the API writes ratings while an ingest child may be writing
  db.exec('create table if not exists source_state (key text primary key, value text not null)')
  // Databases made before versioning report 0 but already have tables.
  const hasTables = db.prepare("select 1 from sqlite_master where name = 'plays'").get() !== undefined
  if (hasTables && (db.prepare('pragma user_version').get() as { user_version: number }).user_version === 0) {
    db.exec('pragma user_version = 1')
  }
  migrate(db)
  return db
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('begin')
  try {
    const out = fn()
    db.exec('commit')
    return out
  } catch (err) {
    db.exec('rollback')
    throw err
  }
}

export function getState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('select value from source_state where key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare('insert into source_state (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    key,
    value,
  )
}

/** Kickoff in Eastern time (as nflverse publishes it) to an ISO UTC timestamp. */
export function kickoffUtc(gameday: string, gametime: string): string {
  const asUtc = new Date(`${gameday}T${gametime}:00Z`)
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(asUtc)
    .find((p) => p.type === 'timeZoneName')!.value // e.g. GMT-04:00
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(offset)
  const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
  return new Date(asUtc.getTime() - minutes * 60_000).toISOString()
}

export function upsertGames(db: DatabaseSync, games: ScheduleGame[], stakes: Map<string, Stakes>): void {
  const stmt = db.prepare(`
    insert into games (id, league, season, game_type, week, kickoff_at, weekday, home_team, away_team, status, stakes_tags)
    values (?, 'NFL', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set
      game_type = excluded.game_type, week = excluded.week, kickoff_at = excluded.kickoff_at,
      weekday = excluded.weekday, status = excluded.status, stakes_tags = excluded.stakes_tags`)
  const recap = db.prepare(`
    insert into recaps (game_id, home_score, away_score) values (?, ?, ?)
    on conflict (game_id) do update set home_score = excluded.home_score, away_score = excluded.away_score`)
  transaction(db, () => {
    for (const g of games) {
      const s = stakes.get(g.game_id)
      const tags = s ? (['division', 'primetime', 'race', 'playoff'] as const).filter((t) => s[t]) : []
      const final = g.result !== null
      stmt.run(g.game_id, g.season, g.game_type, g.week, kickoffUtc(g.gameday, g.gametime), g.weekday,
        g.home_team, g.away_team, final ? 'final' : 'scheduled', JSON.stringify(tags))
      if (final && g.home_score !== null && g.away_score !== null) recap.run(g.game_id, g.home_score, g.away_score)
    }
  })
}

/** NBA games (ESPN). `week` is unused (0); games are grouped by `night`. */
export function upsertNbaGames(db: DatabaseSync, games: NbaGame[], tags: Map<string, string[]>): void {
  const stmt = db.prepare(`
    insert into games (id, league, season, game_type, week, kickoff_at, weekday, home_team, away_team, status, stakes_tags, night)
    values (?, 'NBA', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set
      game_type = excluded.game_type, kickoff_at = excluded.kickoff_at, weekday = excluded.weekday,
      status = excluded.status, stakes_tags = excluded.stakes_tags, night = excluded.night`)
  const recap = db.prepare(`
    insert into recaps (game_id, home_score, away_score) values (?, ?, ?)
    on conflict (game_id) do update set home_score = excluded.home_score, away_score = excluded.away_score`)
  transaction(db, () => {
    for (const g of games) {
      const tipoff = new Date(g.tipoff)
      const weekday = tipoff.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' })
      stmt.run(g.game_id, g.season, g.season_type, tipoff.toISOString(), weekday, g.home_team, g.away_team,
        g.completed ? 'final' : 'scheduled', JSON.stringify(tags.get(g.game_id) ?? []), g.night)
      if (g.completed && g.home_score !== null && g.away_score !== null) recap.run(g.game_id, g.home_score, g.away_score)
    }
  })
}

/** Raw signals of every game already scored under a model version, so a pass only parses new games. */
export function storedRawSignals<S extends string>(db: DatabaseSync, modelVersion: string): Map<string, RawSignals<S>> {
  const rows = db.prepare('select game_id, signals from watch_scores where model_version = ?').all(modelVersion) as {
    game_id: string
    signals: string
  }[]
  return new Map(rows.map((r) => [r.game_id, (JSON.parse(r.signals) as { raw: RawSignals<S> }).raw]))
}

/** NBA final games from `since` on with no highlight video yet. */
export function nbaGamesNeedingHighlights(db: DatabaseSync, since: Date): (NbaHighlightCandidate & { kickoff_at: string })[] {
  return db
    .prepare(
      `select id, night, home_team, away_team, kickoff_at from games
       where league = 'NBA' and status = 'final' and kickoff_at >= ?
         and id not in (select game_id from highlight_videos)
       order by kickoff_at`,
    )
    .all(since.toISOString()) as unknown as (NbaHighlightCandidate & { kickoff_at: string })[]
}

const STORED_PLAY_COLUMNS = ['seq', ...PLAY_COLUMNS] as const

/** Replace every play for the given games with a fresh copy. */
export function replacePlays(db: DatabaseSync, plays: Play[]): void {
  const gameIds = [...new Set(plays.map((p) => p.game_id))]
  const del = db.prepare('delete from plays where game_id = ?')
  const ins = db.prepare(
    `insert into plays (${STORED_PLAY_COLUMNS.map((c) => `"${c}"`).join(', ')})
     values (${STORED_PLAY_COLUMNS.map(() => '?').join(', ')})`,
  )
  transaction(db, () => {
    for (const id of gameIds) del.run(id)
    for (const p of plays) ins.run(...STORED_PLAY_COLUMNS.map((c) => p[c]))
  })
}

export function upsertRecaps(db: DatabaseSync, recaps: Map<string, Recap>, builtAt: string): void {
  const stmt = db.prepare(`
    update recaps set overtime = ?, key_moments = ?, talking_points = ?, wp_series = ?, built_at = ?
    where game_id = ?`)
  transaction(db, () => {
    for (const [gameId, r] of recaps) {
      stmt.run(r.overtime, JSON.stringify(r.keyMoments), JSON.stringify(r.talkingPoints), JSON.stringify(r.wp), builtAt, gameId)
    }
  })
}

export interface RevealRow {
  id: string
  league: string
  game_type: string
  home_team: string
  away_team: string
  home_score: number
  away_score: number
  overtime: number
  key_moments: string
  talking_points: string
  wp_series: string
  total: number | null
  tier: string | null
  signals: string | null
}

/** Everything the reveal endpoint shows. Null unless the game is final. */
export function getRevealRow(db: DatabaseSync, gameId: string, modelVersion: string): RevealRow | null {
  const row = db
    .prepare(
      `select g.id, g.league, g.game_type, g.home_team, g.away_team, r.home_score, r.away_score, r.overtime,
              r.key_moments, r.talking_points, r.wp_series, w.total, w.tier, w.signals
       from games g
       join recaps r on r.game_id = g.id
       left join watch_scores w on w.game_id = g.id and w.model_version = ?
       where g.id = ? and g.status = 'final'`,
    )
    .get(modelVersion, gameId) as RevealRow | undefined
  return row ?? null
}

/** Plays for the given seasons, grouped by game, each in published order. */
export function loadPlays(db: DatabaseSync, seasons: number[]): Map<string, Play[]> {
  const rows = db
    .prepare(
      `select p.* from plays p join games g on g.id = p.game_id
       where g.season in (${seasons.map(() => '?').join(', ')}) order by p.game_id, p.seq`,
    )
    .all(...seasons) as unknown as Play[]
  const out = new Map<string, Play[]>()
  for (const r of rows) {
    const list = out.get(r.game_id)
    if (list) list.push(r)
    else out.set(r.game_id, [r])
  }
  return out
}

/** Final games that kicked off since `since` and have no highlight video yet. */
export function gamesNeedingHighlights(db: DatabaseSync, since: Date): HighlightCandidateGame[] {
  return db
    .prepare(
      `select id, season, game_type, week, home_team, away_team, kickoff_at from games
       where league = 'NFL' and status = 'final' and kickoff_at >= ?
         and id not in (select game_id from highlight_videos)
       order by kickoff_at`,
    )
    .all(since.toISOString()) as unknown as HighlightCandidateGame[]
}

export function insertHighlights(db: DatabaseSync, matches: Map<string, Upload>, matchedBy: string, matchedAt: string): void {
  const stmt = db.prepare(`
    insert into highlight_videos (game_id, provider, video_id, channel_id, published_at, matched_by, matched_at)
    values (?, 'youtube', ?, ?, ?, ?, ?) on conflict (game_id) do nothing`)
  transaction(db, () => {
    for (const [gameId, u] of matches) stmt.run(gameId, u.videoId, u.channelId, u.publishedAt, matchedBy, matchedAt)
  })
}

// ---------------------------------------------------------------- ratings and weights

export function upsertRating(db: DatabaseSync, gameId: string, stars: number, ratedAt: string, modelVersion: string): void {
  db.prepare(`
    insert into ratings (game_id, stars, rated_at, model_version_at_rating) values (?, ?, ?, ?)
    on conflict (user_id, game_id) do update set
      stars = excluded.stars, rated_at = excluded.rated_at, model_version_at_rating = excluded.model_version_at_rating`).run(
    gameId,
    stars,
    ratedAt,
    modelVersion,
  )
}

export function ratingCount(db: DatabaseSync, league = 'NFL'): number {
  return (
    db.prepare('select count(*) as n from ratings r join games g on g.id = r.game_id where g.league = ?').get(league) as { n: number }
  ).n
}

/**
 * Ratings with each game's signal percentiles (weight-independent), oldest
 * first. The model version picks the league: NBA games have no nfl-* scores.
 */
export function ratedGames<S extends string = SignalName>(db: DatabaseSync, baseVersion: string): RatedGame<S>[] {
  const rows = db
    .prepare(
      `select r.stars, w.signals from ratings r
       join watch_scores w on w.game_id = r.game_id and w.model_version = ?
       order by r.rated_at, r.game_id`,
    )
    .all(baseVersion) as { stars: number; signals: string }[]
  return rows.map((r) => {
    const { raw, pct } = JSON.parse(r.signals) as { raw: { big_moment: boolean }; pct: RatedGame<S>['pct'] }
    return { stars: r.stars, pct, bigMoment: raw.big_moment }
  })
}

/** Monday of a night's week (YYYY-MM-DD), as the notebook's `week_of`. */
export function weekOf(night: string): string {
  const d = new Date(`${night}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** Reference-season games with percentiles, for calibrating tier cutoffs. NBA games are grouped into weeks by night. */
export function referenceGames<S extends string = SignalName>(db: DatabaseSync, baseVersion: string, seasons: number[]): ReferenceGame<S>[] {
  const rows = db
    .prepare(
      `select g.season, g.week, g.night, g.game_type, w.signals from watch_scores w
       join games g on g.id = w.game_id
       where w.model_version = ? and g.season in (${seasons.map(() => '?').join(', ')})`,
    )
    .all(baseVersion, ...seasons) as { season: number; week: number; night: string | null; game_type: string; signals: string }[]
  return rows.map((r) => {
    const { raw, pct } = JSON.parse(r.signals) as { raw: { big_moment: boolean }; pct: ReferenceGame<S>['pct'] }
    const week = r.night ? weekOf(r.night) : `${r.season}-${r.week}`
    return { week, regular: r.game_type === 'REG', pct, bigMoment: raw.big_moment }
  })
}

export interface WeightSet<S extends string = SignalName> extends ScoringModel<S> {
  ratingsUsed: number
  fittedShare: number
  createdAt: string
}

interface WeightSetRow {
  version: string
  weights: string
  cutoffs: string
  ratings_used: number
  fitted_share: number
  created_at: string
}

const toWeightSet = <S extends string>(r: WeightSetRow): WeightSet<S> => ({
  version: r.version,
  weights: JSON.parse(r.weights) as Record<S, number>,
  cutoffs: JSON.parse(r.cutoffs) as TierCutoffs,
  ratingsUsed: r.ratings_used,
  fittedShare: r.fitted_share,
  createdAt: r.created_at,
})

/**
 * The weight set scores are shown under. Fitted sets belong to the model
 * version they were fitted on; after a model change they no longer apply and
 * the starting weights take over until the next refit.
 */
export function activeWeightSet<S extends string = SignalName>(db: DatabaseSync, base: ScoringModel<S>): WeightSet<S> {
  const row = db
    .prepare(`select * from weight_sets where active = 1 and (version = ? or version like ? || '+w%')`)
    .get(base.version, base.version) as WeightSetRow | undefined
  return row ? toWeightSet<S>(row) : { ...base, ratingsUsed: 0, fittedShare: 0, createdAt: '' }
}

/** Fitted sets for a model version, newest first. */
export function fittedWeightSets<S extends string = SignalName>(db: DatabaseSync, baseVersion: string): WeightSet<S>[] {
  const rows = db
    .prepare(`select * from weight_sets where version like ? || '+w%' order by created_at desc`)
    .all(baseVersion) as unknown as WeightSetRow[]
  return rows.map((r) => toWeightSet<S>(r))
}

/** Make a set the active one for its league (the version prefix, nfl- or nba-). Other leagues' sets are untouched. */
export function activateWeightSet<S extends string>(
  db: DatabaseSync,
  set: WeightSet<S>,
  holdout: { candidate: number; previous: number } | null,
): void {
  const league = set.version.slice(0, set.version.indexOf('-') + 1)
  transaction(db, () => {
    db.prepare(`update weight_sets set active = 0 where version like ? || '%'`).run(league)
    db.prepare(`
      insert into weight_sets (version, weights, cutoffs, ratings_used, fitted_share, holdout_new, holdout_prev, created_at, active)
      values (?, ?, ?, ?, ?, ?, ?, ?, 1)
      on conflict (version) do update set active = 1`).run(
      set.version,
      JSON.stringify(set.weights),
      JSON.stringify(set.cutoffs),
      set.ratingsUsed,
      set.fittedShare,
      holdout?.candidate ?? null,
      holdout?.previous ?? null,
      set.createdAt,
    )
  })
}

export function gamesWithPlays(db: DatabaseSync): Set<string> {
  const rows = db.prepare('select distinct game_id from plays').all() as { game_id: string }[]
  return new Set(rows.map((r) => r.game_id))
}

export function hasScores(db: DatabaseSync, modelVersion: string): boolean {
  return db.prepare('select 1 from watch_scores where model_version = ? limit 1').get(modelVersion) !== undefined
}

export function upsertScores<S extends string>(db: DatabaseSync, scores: WatchScore<S>[], scoredAt: string): void {
  const stmt = db.prepare(`
    insert into watch_scores (game_id, model_version, total, tier, stars, signals, scored_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict (game_id, model_version) do update set
      total = excluded.total, tier = excluded.tier, stars = excluded.stars,
      signals = excluded.signals, scored_at = excluded.scored_at`)
  transaction(db, () => {
    for (const s of scores) {
      stmt.run(s.game_id, s.model_version, s.total, s.tier, s.stars, JSON.stringify({ raw: s.raw, pct: s.pct }), scoredAt)
    }
  })
}
