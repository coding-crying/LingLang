"""Pipeline assembly from a Node-authenticated private bootstrap.

Not an authentication boundary: only pass the result of ProductSession.claim.
No environment fallback, probe prompt, learner guessing, or persistence here.
"""
from dataclasses import dataclass
from typing import Any
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService, GeminiVADParams

@dataclass
class ProductPipeline:
    pipeline: Pipeline
    context: LLMContext
    llm: Any
    user_aggregator: Any
    assistant_aggregator: Any
    stt: Any = None
    tts: Any = None

def build_product_pipeline(transport, bootstrap: dict) -> ProductPipeline:
    from urllib.parse import urlsplit
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.services.openai.stt import OpenAISTTService
    from pipecat.services.openai.tts import OpenAITTSService

    for field in ('sessionId','userId','language','prompt'):
        if not isinstance(bootstrap.get(field),str) or not bootstrap[field].strip():
            raise ValueError(f'Missing authenticated bootstrap {field}')
    providers = bootstrap.get('providers',{})
    mode = providers.get('mode')
    if mode not in ('gemini','cascade'):
        raise ValueError('Explicit provider mode required')
    messages = bootstrap.get('messages',[])
    if not isinstance(messages,list) or any(not isinstance(m,dict) or m.get('role') not in ('user','assistant') or not isinstance(m.get('content'),str) for m in messages):
        raise ValueError('Invalid conversation history')
    context = LLMContext(messages=[{'role':'system','content':bootstrap['prompt']}, *messages])
    stt = tts = None
    if mode == 'gemini':
        config = providers.get('gemini',{})
        if not config.get('apiKey') or not config.get('model'):
            raise ValueError('Explicit Gemini key and model required')
        llm = GeminiLiveLLMService(api_key=config['apiKey'], system_instruction=bootstrap['prompt'], settings=GeminiLiveLLMService.Settings(model=config['model'],vad=GeminiVADParams(disabled=True)))
    else:
        for name in ('llm','stt','tts'):
            config = providers.get(name,{})
            url = urlsplit(config.get('baseUrl',''))
            if url.scheme not in ('http','https') or not url.hostname or url.username or url.password or not config.get('model'):
                raise ValueError(f'Explicit {name} endpoint and model required')
        if not providers['tts'].get('voice'):
            raise ValueError('Explicit TTS voice required')
        def credentials(name):
            p = providers[name]
            return dict(base_url=p['baseUrl'],api_key=p.get('apiKey') or 'unused')
        llm = OpenAILLMService(**credentials('llm'),settings=OpenAILLMService.Settings(model=providers['llm']['model']))
        # Automatic language detection preserves native/target code-switching.
        stt = OpenAISTTService(**credentials('stt'),settings=OpenAISTTService.Settings(model=providers['stt']['model'],language=None))
        tts = OpenAITTSService(**credentials('tts'),settings=OpenAITTSService.Settings(model=providers['tts']['model'],voice=providers['tts']['voice']))
    user, assistant = LLMContextAggregatorPair(context,user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()))
    processors = [transport.input(), *([stt] if stt else []), user, llm, *([tts] if tts else []), transport.output(), assistant]
    return ProductPipeline(Pipeline(processors),context,llm,user,assistant,stt,tts)
