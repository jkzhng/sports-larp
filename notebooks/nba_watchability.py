"""NBA watchability scoring: signals, percentiles, weights and tiers.

Reference implementation for the NBA model, the counterpart of watchability.py
(NFL). Data comes from ESPN's unofficial site API: the scoreboard for the
schedule and the game summary for plays, per-play win probability and the box
score. The TypeScript ingestion job should port these functions one for one.

Seasons are named by the year they start (2025 = 2025-26), like nflverse.
ESPN names them by the year they end.
"""

from __future__ import annotations

import gzip
import json
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "raw" / "espn_nba"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"

MODEL_VERSION = "nba-v0.1"

# Drama (first three) 0.42, action 0.46, stakes 0.12. As in the NFL model, late
# closeness is kept low: it moves almost in lockstep with excitement (Spearman
# 0.87 over 2023-24 to 2025-26).
WEIGHTS = {
    "excitement": 0.20,
    "late_closeness": 0.07,
    "comeback": 0.15,
    "highlight_plays": 0.20,
    "scoring": 0.10,
    "star": 0.16,
    "stakes": 0.12,
}
SIGNALS = list(WEIGHTS)

# 78 gives about 2.4 Must watch games per regular-season week over 2023-24 to
# 2025-26 (about 5% of games). 60 makes about 1.7 games a night Worth it.
TIERS = [(78, "Must watch"), (60, "Worth it"), (0, "Skippable")]

# Tunable constants.
REGULATION_PERIOD = 720       # seconds
OT_PERIOD = 300
CLOSE_MARGIN = 5              # points
LEAD_CHANGE_BONUS_MIN = 1.0   # each Q4/OT lead change counts as this many close minutes
DEEP_THREE_FT = 30
GARBAGE_SECONDS = 300         # final 5 minutes of Q4
GARBAGE_WP = 0.99
GARBAGE_FACTOR = 0.5
BIG_MOMENT_BONUS = 5
BIG_MOMENT_SECONDS = 24       # winner goes ahead for good in the final 24 s
TYING_BUZZER_SECONDS = 3      # a shot this late that ties the game and forces OT
TRIPLE_DOUBLE_BONUS = 10      # star signal: points of the best player, plus this
SIGNAL_DECIMALS = 6           # raw float signals are rounded to this before ranking
NATIONAL_TV = {"ABC", "ESPN", "TNT", "NBC", "Prime Video"}
STAKES_POINTS = {"national_tv": 0.35, "marquee": 0.25, "race": 0.40}
MARQUEE_MIN_WIN_PCT = 0.6     # both teams, after MIN_GAMES_FOR_PCT games
MIN_GAMES_FOR_PCT = 10
RACE_MIN_GAMES = 55           # last ~27 games of an 82-game season
RACE_MIN_WIN_PCT = 0.5

SEASON_TYPES = {1: "PRE", 2: "REG", 3: "POST", 5: "PLAYIN"}


# ---------------------------------------------------------------- loading

def _get_json(url: str, tries: int = 4) -> dict:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sports-larp/0.1", "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def _season_dates(season: int) -> list[date]:
    """Every date ESPN lists for a season (preseason through the Finals)."""
    sb = _get_json(f"{ESPN}/scoreboard?dates={season}1201")
    return [datetime.fromisoformat(d.replace("Z", "+00:00")).date() for d in sb["leagues"][0]["calendar"]]


def _scoreboard(day: date, refresh: bool) -> dict:
    path = DATA_DIR / "scoreboard" / f"{day:%Y%m%d}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    data = _get_json(f"{ESPN}/scoreboard?dates={day:%Y%m%d}")
    # Cache a day only once every game on it is over.
    if all(e["status"]["type"]["completed"] for e in data.get("events", [])) and day < date.today():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
    return data


def _is_league_game(e: dict) -> bool:
    """Skip All-Star events and exhibitions against non-NBA teams."""
    teams = [t["team"] for t in e["competitions"][0]["competitors"]]
    return all("abbreviation" in t and int(t.get("id", 0)) <= 30 for t in teams)


