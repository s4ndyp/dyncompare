from __future__ import annotations

import os
from typing import Any

import httpx

PB_URL = os.environ.get("POCKETBASE_URL", "http://127.0.0.1:8090").rstrip("/")


def _http_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text.strip() or response.reason_phrase
    parts = [body.get("message") or ""]
    data = body.get("data")
    if isinstance(data, dict):
        for key, val in data.items():
            if isinstance(val, dict) and val.get("message"):
                parts.append(f"{key}: {val['message']}")
    return " — ".join(p for p in parts if p)


class PocketBaseClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or PB_URL).rstrip("/")

    async def list_all(
        self,
        collection: str,
        *,
        filter_query: str | None = None,
        sort: str | None = None,
        per_page: int = 200,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        total_pages = 1
        async with httpx.AsyncClient(timeout=120.0) as client:
            while page <= total_pages:
                params: dict[str, str] = {
                    "page": str(page),
                    "perPage": str(per_page),
                }
                if filter_query:
                    params["filter"] = filter_query
                if sort:
                    params["sort"] = sort
                res = await client.get(
                    f"{self.base_url}/api/collections/{collection}/records",
                    params=params,
                )
                if not res.is_success:
                    raise httpx.HTTPStatusError(
                        _http_error_detail(res),
                        request=res.request,
                        response=res,
                    )
                data = res.json()
                items.extend(data.get("items") or [])
                total_pages = data.get("totalPages") or 1
                page += 1
        return items

    async def get_settings(self) -> dict[str, Any]:
        rows = await self.list_all("settings", sort="id")
        if not rows:
            raise RuntimeError("Geen settings record in PocketBase")
        return rows[0]

    async def update_settings(self, record_id: str, payload: dict[str, Any]) -> None:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.patch(
                f"{self.base_url}/api/collections/settings/records/{record_id}",
                json=payload,
            )
            if not res.is_success:
                raise httpx.HTTPStatusError(
                    _http_error_detail(res),
                    request=res.request,
                    response=res,
                )

    async def upsert_by_period(
        self,
        collection: str,
        period_start: str,
        payload: dict[str, Any],
    ) -> None:
        filter_query = f'period_start="{period_start}"'
        existing = await self.list_all(collection, filter_query=filter_query, per_page=1)
        async with httpx.AsyncClient(timeout=60.0) as client:
            if existing:
                record_id = existing[0]["id"]
                res = await client.patch(
                    f"{self.base_url}/api/collections/{collection}/records/{record_id}",
                    json=payload,
                )
            else:
                body = {"period_start": period_start, **payload}
                res = await client.post(
                    f"{self.base_url}/api/collections/{collection}/records",
                    json=body,
                )
            if not res.is_success:
                raise httpx.HTTPStatusError(
                    _http_error_detail(res),
                    request=res.request,
                    response=res,
                )

    async def batch_upsert_price_slots(self, rows: list[dict[str, Any]]) -> int:
        saved = 0
        for row in rows:
            price = row.get("price_eur_kwh")
            if not isinstance(price, (int, float)) or price != price:  # NaN
                continue
            await self.upsert_by_period("price_slots", row["period_start"], row)
            saved += 1
        return saved

    async def batch_upsert_consumption(self, rows: list[dict[str, Any]]) -> int:
        saved = 0
        for row in rows:
            period = row["period_start"]
            payload = {
                "import_t1_kwh": row["import_t1_kwh"],
                "import_t2_kwh": row["import_t2_kwh"],
                "export_t1_kwh": row["export_t1_kwh"],
                "export_t2_kwh": row["export_t2_kwh"],
            }
            await self.upsert_by_period("consumption_hours", period, payload)
            saved += 1
        return saved
