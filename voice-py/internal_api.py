"""Client for the Node dashboard's /internal agentic API.

The Processor, Supervisor, ContextManager and vocabulary queries all stay in
TypeScript — ~2,300 lines of prompt-tuned logic carrying dozens of dated
live-failure fixes. Re-implementing any of it in Python would be the single
biggest available way to silently regress the product, so this is a client,
not a port. See ../PIPECAT_MIGRATION.md.
"""

from __future__ import annotations

import os
import pathlib
from typing import Any

import aiohttp
from dotenv import load_dotenv
from loguru import logger

# Load config here rather than relying on the importer having done it. This
# module reads INTERNAL_SERVICE_TOKEN at construction time, and it is imported
# by scripts and tests that are not bot.py; without this, those fail with a
# "token is not set" error that points at configuration when the real cause is
# import order. load_dotenv does not overwrite variables already set, so an
# explicit environment still wins.
_HERE = pathlib.Path(__file__).parent
load_dotenv(_HERE / ".env.local")
load_dotenv(_HERE.parent / "agents" / ".env.local")


class InternalAPIError(RuntimeError):
    """Raised when the internal API answers with a non-2xx status."""


class InternalAPI:
    """Thin async client. One instance per session; call `close()` when done."""

    def __init__(self, base: str | None = None, token: str | None = None, timeout_s: float = 10.0):
        self._base = (base or os.environ.get("INTERNAL_API_BASE", "http://127.0.0.1:3001")).rstrip("/")
        self._token = token or os.environ.get("INTERNAL_SERVICE_TOKEN", "")
        if not self._token:
            raise RuntimeError(
                "INTERNAL_SERVICE_TOKEN is not set. The Node dashboard refuses every "
                "/internal request without it (503), by design."
            )
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)
        self._session: aiohttp.ClientSession | None = None

    async def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=self._timeout,
                headers={"Authorization": f"Bearer {self._token}"},
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        client = await self._client()
        url = f"{self._base}/internal{path}"
        async with client.request(method, url, **kw) as res:
            text = await res.text()
            if res.status >= 300:
                raise InternalAPIError(f"{method} {path} -> {res.status}: {text[:300]}")
            return await res.json() if text else None

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        return await self._request("GET", path, params=clean)

    async def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return await self._request("POST", path, json=body or {})

    # -- convenience wrappers ------------------------------------------------

    async def health(self) -> Any:
        return await self.get("/health")

    async def context_bundle(self, user_id: str, language_code: str | None = None) -> Any:
        """The session-open bundle: initial context, notes, summaries, recent."""
        return await self.get(f"/context/{user_id}", {"languageCode": language_code})

    async def write_note(self, user_id: str, category: str, content: str, source: str = "observed") -> Any:
        return await self.post(
            f"/context/{user_id}/note",
            {"category": category, "content": content, "source": source},
        )

    async def run_processor(self, user_id: str, utterance: str, context: str, options: dict | None = None) -> Any:
        """The Processor. Writes vocabulary/FSRS state; not on the voice path."""
        return await self.post(
            "/processor",
            {"userId": user_id, "utterance": utterance, "context": context, "options": options or {}},
        )

    async def write_session_summary(self, user_id: str, data: dict[str, Any]) -> Any:
        return await self.post("/session-summary", {"userId": user_id, **data})


async def check_reachable(api: InternalAPI) -> bool:
    """Fails loudly at startup rather than on the learner's first question."""
    try:
        await api.health()
        logger.info("internal API reachable")
        return True
    except Exception as e:
        logger.error(f"internal API unreachable: {e}")
        return False
