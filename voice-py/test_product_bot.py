import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from pipecat.processors.frame_processor import FrameProcessor
from product_bot import bot

class Transport:
    def __init__(self): self.handlers={};self.source=FrameProcessor();self.sink=FrameProcessor()
    def input(self): return self.source
    def output(self): return self.sink
    def event_handler(self,name):
        def register(fn): self.handlers[name]=fn;return fn
        return register

class BotTests(unittest.IsolatedAsyncioTestCase):
    async def test_requires_ticket_before_claim_or_transport(self):
        with patch('product_bot.ProductSession.claim',new_callable=AsyncMock) as claim:
            with self.assertRaises(ValueError): await bot(SimpleNamespace(body={}))
            claim.assert_not_called()

    async def test_claim_build_run_and_cleanup(self):
        transport=Transport()
        session=SimpleNamespace(bootstrap=dict(sessionId='s',userId='u',language='ru',prompt='Existing tutor',messages=[],providers=dict(mode='gemini',gemini=dict(apiKey='fixture-key',model='gemini-3.1-flash-live-preview'))),close=AsyncMock())
        async def run(task):
            task.queue_frames=AsyncMock();task.cancel=AsyncMock()
            await transport.handlers['on_client_connected'](transport,None)
            task.queue_frames.assert_awaited_once()
            await transport.handlers['on_client_disconnected'](transport,None)
            task.cancel.assert_awaited_once()
        with patch.dict('os.environ',{'LINGLANG_INTERNAL_URL':'http://127.0.0.1:3000','LINGLANG_VOICE_SERVICE_TOKEN':'fixture-secret'}),patch('product_bot.ProductSession.claim',new_callable=AsyncMock,return_value=session) as claim,patch('product_bot.create_transport',new_callable=AsyncMock,return_value=transport),patch('product_bot.PipelineRunner') as runner:
            runner.return_value.run=AsyncMock(side_effect=run)
            await bot(SimpleNamespace(body={'ticket':'signed-ticket','userId':'ignored'},handle_sigint=False))
            claim.assert_awaited_once_with('http://127.0.0.1:3000','fixture-secret','signed-ticket')
            session.close.assert_awaited_once()

    async def test_pipeline_failure_still_closes_claim(self):
        session=SimpleNamespace(bootstrap={},close=AsyncMock())
        with patch.dict('os.environ',{'LINGLANG_VOICE_SERVICE_TOKEN':'fixture-secret'}),patch('product_bot.ProductSession.claim',new_callable=AsyncMock,return_value=session),patch('product_bot.create_transport',new_callable=AsyncMock,side_effect=RuntimeError('transport failed')):
            with self.assertRaises(RuntimeError): await bot(SimpleNamespace(body={'ticket':'ticket'}))
            session.close.assert_awaited_once()
