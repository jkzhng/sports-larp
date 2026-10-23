# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Milestones 1–6 are built for the NFL: the scoring notebook, the ingestion job, highlight matching, the spoiler-safe ranked week UI, reveal with talking points, and ratings with weight tuning. The NBA has all six too: notebook, TypeScript port (`server/nba/`), ESPN ingestion, highlight matching, the UI's NFL | NBA switch with nights instead of weeks, reveal, and weight tuning from its own ratings. Soccer comes after.

The full product spec is at https://claude.ai/code/artifact/f12b8ba8-3a1c-418e-929a-a3dfdb48e0ca. The requirements below are the ones code must respect.

## Product requirements

A personal web app. It ranks recently finished games by how worth watching they are, without revealing results, and links only to official highlight videos. The NFL comes first, then the NBA, then soccer (Premier League first).

### Spoiler safety (hard rule)

- Before the user taps **Reveal**, never show the score, the winner, overtime status, records updated after the game, player stats, or excitement tags such as "comeback". Never show a video's source title, thumbnail or exact duration.
- The list endpoint (`GET /games`) returns only matchup, kickoff, tier, pre-game tags, the video link and the user's own rating. No watchability stars: within a tier they hint at the result (a 4-star game with a big deficit means no comeback). Scores, key moments, talking points and signal breakdowns come only from `GET /games/:id/reveal`. Keep this split in the API, not only in the UI.
- Pre-game tags only: division rivalry, playoff implications, primetime (NFL); playoff round and game number, Play-In, NBA Cup knockout, playoff race, top teams, national TV (NBA).
- Highlights open on youtube.com in a new tab, and the UI shows a one-time tip about spoilers there. Embedding is not an option: every NFL video returns IFrame error 150 off approved domains, even though the Data API reports `embeddable: true`. Opening `/embed/ID` directly returns error 153. Both were tested 2026-10-17.
- The UI (`src/`) reads only `GET /api/weeks`, `GET /api/nights` and `GET /api/games` (`?season=&week=` or `?league=NBA&night=`) (`server/queries.ts`, response types in `server/api-types.ts`, shared with `src/` through type-only imports). `server/queries.test.ts` checks that the list response never has score, result, total or signal fields. Keep that test passing.
- Per-browser state lives in `localStorage` through `src/storage.ts`: watched games, revealed games, the spoiler shield, the dismissed YouTube tip and the chosen league. `?league=nba` in the URL picks the league. Every access is wrapped in try/catch.
- Reveal: `GET /api/games/:id/reveal` (`revealGame` in `server/queries.ts`) is the only route that returns spoilers. The UI calls it only after a two-step Reveal; a game revealed before skips the confirmation. `?season=2025` in the UI URL browses a past season, which is the safe way to test reveal without spoiling the current one. The score line reads "Final (OT)", "Final (2OT)" and so on from `overtimes`, the number of overtime periods.
- Recaps (`server/recap.ts`) are built for every final game during the scoring step and stored in `recaps`: key moments, talking points (fixed templates) and the spread-adjusted WP series for the chart.
    - Key-moment swings run from a play to the next snap (pass, run, field goal or punt), so a touchdown carries its extra point and kickoff.
    - nflverse WP is unreliable across extra points, two-point tries and kickoffs, especially in overtime. When a play changes the score, its swing is forced toward the team that scored.
    - Talking points: the passing, rushing and receiving leaders, then the first match among a turnover margin of 2+, a defensive player with 2+ sacks or interceptions, a yardage edge of 150+, and otherwise the biggest play.
- `server/db.ts` has `SCHEMA_VERSION` (SQLite `user_version`, currently 5; 4 added `games.night`, 5 made `recaps.overtime` a count of overtime periods, migrated in place by `countOvertimes`). Bump it on every schema change. New tables need only the bump. Changed columns on a derived table (`plays`, `recaps`) also need a step in `migrate()` that drops it and clears `source_state`, so the next `npm run ingest` re-downloads and rebuilds it.

### Highlights

