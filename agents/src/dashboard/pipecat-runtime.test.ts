import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {voiceRuntimeConfig,voiceServiceAuth,mountPipecatRuntime} from './pipecat-runtime.js';
test('opt-in mount exposes browser-authenticated creation without legacy worker token',async()=>{
 const app=express();app.use(express.json());let writes=0;
 const auth:any=(req:any,res:any,next:any)=>{if(req.get('x-fixture')!=='yes')return res.sendStatus(401);req.user={id:'fixture'};next();};
 const execute=async()=>{writes++;return [];};
 const language=async(id:string,requested:unknown)=>{assert.equal(id,'fixture');if(requested!=='ru')throw Error('wrong language');return 'ru';};
 assert.equal(mountPipecatRuntime(express(),auth,execute,language,{}),false);
 assert.equal(mountPipecatRuntime(app,auth,execute,language,{LINGLANG_VOICE_ENABLED:'1',LINGLANG_VOICE_SERVICE_TOKEN:'s'.repeat(32),LINGLANG_VOICE_TICKET_SECRET:'t'.repeat(32)}),true);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try {
  assert.equal((await fetch(base+'/api/voice/sessions',{method:'POST'})).status,401);
  const response=await fetch(base+'/api/voice/sessions',{method:'POST',headers:{'x-fixture':'yes','content-type':'application/json'},body:JSON.stringify({language:'ru',userId:'forged'})});
  assert.equal(response.status,201);const body=await response.json();assert.ok(body.ticket);assert.equal(body.transport,'smallwebrtc');assert.equal(writes,1);
  assert.equal((await fetch(base+'/internal/voice/claim',{method:'POST'})).status,403);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('voice runtime is off by default and requires independent strong credentials',()=>{
 assert.equal(voiceRuntimeConfig({}),null);
 assert.throws(()=>voiceRuntimeConfig({LINGLANG_VOICE_ENABLED:'typo'}));
 assert.throws(()=>voiceRuntimeConfig({LINGLANG_VOICE_ENABLED:'1'}));
 assert.throws(()=>voiceRuntimeConfig({LINGLANG_VOICE_ENABLED:'1',LINGLANG_VOICE_SERVICE_TOKEN:'x'.repeat(32),LINGLANG_VOICE_TICKET_SECRET:'x'.repeat(32)}));
 assert.ok(voiceRuntimeConfig({LINGLANG_VOICE_ENABLED:'1',LINGLANG_VOICE_SERVICE_TOKEN:'s'.repeat(32),LINGLANG_VOICE_TICKET_SECRET:'t'.repeat(32)}));
});
test('worker guard requires direct loopback plus service token, ignoring forwarded IP',()=>{
 const guard=voiceServiceAuth('fixture-secret');
 const run=(address:string,header:string)=>{
  let status=0;let passed=false;
  const req={socket:{remoteAddress:address},get:()=>header,ip:'127.0.0.1'} as any;
  const res={status:(code:number)=>{status=code;return res;},json:()=>{}} as any;
  guard(req,res,()=>{passed=true;});return {status,passed};
 };
 assert.equal(run('127.0.0.1','Bearer fixture-secret').passed,true);
 assert.equal(run('::ffff:127.0.0.1','Bearer fixture-secret').passed,true);
 assert.equal(run('192.0.2.1','Bearer fixture-secret').status,403);
 assert.equal(run('127.0.0.1','Bearer wrong').status,403);
});
