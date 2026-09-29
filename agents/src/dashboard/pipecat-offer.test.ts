import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {installVoiceOfferProxy} from './pipecat-offer.js';
import {issueVoiceTicket} from '../lib/pipecat-session-ticket.js';
test('offer proxy binds ticket owner and forwards only allowed signaling fields',async()=>{
 const upstream=express();upstream.use(express.json());let received:any;
 upstream.post('/api/offer',(req,res)=>{received=req.body;res.json({type:'answer',sdp:'fixture-answer',pc_id:'fixture-peer'});});
 const runner=upstream.listen(0,'127.0.0.1');await new Promise<void>(r=>runner.once('listening',r));
 const app=express();app.use(express.json());const secret='fixture-ticket-secret-at-least-32-chars';
 installVoiceOfferProxy(app,(req,res,next)=>{(req as any).user={id:'owner'};next();},secret,`http://127.0.0.1:${(runner.address() as any).port}`);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try {
  const base=`http://127.0.0.1:${(server.address() as any).port}/api/voice/offer`;
  const ticket=(userId:string)=>issueVoiceTicket({sessionId:'session',userId,language:'ru',transport:'smallwebrtc'},secret);
  const post=(body:any)=>fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({ticket:ticket('someone-else'),sdp:'fixture',type:'offer'})).status,403);
  assert.equal(received,undefined);
  const own=ticket('owner');
  const response=await post({ticket:own,sdp:'fixture',type:'offer',userId:'forged',request_data:{prompt:'forged'},baseUrl:'https://wrong.invalid'});
  assert.equal(response.status,200);
  assert.deepEqual(received,{sdp:'fixture',type:'offer',request_data:{ticket:own}});
  assert.equal((await response.json()).pc_id,'fixture-peer');
  assert.throws(()=>installVoiceOfferProxy(express(),(_q,_r,n)=>n(),secret,'https://public.invalid'));
 }finally{for(const s of [server,runner]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}}
});
