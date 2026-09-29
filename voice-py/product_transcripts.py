"""Bounded transcript delivery queue; acceptance is not learning completion.

Queue is in-memory until Node acknowledges. Process-crash recovery before ACK
requires a persistent outbox and remains a release gate.
"""
import asyncio
from datetime import datetime, timezone
from uuid import uuid4

class TranscriptRecorder:
    def __init__(self, session):
        self.session=session
        self.queue=asyncio.Queue(maxsize=64)
        self.failed=0
        self.closed=False
        self.worker=asyncio.create_task(self._drain())

    def bind(self, user, assistant, mode):
        async def user_message(_aggregator, message):
            self.add('learner', message.content, None)
        async def user_stopped(_aggregator, _strategy, message):
            self.add('learner', message.content, None)
        async def assistant_stopped(_aggregator, message):
            self.add('tutor', message.content, message.interrupted)
        # Realtime providers emit transcript messages separately from VAD stop;
        # cascade stop combines any interim inference segments into one turn.
        if mode == 'gemini':
            user.add_event_handler('on_user_turn_message_added', user_message)
        else:
            user.add_event_handler('on_user_turn_stopped', user_stopped)
        assistant.add_event_handler('on_assistant_turn_stopped', assistant_stopped)

    def add(self, role, text, interrupted=None):
        if not isinstance(text,str) or not text.strip(): return
        if self.closed: raise RuntimeError('Transcript recorder closed')
        identity=uuid4().hex
        event=dict(eventId=identity,turnId=identity,role=role,text=text,occurredAt=datetime.now(timezone.utc).isoformat(),interrupted=interrupted)
        try: self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.failed+=1
            raise RuntimeError('Transcript delivery queue full') from None

    async def _drain(self):
        while True:
            event=await self.queue.get()
            try:
                if event is None: return
                for attempt in range(3):
                    try:
                        ack=await self.session.submit_final(event)
                        if ack.get('accepted') is not True or ack.get('eventId')!=event['eventId']:
                            raise RuntimeError('Invalid transcript acknowledgement')
                        break
                    except Exception:
                        if attempt==2: self.failed+=1
                        else: await asyncio.sleep(0.1 * (attempt+1))
            finally: self.queue.task_done()

    async def close(self):
        if not self.closed:
            self.closed=True
            await self.queue.put(None)
            await self.worker
        if self.failed: raise RuntimeError('Voice transcripts not durably accepted')
