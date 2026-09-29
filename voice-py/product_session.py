"""Private Node session client. Never accepts a caller-selected learner ID."""
from __future__ import annotations
from urllib.parse import quote, urlsplit
from typing import Any
import aiohttp

class SessionAPIError(RuntimeError):
    pass

class ProductSession:
    def __init__(self, client: aiohttp.ClientSession, base: str, session_id: str, worker_token: str, bootstrap: dict):
        self._client = client
        self._base = base
        self.session_id = session_id
        self._worker_token = worker_token
        self.bootstrap = bootstrap

    @classmethod
    async def claim(cls, base: str, service_token: str, ticket: str) -> ProductSession:
        url = urlsplit(base)
        # All-in-one shares loopback. No accidental posting credentials to a
        # browser-supplied endpoint. External service networking is not enabled.
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1', 'localhost') or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
            raise ValueError('Internal API base must be a loopback HTTP origin')
        if not service_token or not ticket:
            raise ValueError('Service authentication and session ticket required')
        client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15), headers={'Authorization':f'Bearer {service_token}'})
        base=base.rstrip('/')
        try:
            async with client.post(base+'/internal/voice/claim',json={'ticket':ticket},allow_redirects=False) as response:
                if response.status != 200:
                    raise SessionAPIError(f'Session claim rejected ({response.status})')
                data=await response.json()
            if not isinstance(data.get('sessionId'),str) or not data['sessionId'] or not isinstance(data.get('workerToken'),str) or not data['workerToken'] or not isinstance(data.get('bootstrap'),dict):
                raise SessionAPIError('Invalid session bootstrap')
            return cls(client,base,data['sessionId'],data['workerToken'],data['bootstrap'])
        except BaseException:
            await client.close()
            raise

    async def submit_final(self, event: dict[str,Any]) -> dict:
        # Retry the SAME eventId if a response is lost. Never generate a new ID
        # on retry, and never interpret accepted/pending as processed learning.
        path='/internal/voice/sessions/'+quote(self.session_id,safe='')+'/events'
        async with self._client.post(self._base+path,json={'event':event},headers={'X-Voice-Worker-Token':self._worker_token},allow_redirects=False) as response:
            if response.status != 202:
                raise SessionAPIError(f'Voice event rejected ({response.status})')
            return await response.json()

    async def close(self) -> None:
        if self._client.closed:
            return
        try:
            path='/internal/voice/sessions/'+quote(self.session_id,safe='')+'/close'
            async with self._client.post(self._base+path,headers={'X-Voice-Worker-Token':self._worker_token},allow_redirects=False) as response:
                if response.status not in (204,403):
                    raise SessionAPIError(f'Session close rejected ({response.status})')
                # 403 also covers an already-revoked/expired session.
        finally:
            await self._client.close()
            self._worker_token=''
            self.bootstrap.clear()
