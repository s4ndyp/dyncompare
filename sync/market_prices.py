from __future__ import annotations

import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

AMSTERDAM = ZoneInfo("Europe/Amsterdam")
ENERGY_CHARTS_API = "https://api.energy-charts.info/price"
ENTSOE_API = "https://web-api.tp.entsoe.eu/api"
NL_EIC = "10YNL----------L"

RESOLUTION_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?", re.IGNORECASE)


class EnergyChartsRateLimitedError(RuntimeError):
    """Energy-Charts HTTP 429 — verder proberen verergert de blokkade."""

    def __init__(self, retry_after_sec: float | None = None) -> None:
        self.retry_after_sec = retry_after_sec
        hint = (
            "Energy-Charts: 429 Too Many Requests (rate limit). "
            "Gebruik ENTSOE_API_TOKEN of wacht en sync later opnieuw."
        )
        if retry_after_sec is not None:
            hint += f" Retry-After: {retry_after_sec:.0f}s."
        super().__init__(hint)


def _iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000Z")


def _local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _resolution_minutes(resolution: str) -> int:
    if not resolution:
        return 60
    match = RESOLUTION_RE.fullmatch(resolution.strip())
    if not match:
        return 60
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    total = hours * 60 + minutes
    return total if total > 0 else 60


def _parse_entsoe_instant(value: str) -> datetime:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _slots_from_energy_charts(data: dict[str, Any]) -> list[dict[str, Any]]:
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
        period_start = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        rows.append(
            {
                "period_start": _iso_utc(period_start),
                "price_eur_kwh": round(eur_kwh, 6),
                "source": "market",
                "interval_minutes": interval_minutes,
            }
        )
    return rows


def _retry_after_seconds(response: httpx.Response) -> float | None:
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, float(raw.strip()))
    except ValueError:
        return None


def fetch_energy_charts_nl(start: date, end: date) -> list[dict[str, Any]]:
    if end <= start:
        return []
    url = f"{ENERGY_CHARTS_API}?bzn=NL&start={start.isoformat()}&end={end.isoformat()}"
    with httpx.Client(timeout=90.0) as client:
        res = client.get(url)
        if res.status_code == 429:
            raise EnergyChartsRateLimitedError(_retry_after_seconds(res))
        res.raise_for_status()
        data = res.json()
    rows = _slots_from_energy_charts(data)
    if not rows:
        raise RuntimeError("Energy-Charts: lege prijslijst")
    return rows


def parse_entsoe_price_xml(xml_text: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    for elem in root.iter():
        if _local_tag(elem.tag) == "Reason":
            text = (elem.findtext("*") or elem.text or "").strip()
            code = elem.findtext("{*}code") or elem.findtext("code") or ""
            raise RuntimeError(f"ENTSO-E: {code} {text}".strip())

    rows: list[dict[str, Any]] = []
    for ts_el in root.iter():
        if _local_tag(ts_el.tag) != "TimeSeries":
            continue
        for period_el in ts_el.iter():
            if _local_tag(period_el.tag) != "Period":
                continue
            start_text = None
            resolution = "PT60M"
            for child in period_el:
                tag = _local_tag(child.tag)
                if tag == "timeInterval":
                    start_text = child.findtext("*") or child.findtext(".//{*}start")
                    if start_text is None:
                        for sub in child:
                            if _local_tag(sub.tag) == "start":
                                start_text = sub.text
                                break
                elif tag == "resolution" and child.text:
                    resolution = child.text.strip()
            if not start_text:
                continue
            period_start = _parse_entsoe_instant(start_text)
            step_minutes = _resolution_minutes(resolution)
            for point_el in period_el.iter():
                if _local_tag(point_el.tag) != "Point":
                    continue
                position_raw = None
                price_raw = None
                for child in point_el:
                    tag = _local_tag(child.tag)
                    if tag == "position":
                        position_raw = child.text
                    elif tag in ("price.amount", "price"):
                        price_raw = child.text
                if position_raw is None or price_raw is None:
                    continue
                try:
                    position = int(position_raw)
                    price_mwh = float(price_raw)
                except (TypeError, ValueError):
                    continue
                slot_start = period_start + timedelta(minutes=step_minutes * (position - 1))
                rows.append(
                    {
                        "period_start": _iso_utc(slot_start),
                        "price_eur_kwh": round(price_mwh / 1000.0, 6),
                        "source": "market",
                        "interval_minutes": step_minutes,
                    }
                )
    if not rows:
        raise RuntimeError("ENTSO-E: geen prijspunten in antwoord")
    return rows


def fetch_entsoe_nl_day_ahead(start: date, end: date, token: str) -> list[dict[str, Any]]:
    if end <= start:
        return []
    if not token.strip():
        raise RuntimeError("ENTSO-E: geen API-token (ENTSOE_API_TOKEN)")

    start_dt = datetime.combine(start, dt_time.min, tzinfo=AMSTERDAM).astimezone(timezone.utc)
    end_dt = datetime.combine(end, dt_time.min, tzinfo=AMSTERDAM).astimezone(timezone.utc)
    params = {
        "documentType": "A44",
        "contract_MarketAgreement.type": "A01",
        "in_Domain": NL_EIC,
        "out_Domain": NL_EIC,
        "periodStart": start_dt.strftime("%Y%m%d%H%M"),
        "periodEnd": end_dt.strftime("%Y%m%d%H%M"),
        "securityToken": token.strip(),
    }
    with httpx.Client(timeout=120.0) as client:
        res = client.get(ENTSOE_API, params=params)
        res.raise_for_status()
        return parse_entsoe_price_xml(res.text)


def fetch_nl_day_ahead_slots(
    start: date,
    end: date,
    *,
    entsoe_token: str | None = None,
    skip_energy_charts: bool = False,
) -> tuple[list[dict[str, Any]], str]:
    """Haal NL day-ahead op. Energy-Charts tenzij overgeslagen (429), anders ENTSO-E."""
    token = (entsoe_token or os.environ.get("ENTSOE_API_TOKEN") or "").strip()
    errors: list[str] = []
    prefer = (os.environ.get("MARKET_PRICE_SOURCE") or "auto").strip().lower()

    try_energy_charts = not skip_energy_charts and prefer in ("auto", "energy-charts", "")
    if prefer == "entsoe":
        try_energy_charts = False

    if try_energy_charts:
        try:
            rows = fetch_energy_charts_nl(start, end)
            return rows, "energy-charts"
        except EnergyChartsRateLimitedError as exc:
            errors.append(str(exc))
            # Geen snelle retries bij 429 — direct fallback.
        except Exception as exc:  # noqa: BLE001
            errors.append(f"Energy-Charts: {exc}")
            time.sleep(2.0)

    if token and (not try_energy_charts or prefer != "energy-charts" or errors):
        try:
            rows = fetch_entsoe_nl_day_ahead(start, end, token)
            return rows, "entsoe"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"ENTSO-E: {exc}")
    elif not token and errors:
        errors.append(
            "ENTSO-E: geen token — zet ENTSOE_API_TOKEN in de sync-container (gratis op transparency.entsoe.eu)"
        )

    raise RuntimeError("Marktprijzen niet opgehaald. " + " | ".join(errors))


def chunk_date_ranges(start: date, end: date, *, chunk_days: int = 7) -> list[tuple[date, date]]:
    ranges: list[tuple[date, date]] = []
    cursor = start
    while cursor < end:
        chunk_end = min(end, cursor + timedelta(days=chunk_days))
        ranges.append((cursor, chunk_end))
        cursor = chunk_end
    return ranges