- Accept a video only from an allow-listed channel ID: the NFL YouTube channel or one of the 32 team channels. Prefer the NFL channel's "Game Highlights" upload.
- Search once per finished game and cache the result permanently, because the YouTube Data API has a daily quota.
- Implementation (`server/highlights.ts`, `server/sources/youtube.ts`):
    - Every pass reads the NFL channel's uploads playlist (`playlistItems`, 1 quota unit per 50 videos, never `search` at 100 units) back to the oldest final game from the last 14 days that has no video yet. That's at most 20 pages, which covers about 700 NFL uploads in two weeks.
    - Titles look like "Buffalo Bills vs Los Angeles Rams Game Highlights | 2026 NFL Season Week 5". The season/week phrasing varies and titles contain typos, so team names match by nickname with one typo allowed (`server/teams.ts`).
    - A video matches when both teams appear, it was published 0–4 days after kickoff, and the season and week agree when the title states them.
    - Team-channel fallback is not built yet. `ALLOWED_CHANNELS` holds only the NFL channel.
- If no official video exists after 24 hours, show "Highlights not yet available". The game stays ranked.

### NFL watchability score (0 to 100)

`W = 100 · Σ wᵢ · pctᵢ(xᵢ)`. Here pct is a signal's percentile against the last three seasons, and the weights sum to 1. The weights favor action: 0.42 for drama and 0.58 for action. Late closeness is weighted low because it moves almost in lockstep with the excitement index (Spearman correlation 0.88).

| Signal | Raw measure | Weight |
| --- | --- | --- |
| Excitement index | Sum of absolute win-probability (WP) changes across all plays | 0.20 |
| Late-game closeness | Minutes in Q4 and OT within 8 points, plus a bonus if the lead changed in Q4 | 0.07 |
| Comeback size | 1 minus the eventual winner's minimum spread-adjusted WP (nflverse `vegas_home_wp`), so upsets count | 0.15 |
| Explosive plays | Passes of 20+ yards plus runs of 15+ yards, with touchdowns of 40+ yards counted twice | 0.22 |
| Touchdowns | All touchdowns (offense, defense, special teams) | 0.18 |
| Turnovers | Interceptions, lost fumbles and turnovers on downs, weighted by each play's WP change | 0.10 |
| Stakes | Playoff game, division game, playoff-race leverage, primetime | 0.08 |

