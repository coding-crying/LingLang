import unittest
from product_pipeline import build_product_pipeline
from pipecat.processors.frame_processor import FrameProcessor

class Transport:
    def __init__(self):
        self.source, self.sink = FrameProcessor(), FrameProcessor()
    def input(self): return self.source
    def output(self): return self.sink

class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_cascade_builds_real_services(self):
        endpoint = dict(baseUrl='http://127.0.0.1:9999/v1',apiKey='',model='explicit-model')
        bootstrap = dict(sessionId='s',userId='u',language='ru',prompt='Tutor contract',messages=[],providers=dict(mode='cascade',llm=endpoint,stt=endpoint,tts={**endpoint,'voice':'speaker'}))
        result = build_product_pipeline(Transport(), bootstrap)
        self.assertEqual(type(result.llm).__name__, 'OpenAILLMService')
        self.assertEqual(type(result.stt).__name__, 'OpenAISTTService')
        self.assertEqual(type(result.tts).__name__, 'OpenAITTSService')

    async def test_rejects_missing_identity_prompt_or_provider(self):
        for bootstrap in [{},dict(sessionId='s',userId='u',language='ru',prompt='',providers={}),dict(sessionId='s',userId='u',language='ru',prompt='Tutor',messages=[],providers={'mode':'unknown'})]:
            with self.assertRaises(ValueError):
                build_product_pipeline(Transport(),bootstrap)

    async def test_gemini_uses_authoritative_context(self):
        bootstrap = dict(sessionId='session',userId='learner',language='ru',prompt='Existing tutor instructions',messages=[],providers=dict(mode='gemini',gemini=dict(apiKey='test-not-a-real-key',model='gemini-3.1-flash-live-preview')))
        result = build_product_pipeline(Transport(), bootstrap)
        self.assertEqual(type(result.llm).__name__, 'GeminiLiveLLMService')
        self.assertEqual(result.context.messages[0], {'role':'system','content':bootstrap['prompt']})
        self.assertIsNone(result.stt)
        self.assertIsNone(result.tts)
        self.assertIsNotNone(result.pipeline)
