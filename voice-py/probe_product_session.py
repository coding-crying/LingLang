"""Cross-language integration fixture, not a microphone or inference probe."""
import asyncio
import json
import sys
from product_session import ProductSession, SessionAPIError
from product_transcripts import TranscriptRecorder

async def main():
    config=json.loads(sys.stdin.read())
    session=await ProductSession.claim(config['base'],config['serviceToken'],config['ticket'])
    assert session.bootstrap['userId']=='integration-learner'
    recorder=TranscriptRecorder(session)
    recorder.add('learner','مرحبا',None)
    recorder.add('tutor','أهلاً!',True)
    await recorder.close()
    # Replay a fixed identity twice to exercise durable HTTP idempotency.
    event=dict(eventId='replayed-event',turnId='replayed-turn',role='learner',text='شكراً',occurredAt='2026-01-01T00:00:00Z',interrupted=None)
    await session.submit_final(event)
    await session.submit_final(event)
    await session.close()
    try:
        await ProductSession.claim(config['base'],config['serviceToken'],config['ticket'])
    except SessionAPIError:
        pass
    else:
        raise AssertionError('Closed ticket was reusable')
    print('Python claim, transcript delivery, replay and close passed')

if __name__=='__main__': asyncio.run(main())