def _game_row(e: dict, night: date, season: int) -> dict:
    c = e["competitions"][0]
    side = {t["homeAway"]: t for t in c["competitors"]}
    notes = " / ".join(n.get("headline", "") for n in c.get("notes", []))
    national = sorted({b["media"]["shortName"] for b in c.get("geoBroadcasts", []) if b["market"]["type"] == "National"})
    completed = e["status"]["type"]["completed"]
    return {
        "game_id": e["id"],
        "season": season,
        "season_type": SEASON_TYPES.get(e["season"]["type"], str(e["season"]["type"])),
        "night": night.isoformat(),
        "tipoff": e["date"],
        "home_team": side["home"]["team"]["abbreviation"],
        "away_team": side["away"]["team"]["abbreviation"],
        "home_name": side["home"]["team"]["displayName"],
        "away_name": side["away"]["team"]["displayName"],
        "home_score": int(side["home"]["score"]) if completed else None,
        "away_score": int(side["away"]["score"]) if completed else None,
        "completed": completed,
        "notes": notes,
        "comp_type": c.get("type", {}).get("abbreviation", ""),
        "national_tv": ",".join(national),
        "neutral_site": bool(c.get("neutralSite")),
    }


def load_schedule(seasons: list[int], refresh: bool = False) -> pd.DataFrame:
    """Every game in the seasons, keyed by ESPN event id, with the night (US date) it was played."""
    rows = []
    for season in seasons:
        days = [d for d in _season_dates(season) if d <= date.today() + timedelta(days=1)]
        with ThreadPoolExecutor(6) as pool:
            boards = list(pool.map(lambda d: _scoreboard(d, refresh), days))
        for day, sb in zip(days, boards):
            rows += [_game_row(e, day, season) for e in sb.get("events", []) if _is_league_game(e)]
    games = pd.DataFrame(rows).drop_duplicates("game_id")
    return games[games["season_type"] != "PRE"].sort_values("tipoff").reset_index(drop=True)


SUMMARY_KEYS = ["header", "plays", "winprobability", "boxscore"]


def _summary_path(game_id: str) -> Path:
    return DATA_DIR / "summary" / f"{game_id}.json.gz"


def load_summary(game_id: str, refresh: bool = False) -> dict | None:
    """Plays, win probability and box score for one finished game (cached, trimmed).

    None when ESPN has no summary for the game (a handful of events 404)."""
    path = _summary_path(game_id)
    if path.exists() and not refresh:
        return json.loads(gzip.decompress(path.read_bytes()))
    try:
        data = _get_json(f"{ESPN}/summary?event={game_id}")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        raise
    trimmed = {k: data.get(k) for k in SUMMARY_KEYS}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(trimmed).encode()))
    return trimmed


def load_summaries(game_ids: list[str], refresh: bool = False, workers: int = 6) -> dict[str, dict]:
    with ThreadPoolExecutor(workers) as pool:
        found = zip(game_ids, pool.map(lambda g: load_summary(g, refresh), game_ids))
        return {gid: s for gid, s in found if s is not None}


# ---------------------------------------------------------------- plays

def _clock_seconds(display: str) -> float:
    if ":" in display:
        m, s = display.split(":")
        return int(m) * 60 + float(s)
    return float(display)


def plays_frame(summary: dict) -> pd.DataFrame:
    """One row per play with clock, score and the home team's win probability after it."""
    comp = summary["header"]["competitions"][0]
    home_id = next(t["team"]["id"] for t in comp["competitors"] if t["homeAway"] == "home")
    wp = {w["playId"]: w["homeWinPercentage"] for w in summary.get("winprobability") or []}
    rows = []
    for p in summary.get("plays") or []:
        rows.append({
            "play_id": p["id"],
            "period": p["period"]["number"],
            "clock": _clock_seconds(p["clock"]["displayValue"]),
            "type": p["type"]["text"],
            "text": p.get("text", ""),
            "home_score": p["homeScore"],
            "away_score": p["awayScore"],
            "scoring": bool(p.get("scoringPlay")),
            "score_value": p.get("scoreValue", 0),
            "shooting": bool(p.get("shootingPlay")),
            "is_home": p.get("team", {}).get("id") == home_id,
            "home_wp": wp.get(p["id"]),
        })
    g = pd.DataFrame(rows)
    if g.empty:
        return g
    # Seconds left in regulation (Q1-Q4) or in the current overtime.
    reg_left = (4 - g["period"]).clip(lower=0) * REGULATION_PERIOD + g["clock"]
    g["seconds_left"] = np.where(g["period"] <= 4, reg_left, g["clock"])
    g["home_wp"] = g["home_wp"].ffill()
    return g


