import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {installPipecatRoutes} from './pipecat-routes.js';
test('browser identity is authoritative; private claim requires service auth; keys never enter public reply',async()=>{
 const app=express();app.use(express.json());
 let created:any;let closed:any;
 const guard=(header:string)=>(req:any,res:any,next:any)=>{if(req.headers[header]!=='fixture')return res.sendStatus(401);req.user={id:'owner'};next();};
 installPipecatRoutes(app,{
  browserAuth:guard('x-browser-auth'),serviceAuth:guard('x-service-auth'),
  store:{authorizeWorker:async(id,token)=>{if(id!=='s1'||token!=='private-worker-token')throw Error('denied');return {sessionId:'s1',userId:'owner',language:'ar',transport:'smallwebrtc'};},create:async(...args:any[])=>{created=args;return {sessionId:'s1',ticket:'signed'};},claim:async()=>({sessionId:'s1',userId:'owner',language:'ar',transport:'smallwebrtc',workerToken:'private-worker-token'}),close:async(...args:any[])=>{closed=args;}},
  resolveLanguage:async(userId:string,requested:unknown)=>{assert.equal(userId,'owner');if(requested!=='ar')throw Error('invalid language');return 'ar';},
  bootstrap:async(scope:any)=>({prompt:'resolved real prompt',userId:scope.userId,apiKey:'private-provider-key'}),
  inbox:{accept:async(sessionId,token,input)=>{assert.equal(sessionId,'s1');assert.equal(token,'private-worker-token');return {eventId:input.eventId,accepted:true,processingStatus:'pending'};}},
 });
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const post=(path:string,body:any,headers:any={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try {
  assert.equal((await post('/api/voice/sessions',{})).status,401);
  const publicReply=await post('/api/voice/sessions',{userId:'victim',language:'ar'},{'x-browser-auth':'fixture'});
  assert.equal(publicReply.status,201);assert.deepEqual(created,['owner','ar','smallwebrtc']);
  assert.deepEqual(await publicReply.json(),{sessionId:'s1',ticket:'signed',transport:'smallwebrtc'});
  assert.equal((await post('/internal/voice/claim',{ticket:'signed'},{'x-browser-auth':'fixture'})).status,401);
  const claim=await post('/internal/voice/claim',{ticket:'signed',userId:'victim'},{'x-service-auth':'fixture'});
  assert.equal(claim.status,200);assert.equal((await claim.json()).bootstrap.userId,'owner');
  assert.equal((await post('/internal/voice/sessions/s1/events',{event:{eventId:'e1'}})).status,401);
  const eventAck=await post('/internal/voice/sessions/s1/events',{event:{eventId:'e1'}},{'x-service-auth':'fixture','x-voice-worker-token':'private-worker-token'});
  assert.equal(eventAck.status,202);assert.equal((await eventAck.json()).processingStatus,'pending');
  assert.equal((await post('/internal/voice/sessions/s1/close',{}, {'x-service-auth':'fixture'})).status,403);
  assert.equal((await post('/internal/voice/sessions/s1/close',{userId:'victim'}, {'x-service-auth':'fixture','x-voice-worker-token':'private-worker-token'})).status,204);
  assert.deepEqual(closed,['s1','owner']);
  assert.equal((await post('/api/voice/sessions/s1/close',{userId:'victim'},{'x-browser-auth':'fixture'})).status,204);
  assert.deepEqual(closed,['s1','owner']);
  assert.equal((await post('/api/voice/sessions',{language:'bad'},{'x-browser-auth':'fixture'})).status,400);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
