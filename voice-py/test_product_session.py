import unittest
from aiohttp import web
from product_session import ProductSession, SessionAPIError

class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests=[]
        async def claim(request):
            self.requests.append((request.path,dict(request.headers),await request.json()))
            return web.json_response({'sessionId':'s1','workerToken':'private-worker','bootstrap':{'prompt':'real tutor context'}})
        async def event(request):
            self.requests.append((request.path,dict(request.headers),await request.json()))
            if request.headers.get('X-Voice-Worker-Token')!='private-worker':
                return web.Response(status=403,text='sensitive-server-details')
            return web.json_response({'accepted':True,'processingStatus':'pending'},status=202)
        async def close(request):
            self.requests.append((request.path,dict(request.headers),{}))
            return web.Response(status=204 if request.headers.get('X-Voice-Worker-Token')=='private-worker' else 403)
        app=web.Application();app.router.add_post('/internal/voice/sessions/s1/close',close);app.router.add_post('/internal/voice/claim',claim);app.router.add_post('/internal/voice/sessions/s1/events',event)
        self.runner=web.AppRunner(app);await self.runner.setup()
        site=web.TCPSite(self.runner,'127.0.0.1',0);await site.start()
        self.base='http://127.0.0.1:'+str(site._server.sockets[0].getsockname()[1])
    async def asyncTearDown(self):
        await self.runner.cleanup()
    async def test_claim_and_event_are_session_bound(self):
        session=await ProductSession.claim(self.base,'service-secret','signed-ticket')
        try:
            self.assertEqual(session.bootstrap['prompt'],'real tutor context')
            ack=await session.submit_final({'eventId':'e1','text':'مرحبا'})
            self.assertEqual(ack['processingStatus'],'pending')
            self.assertEqual(self.requests[0][2],{'ticket':'signed-ticket'})
            self.assertEqual(self.requests[1][2],{'event':{'eventId':'e1','text':'مرحبا'}})
            self.assertEqual(self.requests[1][1]['Authorization'],'Bearer service-secret')
            self.assertNotIn('private-worker',repr(session))
        finally: await session.close()
    async def test_close_revokes_remote_session_and_clears_secrets(self):
        session=await ProductSession.claim(self.base,'service-secret','signed-ticket')
        await session.close()
        self.assertEqual(self.requests[-1][0],'/internal/voice/sessions/s1/close')
        self.assertTrue(session._client.closed)
        self.assertEqual(session.bootstrap,{})
        await session.close()  # local cleanup is idempotent

    async def test_configuration_fails_closed(self):
        with self.assertRaises(ValueError): await ProductSession.claim(self.base,'','ticket')
        with self.assertRaises(ValueError): await ProductSession.claim('https://public.invalid','secret','ticket')

if __name__=='__main__': unittest.main()