def box_players(summary: dict) -> pd.DataFrame:
    """Player box score: name, team, points, rebounds, assists, steals, blocks."""
    rows = []
    for team in (summary.get("boxscore") or {}).get("players", []):
        stats = team["statistics"][0]
        labels = stats["labels"]
        for a in stats["athletes"]:
            if not a.get("stats"):
                continue
            s = dict(zip(labels, a["stats"]))
            athlete = a.get("athlete", {})
            rows.append({
                "name": athlete.get("displayName") or athlete.get("shortName", ""),
                "team": team["team"]["abbreviation"],
                **{k: int(s[k]) if s.get(k, "").isdigit() else 0 for k in ("PTS", "REB", "AST", "STL", "BLK")},
            })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- per-game signals

FOOT = re.compile(r"(\d+)-foot")


def _garbage_mask(g: pd.DataFrame) -> pd.Series:
    """Plays after the game is decided: final 5 minutes of Q4, leader's WP above 99%."""
    leader_wp = np.maximum(g["home_wp"], 1 - g["home_wp"])
    return (g["period"] == 4) & (g["clock"] <= GARBAGE_SECONDS) & (leader_wp > GARBAGE_WP)


def game_signals(summary: dict) -> dict | None:
    """Raw signal values for one game, or None if it has no plays or win probability."""
    g = plays_frame(summary)
    if g.empty or g["home_wp"].isna().all():
        return None
    weight = np.where(_garbage_mask(g), GARBAGE_FACTOR, 1.0)
    diff = g["home_score"] - g["away_score"]
    final_diff = diff.iloc[-1]

    # Drama -------------------------------------------------------------
    wp = g["home_wp"].dropna()
    excitement = float(wp.diff().abs().sum())

    late = g["period"] >= 4
    nxt = g["clock"].shift(-1)
    same_period = g["period"].shift(-1) == g["period"]
    elapsed = (g["clock"] - nxt).where(same_period, 0).clip(lower=0).fillna(0)
    close_minutes = elapsed[late & (diff.abs() <= CLOSE_MARGIN)].sum() / 60

    signs = np.sign(diff)
    pre_q4 = signs[~late & (signs != 0)]
    late_signs = signs[late & (signs != 0)]
    seq = pd.concat([pre_q4.tail(1), late_signs])
    lead_changes_late = int((seq != seq.shift()).iloc[1:].sum()) if len(seq) > 1 else 0
    late_closeness = close_minutes + LEAD_CHANGE_BONUS_MIN * lead_changes_late

    nz = signs[signs != 0]
    lead_changes = int((nz != nz.shift()).iloc[1:].sum()) if len(nz) > 1 else 0

    # ESPN's WP starts from a pregame prior (about 0.6 for a home favorite),
    # so a wire-to-wire upset still scores as a comeback.
    if final_diff > 0:
        comeback = 1 - wp.min()
    else:
        comeback = 1 - (1 - wp).min()

    # Action ------------------------------------------------------------
    made = g["scoring"] & g["shooting"] & ~g["type"].str.startswith("Free Throw")
    feet = g["text"].str.extract(FOOT, expand=False).astype(float)
    dunk = made & g["type"].str.contains("Dunk")
    alley_oop = made & g["type"].str.contains("Alley Oop") & ~dunk
    deep_three = made & (g["score_value"] == 3) & (feet >= DEEP_THREE_FT)
    block = g["text"].str.contains(" blocks ")
    and_one = g["type"] == "Free Throw - 1 of 1"
    highlight = dunk | alley_oop | deep_three | block | and_one
    highlight_plays = float((weight * highlight).sum())

    scoring = float(g["home_score"].iloc[-1] + g["away_score"].iloc[-1])

    box = box_players(summary)
    star = 0.0
    if not box.empty:
        doubles = (box[["PTS", "REB", "AST", "STL", "BLK"]] >= 10).sum(axis=1)
        star = float((box["PTS"] + TRIPLE_DOUBLE_BONUS * (doubles >= 3)).max())

    # Rounded so the TypeScript port, which adds floats in a different order,
    # ranks ties identically.
    return {
        "excitement": round(excitement, SIGNAL_DECIMALS),
        "late_closeness": round(late_closeness, SIGNAL_DECIMALS),
        "comeback": round(comeback, SIGNAL_DECIMALS),
        "highlight_plays": highlight_plays,
        "scoring": scoring,
        "star": star,
        "big_moment": _big_moment(g, diff),
        "lead_changes": lead_changes,
        "lead_changes_late": lead_changes_late,
        "overtime": int(g["period"].max() > 4),
        "home_score": int(g["home_score"].iloc[-1]),
        "away_score": int(g["away_score"].iloc[-1]),
    }


