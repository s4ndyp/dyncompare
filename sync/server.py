from __future__ import annotations

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from pocketbase_client import PocketBaseClient
from sync import run_sync


def _pb_datetime(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000Z")

app = FastAPI(title="DynCompare Sync", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SyncRequest(BaseModel):
    days: int = Field(default=400, ge=1, le=730)
    include_market_prices: bool = True
    market_missing_only: bool | None = None
    sync_ha: bool = True
    trigger: str = "manual"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sync")
async def sync(body: SyncRequest | None = None) -> dict:
    body = body or SyncRequest()
    pb = PocketBaseClient()
    started_at = datetime.now(tz=timezone.utc)
    market_missing = body.market_missing_only
    try:
        settings = await pb.get_settings()
        if market_missing is None:
            market_missing = bool(settings.get("market_sync_missing_only"))
    except Exception:
        settings = None

    log_base = {
        "started_at": _pb_datetime(started_at),
        "sync_ha": body.sync_ha,
        "market_missing_only": bool(market_missing),
        "days": body.days,
        "trigger": body.trigger,
    }

    try:
        result = await run_sync(
            pb,
            days=body.days,
            include_market_prices=body.include_market_prices,
            market_missing_only=body.market_missing_only,
            sync_ha=body.sync_ha,
        )
        finished_at = datetime.now(tz=timezone.utc)
        try:
            await pb.create_record(
                "sync_logs",
                {
                    **log_base,
                    "finished_at": _pb_datetime(finished_at),
                    "status": "success",
                    "message": (result.get("message") or "")[:500],
                    "consumption_hours": int(result.get("consumption_hours") or 0),
                    "price_slots": int(result.get("price_slots") or 0),
                },
            )
        except Exception:
            pass
        return result
    except Exception as exc:  # noqa: BLE001 — API boundary
        finished_at = datetime.now(tz=timezone.utc)
        try:
            if settings is None:
                settings = await pb.get_settings()
            await pb.update_settings(
                settings["id"],
                {"last_sync_message": f"Mislukt: {exc}"},
            )
        except Exception:
            pass
        try:
            await pb.create_record(
                "sync_logs",
                {
                    **log_base,
                    "finished_at": _pb_datetime(finished_at),
                    "status": "error",
                    "message": f"Mislukt: {exc}"[:500],
                    "error_detail": str(exc)[:500],
                },
            )
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=str(exc)) from exc
