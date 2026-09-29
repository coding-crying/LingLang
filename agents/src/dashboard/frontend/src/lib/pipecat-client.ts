import {apiFetch} from './api';
interface Options {
 language:string;
 signal?:AbortSignal;
 onAudio:(stream:MediaStream)=>void;
 onState?:(state:RTCPeerConnectionState)=>void;
 request?:typeof apiFetch;
 microphone?:()=>Promise<MediaStream>;
 createPeer?:()=>RTCPeerConnection;
}
/** Same-origin signaling; no provider credentials are present in this client.
 * Uses complete ICE gathering (no trickle/restart); reconnect creates a session.
 */
export async function connectPipecat(options:Options) {
 const request=options.request ?? apiFetch;
 let stream:MediaStream|undefined,peer:RTCPeerConnection|undefined,sessionId:string|undefined;
 let closed=false;
 const stopped=new Set<MediaStreamTrack>();let peerClosed=false;
 const stopLocal=()=>{
  stream?.getTracks().forEach(track=>{if(!stopped.has(track)){track.stop();stopped.add(track);}});
  if(peer&&!peerClosed){peerClosed=true;peer.close();}
 };
 options.signal?.addEventListener('abort',stopLocal,{once:true});
 const close=async()=>{
  if(closed)return;closed=true;
  options.signal?.removeEventListener('abort',stopLocal);
  stopLocal();
  if(sessionId){
   const response=await request(`/api/voice/sessions/${encodeURIComponent(sessionId)}/close`,{method:'POST',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('Voice session closure could not be confirmed');
  }
 };
 try {
  options.signal?.throwIfAborted();
  stream=await (options.microphone ?? (()=>navigator.mediaDevices.getUserMedia({audio:true})))();
  options.signal?.throwIfAborted();
  const created=await request('/api/voice/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({language:options.language}),signal:AbortSignal.timeout(15000)});
  if(!created.ok)throw Error('Unable to start voice session');
  const scope=await created.json();
  if(typeof scope.sessionId!=='string'||!scope.sessionId||typeof scope.ticket!=='string'||!scope.ticket)throw Error('Invalid voice session response');
  sessionId=scope.sessionId;
  options.signal?.throwIfAborted();
  peer=(options.createPeer ?? (()=>new RTCPeerConnection()))();
  peer.ontrack=event=>{if(event.track.kind==='audio')options.onAudio(event.streams[0] ?? new MediaStream([event.track]));};
  peer.onconnectionstatechange=()=>options.onState?.(peer!.connectionState);
  stream.getTracks().forEach(track=>peer!.addTrack(track,stream!));
  peer.createDataChannel('pipecat');
  await peer.setLocalDescription(await peer.createOffer());
  options.signal?.throwIfAborted();
  if(peer.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{
   const current=peer!;
   const finish=()=>{clearTimeout(timer);current.removeEventListener('icegatheringstatechange',changed);options.signal?.removeEventListener('abort',aborted);};
   const aborted=()=>{finish();reject(new DOMException('Voice connection cancelled','AbortError'));};
   const changed=()=>{if(current.iceGatheringState==='complete'){finish();resolve();}};
   const timer=setTimeout(()=>{finish();reject(Error('Voice network negotiation timed out'));},10000);
   current.addEventListener('icegatheringstatechange',changed);options.signal?.addEventListener('abort',aborted,{once:true});changed();
  });
  const response=await request('/api/voice/offer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:scope.ticket,sdp:peer.localDescription?.sdp,type:'offer'}),signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('Voice connection failed');
  const answer=await response.json();
  if(answer.type!=='answer'||typeof answer.sdp!=='string')throw Error('Invalid voice answer');
  await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});
  options.signal?.throwIfAborted();
  return {close,setMuted:(muted:boolean)=>stream!.getAudioTracks().forEach(track=>track.enabled=!muted)};
 }catch(error){
  try{await close();}catch{/* Preserve original failure; local microphone is stopped. */}
  throw error;
 }
}