def _big_moment(g: pd.DataFrame, diff: pd.Series) -> bool:
    """Go-ahead-for-good shot in the final 24 s, or a buzzer shot that forces OT."""
    late = g["period"] >= 4
    signs = np.sign(diff)
    prev = signs.shift(fill_value=0)
    tying_buzzer = late & g["scoring"] & (signs == 0) & (prev != 0) & (g["clock"] <= TYING_BUZZER_SECONDS)
    if tying_buzzer.any():
        return True

    final_sign = np.sign(diff.iloc[-1])
    not_winning = signs != final_sign
    if not not_winning.any():
        return False  # led wire to wire
    go_ahead_pos = g.index.get_loc(not_winning[not_winning].index[-1]) + 1
    if go_ahead_pos >= len(g):
        return False
    go_ahead = g.iloc[go_ahead_pos]
    return bool(go_ahead["period"] >= 4 and go_ahead["clock"] <= BIG_MOMENT_SECONDS)


# ---------------------------------------------------------------- stakes

def _win_pct_entering(games: pd.DataFrame) -> pd.DataFrame:
    """Each team's regular-season record entering each game, within its season."""
    done = games[games["completed"] & (games["season_type"] == "REG")].sort_values("tipoff")
    rows = []
    for side, sign in (("home_team", 1), ("away_team", -1)):
        r = done[["game_id", "season", "tipoff", side]].rename(columns={side: "team"})
        r["win"] = ((done["home_score"] - done["away_score"]) * sign > 0).astype(float)
        rows.append(r)
    long = pd.concat(rows).sort_values("tipoff")
    grp = long.groupby(["season", "team"])["win"]
    long["wins_before"] = grp.cumsum() - long["win"]
    long["played_before"] = grp.cumcount()
    long["win_pct"] = (long["wins_before"] / long["played_before"]).fillna(0.5)
    return long[["game_id", "team", "win_pct", "played_before"]]


def stakes(games: pd.DataFrame) -> pd.DataFrame:
    """Pre-game stakes per game. Uses only information known before tipoff."""
    g = games.copy()
    wp = _win_pct_entering(g)
    for side in ("home", "away"):
        g = g.merge(
            wp.rename(columns={"team": f"{side}_team", "win_pct": f"{side}_pct", "played_before": f"{side}_played"}),
            on=["game_id", f"{side}_team"], how="left",
        )
    reg = g["season_type"] == "REG"
    played = np.minimum(g["home_played"], g["away_played"]).fillna(0)
    g["national"] = g["national_tv"].fillna("").map(lambda s: bool(NATIONAL_TV & set(s.split(","))))
    g["marquee"] = reg & (played >= MIN_GAMES_FOR_PCT) & (g["home_pct"] >= MARQUEE_MIN_WIN_PCT) & (g["away_pct"] >= MARQUEE_MIN_WIN_PCT)
    g["race"] = reg & (played >= RACE_MIN_GAMES) & (g["home_pct"] >= RACE_MIN_WIN_PCT) & (g["away_pct"] >= RACE_MIN_WIN_PCT)
    # 2023-24 called the Cup the "In-Season Tournament".
    cup_knockout = g["notes"].str.contains("NBA Cup|In-Season Tournament") & ~g["notes"].str.contains("Group Play")
    regular = (
        STAKES_POINTS["national_tv"] * g["national"]
        + STAKES_POINTS["marquee"] * g["marquee"]
        + STAKES_POINTS["race"] * g["race"]
    )
    finals = g["notes"].str.contains("NBA Finals")
    game7 = g["notes"].str.contains("Game 7")
    post = np.where(finals | game7, 1.2, 1.0)
    g["stakes"] = np.select(
        [g["season_type"] == "POST", g["season_type"] == "PLAYIN", cup_knockout],
        [post, 0.8, np.where(g["comp_type"] == "CC", 1.0, 0.8)],
        regular,
    )
    g["playoff"] = g["season_type"] == "POST"
    g["play_in"] = g["season_type"] == "PLAYIN"
    g["cup_knockout"] = cup_knockout
    return g[["game_id", "stakes", "playoff", "play_in", "cup_knockout", "national", "marquee", "race"]]


