import {test} from 'node:test';
import assert from 'node:assert/strict';
import { resolvePipecatProviders } from './pipecat-bootstrap.js';
test('Gemini overrides saved cascade and requires a real key',()=>{
 const byo={realtimeEnabled:true,llm:{baseUrl:'http://wrong/v1',model:'wrong'}} as any;
 const result=resolvePipecatProviders(byo,'fixture-google-key',{});
 assert.equal(result.mode,'gemini');assert.equal(result.gemini?.apiKey,'fixture-google-key');assert.equal(result.llm,undefined);
 assert.throws(()=>resolvePipecatProviders(byo,null,{}));
});
test('cascade requires all components; preserves explicit model endpoints and voice',()=>{
 const component={baseUrl:'http://127.0.0.1:9999/v1',model:'configured',apiKey:'fixture'};
 const result=resolvePipecatProviders({llm:component,stt:component,tts:{...component,voice:'speaker'}} as any,null,{});
 assert.equal(result.mode,'cascade');assert.equal(result.tts?.voice,'speaker');
 assert.throws(()=>resolvePipecatProviders({llm:component} as any,null,{}));
});
