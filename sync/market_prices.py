from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

AMSTERDAM = ZoneInfo("Europe/Amsterdam")
API = "https://api.energy-charts.info/price"


def _iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000Z")


def fetch_nl_day_ahead_slots(start: date, end: date) -> list[dict[str, Any]]:
    """Haal NL day-ahead prijzen op (EUR/MWh → EUR/kWh). Interval volgt de API (meestal 30m/60m)."""
    if end <= start:
        return []

    url = f"{API}?bzn=NL&start={start.isoformat()}&end={end.isoformat()}"
    with httpx.Client(timeout=60.0) as client:
        res = client.get(url)
        res.raise_for_status()
        data = res.json()

    seconds = data.get("unix_seconds") or []
    prices = data.get("price") or []
    if not seconds or not prices:
        return []

    interval_minutes = 60
    if len(seconds) > 1:
        interval_minutes = max(1, int(round((seconds[1] - seconds[0]) / 60)))

    rows: list[dict[str, Any]] = []
    for ts, price_mwh in zip(seconds, prices):
        try:
            eur_kwh = float(price_mwh) / 1000.0
        except (TypeError, ValueError):
            continue
        period_start = datetime.fromtimestamp(int(ts), tz=AMSTERDAM).astimezone(timezone.utc)
        rows.append(
            {
                "period_start": _iso_utc(period_start),
                "price_eur_kwh": round(eur_kwh, 6),
                "source": "market",
                "interval_minutes": interval_minutes,
            }
        )
    return rows


def chunk_date_ranges(start: date, end: date, *, chunk_days: int = 28) -> list[tuple[date, date]]:
    ranges: list[tuple[date, date]] = []
    cursor = start
    while cursor < end:
        chunk_end = min(end, cursor + timedelta(days=chunk_days))
        ranges.append((cursor, chunk_end))
        cursor = chunk_end
    return ranges