# ---------------------------------------------------------------- scoring

def build_signals(games: pd.DataFrame, summaries: dict[str, dict]) -> pd.DataFrame:
    """One row per finished game with every raw signal. Games without WP are dropped."""
    raw = []
    for gid, s in summaries.items():
        sig = game_signals(s)
        if sig is not None:
            raw.append({"game_id": gid, **sig})
    meta = games[["game_id", "season", "season_type", "night", "tipoff", "away_team", "home_team", "notes", "national_tv"]]
    return meta.merge(pd.DataFrame(raw), on="game_id").merge(stakes(games), on="game_id")


def percentiles(values: pd.Series, reference: pd.Series) -> pd.Series:
    """Mid-rank percentile of each value within the reference distribution (0 to 1)."""
    ref = np.sort(reference.to_numpy())
    lo = np.searchsorted(ref, values.to_numpy(), side="left")
    hi = np.searchsorted(ref, values.to_numpy(), side="right")
    return pd.Series((lo + hi) / 2 / len(ref), index=values.index)


def tier(score: float) -> str:
    return next(name for cutoff, name in TIERS if score >= cutoff)


def score(signals: pd.DataFrame, reference: pd.DataFrame, weights: dict = WEIGHTS) -> pd.DataFrame:
    """Add pct_<signal>, score (0 to 100), stars and tier columns."""
    assert abs(sum(weights.values()) - 1) < 1e-9, "weights must sum to 1"
    out = signals.copy()
    total = 0
    for s in SIGNALS:
        out[f"pct_{s}"] = percentiles(out[s], reference[s])
        total = total + weights[s] * out[f"pct_{s}"]
    out["score"] = (100 * total + BIG_MOMENT_BONUS * out["big_moment"]).clip(upper=100).round(1)
    out["stars"] = (1 + out["score"] / 25).clip(upper=5).round().astype(int)
    out["tier"] = out["score"].map(tier)
    out["model_version"] = MODEL_VERSION
    return out


def contributions(scored_row: pd.Series, weights: dict = WEIGHTS) -> pd.Series:
    """Points each signal added to one game's score: the 'why it ranked here' view."""
    pts = pd.Series({s: 100 * weights[s] * scored_row[f"pct_{s}"] for s in SIGNALS})
    pts["big_moment"] = BIG_MOMENT_BONUS * scored_row["big_moment"]
    return pts.round(1).sort_values(ascending=False)


def week_of(night: pd.Series) -> pd.Series:
    """Monday of each night's week, for 'Must watch per week' calibration."""
    d = pd.to_datetime(night)
    return (d - pd.to_timedelta(d.dt.weekday, unit="D")).dt.date


def top_k_overlap(hand_ranked: list[str], scored: pd.DataFrame, k: int = 5) -> int:
    model_top = set(scored.nlargest(k, "score")["game_id"])
    return len(model_top & set(hand_ranked[:k]))


if __name__ == "__main__":
    # Backfill: python -P nba_watchability.py [seasons...]
    import sys
    seasons = [int(s) for s in sys.argv[1:]] or [2023, 2024, 2025]
    t0 = time.time()
    games = load_schedule(seasons)
    final = games[games["completed"]]
    print(f"{len(final)} final games in {seasons}, schedule in {time.time() - t0:.0f}s", flush=True)
    todo = [g for g in final["game_id"] if not _summary_path(g).exists()]
    for i in range(0, len(todo), 200):
        load_summaries(todo[i:i + 200])
        print(f"  {min(i + 200, len(todo))}/{len(todo)} summaries ({time.time() - t0:.0f}s)", flush=True)