- Tiers: **Must watch** at 67 or above, **Worth it** at 45 to 66, **Skippable** below 45. The Must-watch cutoff targets about 3 games per regular-season week. Recalibrate it whenever the weights change.
- Blowouts are not penalized. Count only plays after the game is decided (final 5 minutes with the leader's WP above 99%) at 0.5×.
- Add a flat +5 for a walk-off score, a game-winning drive in the final 2:00, or a defensive or special-teams touchdown in Q4. Cap the total at 100.
- Store every score with a `model_version`.

### NBA watchability score (`nba-v0.1`)

- Source: ESPN's unofficial site API, behind its own adapter. The scoreboard (`/scoreboard?dates=YYYYMMDD`, one call per date; date ranges return nothing) gives the schedule, `season.type` (2 regular, 3 playoffs, 5 play-in), `notes` (playoff round and game number, NBA Cup stage) and national TV. The game summary (`/summary?event=ID`) gives plays, per-play `winprobability` and the box score. ESPN was chosen on purpose: `cdn.nba.com` returns 403 and `stats.nba.com` times out from this machine, and sportsdataverse's NBA play-by-play has no win probability and updates only in the offseason.
- ESPN's WP starts from a pregame prior, so it already counts upsets, as `vegas_home_wp` does for the NFL.
- Seasons are named by their start year (2025 = 2025-26), like nflverse; ESPN names them by the year they end. The reference is 2023-24 to 2025-26 (3,956 games; a few summaries 404 and are skipped).
- Signals and weights: excitement 0.20, late closeness 0.07 (Q4 and OT minutes within 5 points, plus 1 minute per Q4/OT lead change), comeback 0.15, highlight plays 0.20 (made dunks and alley-oops, blocks, made threes from 30+ ft, and-ones), scoring 0.10 (combined points), star 0.16 (best player's points, plus 10 for a triple-double), stakes 0.12 (playoffs 1.0, Finals or Game 7 1.2, play-in and NBA Cup knockout 0.8, Cup final 1.0; otherwise national TV 0.35, both teams .600+ 0.25, both .500+ with 55+ games played 0.40).
- Garbage time and the +5 bonus work as for the NFL. The bonus is for the winner going ahead for good in the last 24 s of Q4 or OT, or a shot in the last 3 s that ties the game and forces OT.
- Tiers: Must watch at 78 or above (about 2.4 per week, which is the user's target of 2–3 a week, not per night), Worth it at 60 or above (about 1.8 per night). Fitted NBA weight sets recalibrate Must watch to 2.5 a week (`MUST_WATCH_PER_WEEK` in `nba/model.ts`), with weeks Monday to Sunday by night (`weekOf`, the notebook's `week_of`). The UI groups NBA games by night (the US date of the scoreboard), not by week.
- Playoff stakes don't need special handling: a playoff night only holds playoff games, so they're compared with each other (the user's call).
- `excitement`, `late_closeness` and `comeback` are rounded to 6 decimals (`SIGNAL_DECIMALS`) in both ports. pandas adds floats in a different order than JavaScript, and unrounded sums broke percentile ties differently (0.1-point gaps in 12 games).
- Implementation (`server/nba/`): `model.ts` (weights, constants, `currentNbaSeason`: August starts a new season), `signals.ts` (port of `plays_frame`, `box_players`, `game_signals`), `stakes.ts` (records entering each game; upcoming games use every earlier result so their tags don't change once final), `recap.ts`, `highlights.ts`, `teams.ts`, `ingest.ts`. The ESPN adapter is `server/sources/espn.ts`.
- Ingestion (`runNbaIngest`, after the NFL pass): the schedule from per-date scoreboards for the 3 reference seasons plus the current one, up to 7 days ahead. Postponed and canceled events (state `post`, not completed) are dropped; ESPN lists the rescheduled game as a new event. Then summaries for newly final games, then scoring. Raw signals of games already scored are read back from `watch_scores`, so a pass only parses new summaries (about 20 s). Recaps are built only for newly scored games, so a recap change needs `npm run ingest -- --league nba --force` (about 80 s). Games ESPN 404s, or whose summary has no win probability, are remembered in `source_state` (`espn_nba_missing_summaries`) once 2 days old.
- `games` rows for the NBA have `league = 'NBA'`, `week = 0` and `night` set. `stakes_tags` holds display labels (`nbaTags`): playoff round and game number, Play-In, NBA Cup knockout or final, Playoff race or Top teams, and national TV networks. NFL rows hold tag keys mapped through `TAG_LABELS`.
- Key moments are the biggest WP swings credited to shots and turnovers. ESPN moves WP on fouls and rebounds too, so each swing runs from the previous shot or turnover, and a foul's swing lands on its free throws. Each moment's text ends with the score after it.
- Talking points: the top scorer on each team (winner first), then the first of: another triple-double, another 40-point game, a comeback of 15+, a threes edge of 8+, a rebounding edge of 12+.
- Highlights: the NBA channel (`NBA_CHANNEL_ID`, allow-listed) titles full games as "AWAY at HOME | FULL GAME HIGHLIGHTS | October 16, 2026". Playoffs use "FULL GAME 7 HIGHLIGHTS" or "NBA FINALS GAME 7 HIGHLIGHTS", Cup games add an "EMIRATES NBA CUP" segment, seeds appear as "#4". The title's date must equal the game's night. "EXTENDED:" cuts are used only when no regular cut exists. Preseason and series recaps are ignored. Reading 14 days of uploads takes up to 30 pages, since the NBA posts about 50 a day.
- API: `GET /api/nights?season=` (`listNights`), and `GET /api/games?league=NBA&night=YYYY-MM-DD` (`listNbaGames`). Reveal works for both leagues by id. `server/nba/nba.test.ts` holds the NBA spoiler check alongside title parsing, signals, recap and tag tests.

### Learning from ratings

- After the user watches or reveals a game, ask for a 1 to 5 star rating. Store it with the game's signal percentiles.
- Use the starting weights until about 20 games are rated. After that, refit weekly with a constrained regression (weights non-negative and summing to 1). Blend the fitted weights with the defaults, about 50/50 at 20 ratings and 80/20 at 60.
- Save each refit as a new `model_version`. Keep the new weights only if they rank the 10 most recent ratings at least as well as the previous set.
- Each league learns from its own ratings, on its own schedule. A rating belongs to a league through the `watch_scores` version it joins (`ratedGames`).
- Implementation:
    - `server/tuning.ts` holds the pure math, generic over a model's signals (the keys of its weights). `fitWeights` is exact non-negative ridge least squares over all 128 subsets of the 7 signals. Also `concordance` (holdout metric), `fittedShare`/`blend`, and `calibrateCutoffs` (the league's Must-watch target per week; Skippable keeps its share under the starting weights).
    - `server/refit.ts` is the job, called from each league's ingest pass after scoring, with `NFL_REFIT` or `NBA_REFIT`. Attempts are gated by `refit_attempted_*` (NFL) and `nba_refit_attempted_*` in `source_state`.
    - Fitted sets are stored in `weight_sets` as `nfl-v0.3+wN` or `nba-v0.1+wN`, with exactly one active per league (`activateWeightSet` only deactivates sets with the same `nfl-`/`nba-` prefix). A set only applies to the `MODEL_VERSION` it was fitted on; after a model bump, the starting weights apply until the next refit.
    - Scoring always writes the starting-weight version (refit percentiles, notebook parity) plus the active set, in both leagues. The API reads the active set (`activeWeightSet`). After an NBA refit is adopted, the pass re-scores from stored raw signals, so it needs no summaries.
- Ratings: `POST /api/games/:id/rating` with `{"stars": 1-5}`, final games only, stored in `ratings`. Never drop `ratings` or `weight_sets` in a migration; they can't be rebuilt. The card shows the star row after the user watches or reveals a game, or once it's rated.

### Talking points (shown after reveal)

Use fixed templates filled from box-score and play-by-play numbers, with no LLM. Show the passing, rushing and receiving leaders by default. Add the biggest play, or a team stat edge when one stands out (for example a turnover margin of 2 or more), up to 4 lines.

### Data and architecture

- Sources: nflverse for play-by-play, `wp` and weekly player stats, used as the source of truth. ESPN's unofficial scoreboard and summary JSON serve as a faster backup for schedule, WP and leaders. Put each source behind its own adapter.
- A scheduled Node/TypeScript ingestion job finds finished games, computes the signals, scores and tiers them, and matches highlights. It runs every 15 min on game days and re-scores when slower nflverse data arrives.
- Storage is a local SQLite database. This is a personal tool, so there's no hosting or accounts.
- Ingestion flow (`server/ingest.ts`): load the schedule from nflverse `games.csv`, skipping the download if its ETag is unchanged. Compare each season's play-by-play `updated_at` from the GitHub release, then download and replace plays only for seasons that changed. If anything changed, score every final game against the previous 3 seasons. Final games without play-by-play yet are logged as awaiting play-by-play and stay unranked. Highlight matching runs every pass, even when no new play-by-play arrived.
- ESPN was considered and skipped on purpose. nflverse publishes Sunday games about 35–75 min after they end: runs at about 5:05 PM, 8:05 PM and 12:35 AM ET, plus 5 AM daily. Don't add ESPN unless the logs show games regularly missing those runs.
- Tables built so far (`server/db.ts`): `games` holds pre-game data only. `recaps` holds final scores and is for the reveal endpoint only. Also `plays`, `watch_scores` (keyed by game and `model_version`), `highlight_videos` (video ID and channel only, never the source title or thumbnail) and `source_state`, which stores ETags and upstream timestamps.
- Planned tables: Game, Play, WatchScore, HighlightVideo, Recap and Rating. They work for any sport. Signals specific to one sport live in the `signals` JSON field on WatchScore, so adding the NBA or soccer doesn't change the schema.
- Out of scope: live or in-progress games, hosting video, betting or fantasy data, and favorite-team boosts or pinning.

## Commands

- `npm run dev` — start the Vite dev server with HMR. It proxies `/api` to `npm run api` on port 8787, so run both.
- `npm run api` — the list API (`server/api.ts`, restarts on change). `npm start` serves the API plus the built `dist/` from one process on http://127.0.0.1:8787. Set `HOST` and `PORT` to change where it listens.
- `npm run build` — type-check (`tsc -b`) then produce a production build in `dist/`
- `npm run lint` — run Oxlint
- `npm run preview` — serve the built `dist/` locally

Ingestion job (Node/TypeScript, in `server/`):

- `npm run ingest`: one pass. Refreshes the schedule, downloads any nflverse play-by-play that changed upstream, and re-scores into `data/sports-larp.db`.
- `npm run ingest -- --force`: re-download all seasons and re-score.
- `npm run ingest -- --league nba` (or `nfl`): one league only. Without it, a pass runs the NFL, then the NBA. The NBA reads and writes the same ESPN cache as the notebook (`data/raw/espn_nba/`).
- `npm run ingest:watch`: keep running, every 15 min from kickoff day through the next day and hourly otherwise.
- The UI's **Update** button calls `POST /api/ingest` with `{"league": "nfl" | "nba"}`, which runs `server/main.ts --league x` as a child process (never in the API process, since a pass blocks for seconds). `GET /api/ingest` returns `IngestStatus` (running, last finished, ok), never log lines. Every pass takes a lockfile next to the database (`server/ingest-lock.ts`), so the CLI, `ingest:watch` and the button never overlap: a pass that finds the lock held is skipped, and the API answers 409. A lock left by a dead process is taken over. POST routes reject a browser `Origin` that isn't the server's own host.
- `npm run refit`: one pass that refits weights from ratings now, for each league that has 20 ratings. Normally this happens on its own: the first time 20 ratings exist, then at most weekly.
- To experiment with ratings or refits, point `SPORTS_LARP_DB` at a copy (`vacuum into`) and run a second server with `PORT`. Test ratings in the real database would train the user's weights.
- `npm test`: unit tests (`node:test`, files named `server/**/*.test.ts`). Run a single file with `node --experimental-strip-types --disable-warning=ExperimentalWarning --test server/scoring/signals.test.ts`.
- `npm run parity`: compare every game's score in the database with `data/scored_games.csv` and `data/scored_nba_games.csv` from the notebooks. It must report a largest gap of 0.00 after any scoring change.
- Env vars are loaded from `.env` (gitignored; see `.env.example`):
    - `YOUTUBE_API_KEY` is needed for highlight matching. Without it, that step is skipped and logged.
    - `GITHUB_TOKEN` is optional and raises the GitHub API rate limit, which applies to the one release lookup per pass.
    - `SPORTS_LARP_DB` overrides the database path.

Scoring prototype (Python, in `notebooks/`):

- `pip install -r notebooks/requirements.txt`, then open `notebooks/scoring.ipynb` (run it with `notebooks/` as the working directory).
- `notebooks/watchability.py` holds all signal and scoring logic. The notebook only runs and inspects it. `server/scoring/` is a function-by-function port of it. Change both together, bump `MODEL_VERSION` in both, re-run the notebook, then run `npm run parity`.
- nflverse data downloads on first use into `data/raw/` (gitignored). Pass `refresh=True` to `load_pbp` or `load_games` to re-download.
- NBA: `notebooks/nba_watchability.py` and `notebooks/nba_scoring.ipynb`. `python -P nba_watchability.py [seasons...]` (from `notebooks/`) backfills ESPN data into `data/raw/espn_nba/`: per-date scoreboards, cached once every game on the date is final, and trimmed, gzipped game summaries, about 170 MB for three seasons. The notebook writes `data/scored_nba_games.csv`. Building signals for all seasons takes about 3 minutes.
- Run ad-hoc Python with `python -P` rather than `-I`, because `-I` hides the user site-packages where pandas is installed.

## Toolchain notes

- **Linting uses Oxlint, not ESLint.** Config is `.oxlintrc.json` (plugins: react, typescript, oxc). Enforced rules: `react/rules-of-hooks` (error) and `react/only-export-components` (warn, constant exports allowed). Type-aware linting is not enabled; the README describes how to turn it on via `oxlint-tsgolint`.
- **Server code runs without a build step.** It uses Node 22's `--experimental-strip-types`, so `server/` must stick to erasable TypeScript (no enums, namespaces or parameter properties) and use `.ts` import extensions. SQLite is the built-in `node:sqlite`. The only server dependency is `hyparquet`, pinned to an exact version.
- **TypeScript uses project references:** `tsconfig.json` points at `tsconfig.app.json` (covers `src/`, browser/DOM) and `tsconfig.node.json` (covers `vite.config.ts` and `server/`). Type checking happens only in `npm run build` (`tsc -b`). Vite itself does not type-check.
- Strictness flags in `tsconfig.app.json` that affect how code must be written:
  - `noUnusedLocals` / `noUnusedParameters`: unused code fails the build.
  - `verbatimModuleSyntax`: type-only imports must use `import type`.
  - `erasableSyntaxOnly`: no `enum`, `namespace`, or constructor parameter properties.
  - `allowImportingTsExtensions`: imports include the `.tsx`/`.ts` extension, e.g. `import App from './App.tsx'`.
- React Compiler is intentionally not enabled.
- Static assets referenced by absolute URL (e.g. `/icons.svg#...`) live in `public/`. Imported assets live in `src/assets/`.
