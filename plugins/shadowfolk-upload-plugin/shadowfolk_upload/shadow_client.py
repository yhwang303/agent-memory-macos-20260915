from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class ShadowClientError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class ShadowClient:
    def __init__(self, server: str, token: str, timeout: int = 300):
        self.server = server.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[dict[str, Any], int]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{self.server}{path}", data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8")
                return (json.loads(text) if text else {}, response.status)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            retryable = exc.code >= 500
            raise ShadowClientError(f"HTTP {exc.code}: {text}", status=exc.code, retryable=retryable) from exc
        except urllib.error.URLError as exc:
            raise ShadowClientError(f"Network error: {exc}", retryable=True) from exc

    def get_push_record(self, project_path: str) -> dict[str, Any] | None:
        encoded = urllib.parse.quote(project_path, safe="")
        try:
            data, _ = self.request("GET", f"/api/push/push-records/{encoded}")
        except ShadowClientError as exc:
            if exc.status == 404:
                return None
            raise
        return data.get("record", data)

    def push_raw(self, payload: dict[str, Any]) -> dict[str, Any]:
        data, status = self.request("POST", "/api/push/raw", payload)
        if status not in (200, 201):
            raise ShadowClientError(f"Unexpected push status: {status}", status=status, retryable=status >= 500)
        return data

    def update_push_record(self, project_path: str, data: dict[str, Any]) -> dict[str, Any]:
        encoded = urllib.parse.quote(project_path, safe="")
        response, _ = self.request("PUT", f"/api/push/push-records/{encoded}", data)
        return response.get("record", response)
