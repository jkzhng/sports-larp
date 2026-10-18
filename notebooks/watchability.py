"""NFL watchability scoring: signals, percentiles, weights and tiers.

Reference implementation of the spec's scoring model. The TypeScript ingestion
job should port these functions one for one.
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.parquet"
GAMES_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv"

MODEL_VERSION = "nfl-v0.3"

# Drama (first three) 0.42, action (last four) 0.58. Late closeness is kept low
# because it moves almost in lockstep with excitement (Spearman 0.88).
WEIGHTS = {
    "excitement": 0.20,
    "late_closeness": 0.07,
    "comeback": 0.15,
    "explosive": 0.22,
    "touchdowns": 0.18,
    "turnovers": 0.10,
    "stakes": 0.08,
}
SIGNALS = list(WEIGHTS)

# 67 gives about 3 Must watch games per regular-season week over 2023-2025.
TIERS = [(67, "Must watch"), (45, "Worth it"), (0, "Skippable")]

# Tunable constants. The spec fixes the shape of each signal; these are the knobs.
CLOSE_MARGIN = 8              # points
LEAD_CHANGE_BONUS_MIN = 5.0   # each Q4/OT lead change counts as this many close minutes
EXPLOSIVE_PASS_YDS = 20
EXPLOSIVE_RUN_YDS = 15
LONG_TD_YDS = 40
GARBAGE_SECONDS = 300         # final 5 minutes of Q4
GARBAGE_WP = 0.99
GARBAGE_FACTOR = 0.5
BIG_MOMENT_BONUS = 5
BIG_MOMENT_SECONDS = 120      # game-winning score in the final 2:00
STAKES_POINTS = {"division": 0.35, "primetime": 0.25, "race": 0.40}
RACE_FROM_WEEK = 13
RACE_MIN_WIN_PCT = 0.5

PBP_COLUMNS = [
    "game_id", "season", "week", "season_type", "home_team", "away_team",
    "posteam", "qtr", "game_seconds_remaining", "play_type", "yards_gained",
    "sack", "touchdown", "td_team", "special_teams_play", "interception",
    "fumble_lost", "fourth_down_failed", "home_wp", "vegas_home_wp", "wpa",
    "total_home_score", "total_away_score",
]


# ---------------------------------------------------------------- loading

def _fetch(url: str, dest: Path, refresh: bool) -> Path:
    if refresh or not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, dest)
    return dest


def load_pbp(seasons: list[int], refresh: bool = False) -> pd.DataFrame:
    frames = []
    for season in seasons:
        path = _fetch(PBP_URL.format(season=season), DATA_DIR / f"pbp_{season}.parquet", refresh)
        frames.append(pd.read_parquet(path, columns=PBP_COLUMNS))
    return pd.concat(frames, ignore_index=True)


def load_games(refresh: bool = False) -> pd.DataFrame:
    """Schedule with final scores, kickoff times and division flags."""
    return pd.read_csv(_fetch(GAMES_URL, DATA_DIR / "games.csv", refresh))


# ---------------------------------------------------------------- per-game signals

def _garbage_mask(g: pd.DataFrame) -> pd.Series:
    """Plays after the game is decided: final 5 minutes, leader's WP above 99%."""
    leader_wp = np.maximum(g["home_wp"], 1 - g["home_wp"])
    return (g["qtr"] == 4) & (g["game_seconds_remaining"] <= GARBAGE_SECONDS) & (leader_wp > GARBAGE_WP)


def game_signals(g: pd.DataFrame) -> dict:
    """Raw signal values for one game's plays (all rows sharing a game_id)."""
    g = g.sort_index()
    weight = np.where(_garbage_mask(g), GARBAGE_FACTOR, 1.0)
    real = g["play_type"].notna() & (g["play_type"] != "no_play")

    home = g["total_home_score"].ffill().fillna(0)
    away = g["total_away_score"].ffill().fillna(0)
    diff = home - away
    final_diff = diff.iloc[-1]

    # Drama -------------------------------------------------------------
    excitement = g["wpa"].abs().sum()

    # Seconds of game clock after each play, until the next play in the same quarter.
    late = g["qtr"] >= 4
    nxt = g["game_seconds_remaining"].shift(-1)
    same_qtr = g["qtr"].shift(-1) == g["qtr"]
    elapsed = (g["game_seconds_remaining"] - nxt).where(same_qtr, 0).clip(lower=0).fillna(0)
    close_minutes = elapsed[late & (diff.abs() <= CLOSE_MARGIN)].sum() / 60

    signs = np.sign(diff)
    pre_q4 = signs[~late & (signs != 0)]
    late_signs = signs[late & (signs != 0)]
    seq = pd.concat([pre_q4.tail(1), late_signs])
    lead_changes = int((seq != seq.shift()).iloc[1:].sum()) if len(seq) > 1 else 0
    late_closeness = close_minutes + LEAD_CHANGE_BONUS_MIN * lead_changes

    # Spread-adjusted WP, so beating the odds counts: a 10-point underdog starts
    # near 13%, not 50%, and a wire-to-wire upset still scores as a big comeback.
    home_wp = g["vegas_home_wp"].dropna()
    if final_diff > 0:
        comeback = 1 - home_wp.min()
    elif final_diff < 0:
        comeback = 1 - (1 - home_wp).min()
    else:  # tie: credit whichever side came back further
        comeback = 1 - min(home_wp.min(), (1 - home_wp).min())

    # Action ------------------------------------------------------------
    yds = g["yards_gained"].fillna(0)
    is_pass = (g["play_type"] == "pass") & (g["sack"].fillna(0) == 0)
    is_run = g["play_type"] == "run"
    explosive_play = (is_pass & (yds >= EXPLOSIVE_PASS_YDS)) | (is_run & (yds >= EXPLOSIVE_RUN_YDS))
    td = real & (g["touchdown"].fillna(0) == 1)
    long_td = td & (is_pass | is_run) & (yds >= LONG_TD_YDS)
    explosive = float((weight * explosive_play).sum() + (weight * long_td).sum())

    touchdowns = float((weight * td).sum())

    turnover = real & (
        (g["interception"].fillna(0) == 1)
        | (g["fumble_lost"].fillna(0) == 1)
        | (g["fourth_down_failed"].fillna(0) == 1)
    )
    turnovers = float((weight * g["wpa"].abs().fillna(0) * turnover).sum())

    # Big-moment bonus --------------------------------------------------
    big_moment = _big_moment(g, diff, td, real)

    return {
        "excitement": excitement,
        "late_closeness": late_closeness,
        "comeback": comeback,
        "explosive": explosive,
        "touchdowns": touchdowns,
        "turnovers": turnovers,
        "big_moment": big_moment,
        "lead_changes_late": lead_changes,
        "home_score": int(home.iloc[-1]),
        "away_score": int(away.iloc[-1]),
    }


