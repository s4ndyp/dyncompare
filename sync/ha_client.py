from __future__ import annotations

import json
import ssl
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

from websocket import create_connection


def _ws_url(ha_url: str) -> str:
    parsed = urlparse(ha_url.rstrip("/"))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    netloc = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ""
    base_path = path.rstrip("/")
    return urlunparse((scheme, netloc, f"{base_path}/api/websocket", "", "", ""))


def _ms_to_iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S.000Z")


class HomeAssistantClient:
    def __init__(self, base_url: str, token: str, *, verify_tls: bool = True) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token.strip()
        self.verify_tls = verify_tls

    def _connect(self):
        sslopt = None if self.verify_tls else {"cert_reqs": ssl.CERT_NONE}
        ws = create_connection(_ws_url(self.base_url), sslopt=sslopt, timeout=90)
        hello = json.loads(ws.recv())
        if hello.get("type") != "auth_required":
            ws.close()
            raise RuntimeError("Onverwacht Home Assistant websocket antwoord")
        ws.send(json.dumps({"type": "auth", "access_token": self.token}))
        auth = json.loads(ws.recv())
        if auth.get("type") != "auth_ok":
            ws.close()
            raise RuntimeError("Home Assistant authenticatie mislukt")
        return ws

    def _call(self, ws, msg_type: str, **payload: Any) -> Any:
        msg_id = payload.pop("id", 1)
        ws.send(json.dumps({"id": msg_id, "type": msg_type, **payload}))
        while True:
            raw = ws.recv()
            data = json.loads(raw)
            if data.get("id") == msg_id:
                if data.get("type") == "result" and data.get("success"):
                    return data.get("result")
                err = data.get("error") or {}
                raise RuntimeError(err.get("message") or "Home Assistant request mislukt")

    def statistics_during_period(
        self,
        statistic_ids: list[str],
        start_time: str,
        end_time: str,
        *,
        period: str = "hour",
        types: list[str] | None = None,
        units: dict[str, str] | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        ws = self._connect()
        try:
            payload: dict[str, Any] = {
                "start_time": start_time,
                "end_time": end_time,
                "statistic_ids": statistic_ids,
                "period": period,
                "types": types or ["change"],
            }
            if units:
                payload["units"] = units
            result = self._call(ws, "recorder/statistics_during_period", **payload)
            if not isinstance(result, dict):
                return {}
            return result
        finally:
            ws.close()

    @staticmethod
    def values_by_start(
        series: list[dict[str, Any]] | None,
        field: str = "change",
    ) -> dict[int, float]:
        out: dict[int, float] = {}
        if not series:
            return out
        for point in series:
            start = point.get("start")
            if start is None:
                continue
            raw = point.get(field)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            out[int(start)] = value
        return out

    @staticmethod
    def changes_by_start(series: list[dict[str, Any]] | None) -> dict[int, float]:
        out: dict[int, float] = {}
        if not series:
            return out
        for point in series:
            start = point.get("start")
            if start is None:
                continue
            change = point.get("change")
            if change is None:
                continue
            try:
                value = float(change)
            except (TypeError, ValueError):
                continue
            if value < 0:
                value = 0.0
            out[int(start)] = value
        return out


def merge_hourly_consumption(
    import_t1: dict[int, float],
    import_t2: dict[int, float],
    export_t1: dict[int, float],
    export_t2: dict[int, float],
) -> list[dict[str, Any]]:
    keys = sorted(set(import_t1) | set(import_t2) | set(export_t1) | set(export_t2))
    rows: list[dict[str, Any]] = []
    for start_ms in keys:
        rows.append(
            {
                "period_start": _ms_to_iso(start_ms),
                "import_t1_kwh": round(import_t1.get(start_ms, 0.0), 6),
                "import_t2_kwh": round(import_t2.get(start_ms, 0.0), 6),
                "export_t1_kwh": round(export_t1.get(start_ms, 0.0), 6),
                "export_t2_kwh": round(export_t2.get(start_ms, 0.0), 6),
            }
        )
    return rows
