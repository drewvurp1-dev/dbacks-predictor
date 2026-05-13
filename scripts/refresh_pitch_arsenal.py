#!/usr/bin/env python3
"""Refresh pitch arsenal data from Baseball Savant via pybaseball.

Pulls two leaderboards:
  - statcast_pitcher_arsenal_stats: per-pitcher pitch_type, usage%, whiff%, k%, woba allowed
  - statcast_batter_pitch_arsenal:  per-batter  pitch_type, whiff%, k%, woba

Joins them into a compact JSON keyed by MLBAM player_id and pitch_type.
Output: data/pitch_arsenal.json
"""

import json
import math
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import pybaseball as pb  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "data" / "pitch_arsenal.json"
MIN_PITCHES_PITCHER = 50
MIN_PA_BATTER = 25
NAME_COL = "last_name, first_name"


def _clean_number(value):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, 3)


def _build_pitcher_index(df):
    """player_id -> {name, pitches: {pitch_type: {usage, whiff, k_pct, woba, n}}}"""
    index = {}
    for _, row in df.iterrows():
        pid = int(row["player_id"])
        n = int(row["pitches"] or 0)
        if n < MIN_PITCHES_PITCHER:
            continue
        entry = index.setdefault(pid, {"name": row.get(NAME_COL), "pitches": {}})
        entry["pitches"][row["pitch_type"]] = {
            "usage": _clean_number(row.get("pitch_usage")),
            "whiff": _clean_number(row.get("whiff_percent")),
            "k_pct": _clean_number(row.get("k_percent")),
            "woba": _clean_number(row.get("woba")),
            "n": n,
        }
    return index


def _build_batter_index(df):
    """player_id -> {name, pitches: {pitch_type: {whiff, k_pct, woba, usage_seen, pa}}}"""
    index = {}
    for _, row in df.iterrows():
        pid = int(row["player_id"])
        pa = int(row["pa"] or 0)
        if pa < MIN_PA_BATTER:
            continue
        entry = index.setdefault(pid, {"name": row.get(NAME_COL), "pitches": {}})
        entry["pitches"][row["pitch_type"]] = {
            "whiff": _clean_number(row.get("whiff_percent")),
            "k_pct": _clean_number(row.get("k_percent")),
            "woba": _clean_number(row.get("woba")),
            "usage_seen": _clean_number(row.get("pitch_usage")),
            "pa": pa,
        }
    return index


def main(season: int):
    print(f"[arsenal] Pulling pitcher arsenal for {season}...", flush=True)
    pitcher_df = pb.statcast_pitcher_arsenal_stats(season)
    print(f"[arsenal]   {len(pitcher_df)} pitcher rows", flush=True)

    print(f"[arsenal] Pulling batter arsenal for {season}...", flush=True)
    batter_df = pb.statcast_batter_pitch_arsenal(season)
    print(f"[arsenal]   {len(batter_df)} batter rows", flush=True)

    pitchers = _build_pitcher_index(pitcher_df)
    batters = _build_batter_index(batter_df)

    payload = {
        "season": season,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pitchers": pitchers,
        "batters": batters,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":")))
    size_kb = OUT_PATH.stat().st_size / 1024
    print(
        f"[arsenal] Wrote {OUT_PATH.relative_to(REPO_ROOT)} "
        f"({size_kb:.1f} KB, {len(pitchers)} pitchers, {len(batters)} batters)",
        flush=True,
    )


if __name__ == "__main__":
    season = int(sys.argv[1]) if len(sys.argv) > 1 else datetime.now().year
    main(season)
