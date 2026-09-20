from __future__ import annotations

from datetime import date, datetime, time as dt_time, timedelta, timezone
from zoneinfo import ZoneInfo

from market_prices import chunk_date_ranges
from pocketbase_client import PocketBaseClient

AMSTERDAM = ZoneInfo("Europe/Amsterdam")


def _pb_filter_time(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000Z").replace(
        "T", " "
    )


def _parse_period_start(value: str) -> datetime | None:
    if not value:
        return None
    raw = str(value).replace(" ", "T")
    if not raw.endswith("Z"):
        raw = f"{raw}Z" if "Z" not in raw and "+" not in raw else raw
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


async def market_dates_with_coverage(
    pb: PocketBaseClient,
    start_day: date,
    end_day: date,
) -> set[date]:
    """Kalenderdagen (NL) waar minstens één markt-slot voor bestaat."""
    range_start = datetime.combine(start_day, dt_time.min, tzinfo=AMSTERDAM).astimezone(
        timezone.utc
    )
    range_end = datetime.combine(end_day + timedelta(days=1), dt_time.min, tzinfo=AMSTERDAM).astimezone(
        timezone.utc
    )
    filter_query = (
        f'period_start >= "{_pb_filter_time(range_start)}" && '
        f'period_start < "{_pb_filter_time(range_end)}" && '
        f'source="market"'
    )
    rows = await pb.list_all("price_slots", filter_query=filter_query)
    covered: set[date] = set()
    for row in rows:
        dt = _parse_period_start(row.get("period_start") or "")
        if dt is None:
            continue
        covered.add(dt.astimezone(AMSTERDAM).date())
    return covered


def missing_day_ranges(
    start_day: date,
    end_day: date,
    covered: set[date],
) -> list[tuple[date, date]]:
    """Half-open intervals [start, end) per ontbrekende aaneengesloten dagen."""
    ranges: list[tuple[date, date]] = []
    block_start: date | None = None
    cursor = start_day
    while cursor <= end_day:
        if cursor not in covered:
            if block_start is None:
                block_start = cursor
        elif block_start is not None:
            ranges.append((block_start, cursor))
            block_start = None
        cursor += timedelta(days=1)
    if block_start is not None:
        ranges.append((block_start, end_day + timedelta(days=1)))
    return ranges


def day_ranges_to_fetch_chunks(
    day_ranges: list[tuple[date, date]],
    *,
    chunk_days: int = 7,
) -> list[tuple[date, date]]:
    chunks: list[tuple[date, date]] = []
    for start, end in day_ranges:
        chunks.extend(chunk_date_ranges(start, end, chunk_days=chunk_days))
    return chunks
