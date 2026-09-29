import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerPolicy, assertProvidersEditable, deploymentProviders} from './provider-policy.js';
test('default policy preserves user configuration; invalid policy fails closed',()=>{
 assert.equal(providerPolicy({}),'user');
 assert.equal(deploymentProviders({}),null);
 assert.throws(()=>providerPolicy({LINGLANG_PROVIDER_POLICY:'typo'}));
 assert.throws(()=>assertProvidersEditable({LINGLANG_PROVIDER_POLICY:'deployment'}),/locked/);
});
test('deployment Gemini explicitly overrides user cascade',()=>{
 assert.deepEqual(deploymentProviders({LINGLANG_PROVIDER_POLICY:'deployment',SERVICE_MODE:'gemini'}),{realtimeEnabled:true});
});
test('deployment cascade requires explicit components and reads only deployment values',()=>{
 const env={LINGLANG_PROVIDER_POLICY:'deployment',SERVICE_MODE:'cloud',LINGLANG_LLM_URL:'https://llm.example/v1',LINGLANG_LLM_MODEL:'chat',LINGLANG_LLM_API_KEY:'fixture',LINGLANG_STT_URL:'https://stt.example/v1',LINGLANG_STT_MODEL:'transcribe',LINGLANG_TTS_URL:'https://tts.example/v1',LINGLANG_TTS_MODEL:'speech',LINGLANG_TTS_VOICE:'voice'};
 const resolved=deploymentProviders(env)!;
 assert.equal(resolved.realtimeEnabled,false);assert.equal(resolved.llm?.apiKey,'fixture');assert.equal(resolved.tts?.voice,'voice');
 assert.throws(()=>deploymentProviders({...env,LINGLANG_STT_MODEL:''}));
});
