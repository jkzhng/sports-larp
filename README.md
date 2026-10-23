# sports larp

Watch the games worth watching.

sports larp ranks recently finished games by how entertaining they were, without showing who won. Each game links straight to its official highlights, so you skip the dull games, the commercials and the downtime. Save time and still have ammo for water cooler talks or whatever.

## How it works

- **Ranked by watchability.** Each game gets a 0 to 100 score from its play-by-play data: win-probability swings, late-game closeness, comebacks and upsets, and stakes, plus the action of the sport. For the NFL that's explosive plays, touchdowns and turnovers. For the NBA it's dunks, blocks and deep threes, total scoring, and star performances. Games are grouped as *Must watch*, *Worth it* or *Skippable*. NFL games are listed by week, NBA games by night.
- **Spoiler safe.** Cards show only what you'd know before kickoff. Scores, key moments and recaps appear only after you tap **Reveal**.
- **Official highlights only.** Videos come only from the leagues' official YouTube channels. The app hides their titles and thumbnails, which often give away the result.
- **Talking points.** After reveal, you get the stats leaders, the biggest play, and the team stat that decided the game.
- **Learns your taste.** Rate the games you watch, and the ranking adjusts its weights to match what you enjoy.

The NFL and NBA are supported. Other sports may follow

## Getting started

You need Node.js 22.15 or newer (the server uses Node's built-in SQLite and runs TypeScript directly) and npm. Python is only needed for the scoring notebooks.

1. **Install dependencies.**

   ```sh
   npm install
   ```

2. **Add a YouTube API key** (optional, but without it no highlight videos are linked; ranking still works).
   1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
   2. Under *APIs & Services → Library*, enable **YouTube Data API v3**.
   3. Under *APIs & Services → Credentials*, choose *Create credentials → API key*. Restricting the key to the YouTube Data API is a good idea.
   4. Copy `.env.example` to `.env` and paste the key after `YOUTUBE_API_KEY=`.

   The free quota is 10,000 units a day. The app reads the leagues' upload lists at 1 unit per 50 videos, so a day of passes uses a small share of it. `GITHUB_TOKEN` in `.env` is optional and only raises GitHub's rate limit for the nflverse lookup.

3. **Run the first ingest.**

   ```sh
   npm run ingest
   ```

   One pass refreshes the schedule, downloads play-by-play, scores every finished game, and matches highlights, first for the NFL, then the NBA. The first run takes longest:

   - **NFL:** downloads four seasons of nflverse play-by-play (about 70 MB) into `data/sports-larp.db`.
   - **NBA:** downloads three past seasons plus the current one from ESPN, about 900 daily scoreboards and 4,000 game summaries (about 175 MB), cached in `data/raw/espn_nba/`. This can take several minutes, with progress logged every 500 games.

   Later passes fetch only what changed, usually in under a minute. To set up one league only, use `npm run ingest -- --league nfl` or `--league nba`.

4. **Open the app.**

   ```sh
   npm run build
   npm start          # http://127.0.0.1:8787
   ```

### Keeping it up to date

Nothing ingests on its own. Either run `npm run ingest` when you want fresh rankings, or leave this running in a terminal:

```sh
npm run ingest:watch
```

It runs a pass every 15 minutes on game days and hourly otherwise. NBA games rank about 15 minutes after the final buzzer. NFL games rank once nflverse publishes play-by-play, usually 35–75 minutes after the game ends. Until then they show under *Just finished*. Highlights usually appear within a few hours.

Other ingest options:

| Command | What it does |
| --- | --- |
| `npm run ingest -- --force` | Re-download everything and re-score all games |
| `npm run refit` | Refit the weights from your ratings now, instead of waiting for the weekly refit. Each league learns from its own ratings, starting at 20 |

All data lives in `data/` (gitignored), including your ratings. To start over, delete `data/sports-larp.db` and ingest again. That also deletes your ratings. The NBA's cached downloads in `data/raw/espn_nba/` are reused, so only the NFL is downloaded again.

## Development

Built with React 19, TypeScript and Vite. Oxlint handles linting.

```sh
npm run api      # the API on port 8787, restarting on change
npm run dev      # the Vite dev server, proxying /api to port 8787 (run both)
npm run build    # type-check and build
npm run lint     # run Oxlint
npm test         # unit tests
npm run parity   # check the TypeScript scores against the notebooks' output
```