def _big_moment(g: pd.DataFrame, diff: pd.Series, td: pd.Series, real: pd.Series) -> bool:
    late = g["qtr"] >= 4
    # Defensive or special-teams touchdown in Q4/OT.
    non_offense_td = td & late & ((g["td_team"] != g["posteam"]) | (g["special_teams_play"] == 1))
    if non_offense_td.any():
        return True

    final_sign = np.sign(diff.iloc[-1])
    if final_sign == 0:
        return False
    # The play that put the winner ahead for good.
    not_winning = np.sign(diff) != final_sign
    if not not_winning.any():
        return False  # led wire to wire
    go_ahead_pos = g.index.get_loc(not_winning[not_winning].index[-1]) + 1
    if go_ahead_pos >= len(g):
        return False
    go_ahead = g.iloc[go_ahead_pos]
    return bool(go_ahead["qtr"] >= 5 or (go_ahead["qtr"] == 4 and go_ahead["game_seconds_remaining"] <= BIG_MOMENT_SECONDS))


# ---------------------------------------------------------------- stakes

def _win_pct_entering(games: pd.DataFrame) -> pd.DataFrame:
    """Each team's win percentage entering each game, within its season (ties = half)."""
    done = games[games["result"].notna()].sort_values(["season", "gameday", "gametime"])
    rows = []
    for side, other, sign in (("home_team", "away_team", 1), ("away_team", "home_team", -1)):
        r = done[["game_id", "season", "gameday", "gametime", side, "result"]].rename(columns={side: "team"})
        r["win"] = np.where(r["result"] * sign > 0, 1.0, np.where(r["result"] == 0, 0.5, 0.0))
        rows.append(r[["game_id", "season", "gameday", "gametime", "team", "win"]])
    long = pd.concat(rows).sort_values(["season", "gameday", "gametime"])
    grp = long.groupby(["season", "team"])["win"]
    long["wins_before"] = grp.cumsum() - long["win"]
    long["played_before"] = grp.cumcount()
    long["win_pct"] = (long["wins_before"] / long["played_before"]).fillna(0.5)
    return long[["game_id", "team", "win_pct"]]


def stakes(games: pd.DataFrame) -> pd.DataFrame:
    """Pre-game stakes per game. Uses only information known before kickoff."""
    g = games.copy()
    wp = _win_pct_entering(g)
    g = g.merge(wp.rename(columns={"team": "home_team", "win_pct": "home_pct"}), on=["game_id", "home_team"], how="left")
    g = g.merge(wp.rename(columns={"team": "away_team", "win_pct": "away_pct"}), on=["game_id", "away_team"], how="left")

    hour = g["gametime"].str.slice(0, 2).astype(float)
    g["primetime"] = (g["game_type"] == "REG") & ((hour >= 19) | (g["weekday"] != "Sunday"))
    g["division"] = g["div_game"] == 1
    g["race"] = (
        (g["game_type"] == "REG")
        & (g["week"] >= RACE_FROM_WEEK)
        & (g["home_pct"] >= RACE_MIN_WIN_PCT)
        & (g["away_pct"] >= RACE_MIN_WIN_PCT)
    )
    playoff = g["game_type"] != "REG"
    regular = (
        STAKES_POINTS["division"] * g["division"]
        + STAKES_POINTS["primetime"] * g["primetime"]
        + STAKES_POINTS["race"] * g["race"]
    )
    g["stakes"] = np.where(playoff, np.where(g["game_type"] == "SB", 1.2, 1.0), regular)
    g["playoff"] = playoff
    return g[["game_id", "stakes", "playoff", "division", "primetime", "race"]]


# ---------------------------------------------------------------- scoring

def build_signals(pbp: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """One row per finished game with every raw signal."""
    raw = pd.DataFrame(
        [{"game_id": gid, **game_signals(g)} for gid, g in pbp.groupby("game_id", sort=False)]
    )
    meta = games[["game_id", "season", "game_type", "week", "gameday", "weekday", "gametime",
                  "away_team", "home_team"]]
    return meta.merge(raw, on="game_id").merge(stakes(games), on="game_id")


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


def top_k_overlap(hand_ranked: list[str], scored: pd.DataFrame, k: int = 5) -> int:
    """How many of your hand-picked top-k game_ids the model also puts in its top k."""
    model_top = set(scored.nlargest(k, "score")["game_id"])
    return len(model_top & set(hand_ranked[:k]))
