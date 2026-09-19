from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from ha_client import HomeAssistantClient, merge_hourly_consumption
from market_prices import chunk_date_ranges, fetch_nl_day_ahead_slots
from pocketbase_client import PocketBaseClient

AMSTERDAM = ZoneInfo("Europe/Amsterdam")


def _iso_ha(dt: datetime) -> str:
    local = dt.astimezone(AMSTERDAM)
    return local.isoformat(timespec="seconds")


def _ms_to_iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S.000Z")


async def run_sync(
    pb: PocketBaseClient,
    *,
    days: int = 400,
    include_market_prices: bool = True,
) -> dict[str, Any]:
    settings = await pb.get_settings()
    ha_url = (settings.get("ha_url") or "").strip()
    ha_token = (settings.get("ha_token") or "").strip()

    if not ha_url or not ha_token:
        raise RuntimeError("Vul Home Assistant URL en token in via Instellingen")

    await pb.update_settings(
        settings["id"],
        {"last_sync_message": "Bezig: verbruik ophalen uit Home Assistant…"},
    )

    sensors = {
        "import_t1": settings.get("sensor_import_t1") or "sensor.p1_energy_consumption_tarif_1",
        "import_t2": settings.get("sensor_import_t2") or "sensor.p1_energy_consumption_tarif_2",
        "export_t1": settings.get("sensor_export_t1") or "sensor.p1_energy_production_tarif_1",
        "export_t2": settings.get("sensor_export_t2") or "sensor.p1_energy_production_tarif_2",
    }

    now = datetime.now(tz=AMSTERDAM)
    start = now - timedelta(days=max(1, min(days, 730)))
    end = now + timedelta(hours=1)

    ha = HomeAssistantClient(ha_url, ha_token, verify_tls=True)
    stats = ha.statistics_during_period(
        list(sensors.values()),
        _iso_ha(start),
        _iso_ha(end),
        period="hour",
        types=["change"],
        units={"energy": "kWh"},
    )

    import_t1 = HomeAssistantClient.changes_by_start(stats.get(sensors["import_t1"]))
    import_t2 = HomeAssistantClient.changes_by_start(stats.get(sensors["import_t2"]))
    export_t1 = HomeAssistantClient.changes_by_start(stats.get(sensors["export_t1"]))
    export_t2 = HomeAssistantClient.changes_by_start(stats.get(sensors["export_t2"]))

    consumption_rows = merge_hourly_consumption(import_t1, import_t2, export_t1, export_t2)
    consumption_saved = await pb.batch_upsert_consumption(consumption_rows)

    await pb.update_settings(
        settings["id"],
        {
            "last_sync_message": (
                f"Bezig: {consumption_saved} uren verbruik opgeslagen, prijzen ophalen…"
            ),
        },
    )

    price_saved = 0
    price_stat = (settings.get("price_statistic_id") or "").strip()
    ha_price_rows: list[dict[str, Any]] = []
    if price_stat:
        for period in ("5minute", "hour"):
            price_stats = ha.statistics_during_period(
                [price_stat],
                _iso_ha(start),
                _iso_ha(end),
                period=period,
                types=["mean"],
            )
            series = price_stats.get(price_stat) or []
            interval_minutes = 5 if period == "5minute" else 60
            for start_ms, mean_price in HomeAssistantClient.values_by_start(series, "mean").items():
                ha_price_rows.append(
                    {
                        "period_start": _ms_to_iso(start_ms),
                        "price_eur_kwh": round(mean_price, 6),
                        "source": "home_assistant",
                        "interval_minutes": interval_minutes,
                    }
                )
            if ha_price_rows:
                break

        if not ha_price_rows and "." in price_stat:
            merged: dict[int, float] = {}
            chunk_start = start
            while chunk_start < end:
                chunk_end = min(end, chunk_start + timedelta(days=14))
                history = ha.history_during_period(
                    [price_stat],
                    _iso_ha(chunk_start),
                    _iso_ha(chunk_end),
                )
                merged.update(HomeAssistantClient.hourly_means_from_history(history))
                chunk_start = chunk_end
            for start_ms, mean_price in sorted(merged.items()):
                ha_price_rows.append(
                    {
                        "period_start": _ms_to_iso(start_ms),
                        "price_eur_kwh": round(mean_price, 6),
                        "source": "home_assistant",
                        "interval_minutes": 60,
                    }
                )

        if ha_price_rows:
            price_saved += await pb.batch_upsert_price_slots(ha_price_rows)

    if include_market_prices:
        start_day = start.date()
        end_day = (now + timedelta(days=1)).date()
        price_rows: list[dict[str, Any]] = []
        for chunk_start, chunk_end in chunk_date_ranges(start_day, end_day):
            price_rows.extend(fetch_nl_day_ahead_slots(chunk_start, chunk_end))
        price_saved += await pb.batch_upsert_price_slots(price_rows)

    message = f"{consumption_saved} uur verbruik, {price_saved} prijs-slots gesynchroniseerd"
    await pb.update_settings(
        settings["id"],
        {
            "last_sync_at": datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000Z"),
            "last_sync_message": message,
        },
    )

    return {
        "consumption_hours": consumption_saved,
        "price_slots": price_saved,
        "message": message,
        "from": start.isoformat(),
        "to": end.isoformat(),
    }
