from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from pocketbase_client import PocketBaseClient
from sync import run_sync

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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sync")
async def sync(body: SyncRequest | None = None) -> dict:
    body = body or SyncRequest()
    pb = PocketBaseClient()
    try:
        return await run_sync(
            pb,
            days=body.days,
            include_market_prices=body.include_market_prices,
        )
    except Exception as exc:  # noqa: BLE001 — API boundary
        try:
            settings = await pb.get_settings()
            await pb.update_settings(
                settings["id"],
                {"last_sync_message": f"Mislukt: {exc}"},
            )
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=str(exc)) from exc
