import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectPipecat} from './pipecat-client';
test('client exchanges authenticated offer and closes tracks, peer and session',async()=>{
 const requests:any[]=[];let stopped=0;let closed=0;
 const stream={getTracks:()=>[{stop:()=>stopped++}]} as any;
 const peer={iceGatheringState:'complete',localDescription:{sdp:'fixture-sdp',type:'offer'},addTrack:()=>{},createDataChannel:()=>({}),createOffer:async()=>({sdp:'fixture-sdp',type:'offer'}),setLocalDescription:async()=>{},setRemoteDescription:async(answer:any)=>{assert.equal(answer.sdp,'fixture-answer');},close:()=>closed++} as any;
 const request=async(path:string,init:any)=>{
  requests.push([path,init]);
  return new Response(JSON.stringify(path.endsWith('/sessions')?{sessionId:'s1',ticket:'signed'}:{sdp:'fixture-answer',type:'answer',pc_id:'pc'}),{status:200});
 };
 const session=await connectPipecat({language:'ru',onAudio:()=>{},request,microphone:async()=>stream,createPeer:()=>peer});
 assert.deepEqual(JSON.parse(requests[1][1].body),{ticket:'signed',sdp:'fixture-sdp',type:'offer'});
 await session.close();await session.close();
 assert.equal(stopped,1);assert.equal(closed,1);assert.equal(requests[2][0],'/api/voice/sessions/s1/close');
});
test('cancellation immediately stops microphone while session creation is pending',async()=>{
 const controller=new AbortController();let stopped=0;let release!:()=>void;let entered!:()=>void;let revoked=false;
 const started=new Promise<void>(r=>entered=r);
 const wait=new Promise<void>(r=>release=r);
 const pending=connectPipecat({language:'ru',onAudio:()=>{},signal:controller.signal,microphone:async()=>({getTracks:()=>[{stop:()=>stopped++}]} as any),request:async(path)=>{
  if(path.endsWith('/sessions')){entered();await wait;return new Response(JSON.stringify({sessionId:'cancelled',ticket:'ticket'}));}
  revoked=true;return new Response(null,{status:204});
 },createPeer:()=>{throw Error('Must not create peer after cancellation');}});
 await started;controller.abort();
 assert.equal(stopped,1);
 release();await assert.rejects(pending,{name:'AbortError'});assert.ok(revoked);
});
test('failed offer stops microphone and revokes created session',async()=>{
 let stopped=false;let revoked=false;
 const stream={getTracks:()=>[{stop:()=>stopped=true}]} as any;
 const peer={addTrack:()=>{},createDataChannel:()=>({}),createOffer:async()=>{throw Error('offer failed');},close:()=>{}} as any;
 await assert.rejects(connectPipecat({language:'ru',onAudio:()=>{},microphone:async()=>stream,createPeer:()=>peer,request:async(path)=>{if(path.endsWith('/close'))revoked=true;return new Response(JSON.stringify({sessionId:'s1',ticket:'signed'}));}}),/offer failed/);
 assert.ok(stopped);assert.ok(revoked);
});
