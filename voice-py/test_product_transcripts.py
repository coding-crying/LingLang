import unittest
from types import SimpleNamespace
from product_transcripts import TranscriptRecorder

class TranscriptTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_identical_event_and_preserves_interruption(self):
        calls=[]
        async def submit(event):
            calls.append(dict(event))
            if len(calls)==1: raise ConnectionError('lost response')
            return {'accepted':True,'eventId':event['eventId'],'processingStatus':'pending'}
        recorder=TranscriptRecorder(SimpleNamespace(submit_final=submit))
        recorder.add('tutor','Partial spoken reply',True)
        await recorder.close()
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[0],calls[1])
        self.assertTrue(calls[-1]['interrupted'])
        self.assertNotIn('userId',calls[-1])

    async def test_binds_finalized_aggregator_events_for_each_mode(self):
        for mode in ('gemini','cascade'):
            calls=[]
            async def submit(event):
                calls.append(event)
                return {'accepted':True,'eventId':event['eventId']}
            handlers={}
            emitter=SimpleNamespace(add_event_handler=lambda name,callback:handlers.update({name:callback}))
            recorder=TranscriptRecorder(SimpleNamespace(submit_final=submit))
            recorder.bind(emitter,emitter,mode)
            message=SimpleNamespace(content='Olá',interrupted=False)
            if mode=='gemini': await handlers['on_user_turn_message_added'](emitter,message)
            else: await handlers['on_user_turn_stopped'](emitter,None,message)
            await handlers['on_assistant_turn_stopped'](emitter,message)
            await recorder.close()
            self.assertEqual([e['role'] for e in calls],['learner','tutor'])

    async def test_blank_is_ignored_and_failed_delivery_surfaces(self):
        async def submit(event): raise ConnectionError('offline')
        recorder=TranscriptRecorder(SimpleNamespace(submit_final=submit))
        recorder.add('learner',' ',None)
        recorder.add('learner','مرحبا',None)
        with self.assertRaisesRegex(RuntimeError,'not durably accepted'):
            await recorder.close()
