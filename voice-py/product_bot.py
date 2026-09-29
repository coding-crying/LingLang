"""Authenticated product runtime; isolated from the public probe and LiveKit.

Runner request body must contain a one-use ticket issued by Node. The body
cannot select identity, providers, prompt, or internal API destination.
Learning/tool parity remains a release gate: do not deploy as production yet.
"""
import os
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import TransportParams
from product_pipeline import build_product_pipeline
from product_session import ProductSession
from product_transcripts import TranscriptRecorder

async def bot(runner_args):
    body = runner_args.body
    ticket = body.get('ticket') if isinstance(body,dict) else None
    if not isinstance(ticket,str) or not ticket or len(ticket)>8192:
        raise ValueError('Authenticated voice session ticket required')
    session = await ProductSession.claim(
        os.environ.get('LINGLANG_INTERNAL_URL','http://127.0.0.1:3000'),
        os.environ.get('LINGLANG_VOICE_SERVICE_TOKEN',''),ticket,
    )
    recorder = None
    try:
        transport = await create_transport(runner_args,{
            'webrtc':lambda: TransportParams(audio_in_enabled=True,audio_out_enabled=True),
        })
        assembly = build_product_pipeline(transport,session.bootstrap)
        recorder = TranscriptRecorder(session)
        recorder.bind(assembly.user_aggregator,assembly.assistant_aggregator,session.bootstrap['providers']['mode'])
        task = PipelineTask(assembly.pipeline,params=PipelineParams(enable_metrics=True))
        @transport.event_handler('on_client_connected')
        async def connected(_transport,_client):
            await task.queue_frames([LLMRunFrame()])
        @transport.event_handler('on_client_disconnected')
        async def disconnected(_transport,_client):
            await task.cancel()
        await PipelineRunner(handle_sigint=getattr(runner_args,'handle_sigint',False)).run(task)
    finally:
        try:
            if recorder: await recorder.close()
        finally:
            await session.close()

if __name__=='__main__':
    from pipecat.runner.run import main
    main()
