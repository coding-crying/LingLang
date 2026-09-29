import React, {useEffect,useRef,useState} from 'react';
import {connectPipecat} from '../lib/pipecat-client';

export function PipecatVoice({language}:{language:string}) {
 const audio=useRef<HTMLAudioElement>(null);
 const session=useRef<Awaited<ReturnType<typeof connectPipecat>>|null>(null);
 const generation=useRef(0);
 const controller=useRef<AbortController|null>(null);
 const [status,setStatus]=useState('Ready');
 const [busy,setBusy]=useState(false);
 const [active,setActive]=useState(false);
 const [muted,setMuted]=useState(false);
 const [error,setError]=useState('');
 const [playBlocked,setPlayBlocked]=useState(false);
 useEffect(()=>()=>{generation.current++;controller.current?.abort();void session.current?.close().catch(()=>{});session.current=null;},[]);
 const stop=async()=>{
  generation.current++;
  controller.current?.abort();
  const current=session.current;session.current=null;
  setActive(false);setBusy(false);setStatus('Ready');setMuted(false);
  if(audio.current)audio.current.srcObject=null;
  try{await current?.close();}catch{setError('Microphone stopped; server closure could not be confirmed.');}
 };
 const start=async()=>{
  const attempt=++generation.current;
  const abort=new AbortController();controller.current=abort;
  setBusy(true);setError('');setStatus('Connecting…');
  try {
   const connected=await connectPipecat({language,signal:abort.signal,onAudio:stream=>{
    if(attempt!==generation.current||!audio.current)return;
    audio.current.srcObject=stream;
    void audio.current.play().catch(()=>setPlayBlocked(true));
   },onState:state=>{
    if(attempt!==generation.current)return;
    setStatus(state==='connected'?'Connected':state);
    if(state==='failed'||state==='disconnected'){setError('Voice connection lost. Start a new conversation to reconnect.');void stop();}
   }});
   if(attempt!==generation.current){await connected.close();return;}
   session.current=connected;setActive(true);
  }catch(e){if(attempt===generation.current){setError(e instanceof Error?e.message:'Voice connection failed');setStatus('Ready');}}
  finally{if(attempt===generation.current)setBusy(false);}
 };
 return <section className="p-4 flex flex-col gap-4" aria-label="Voice conversation">
  <h2 className="text-lg font-semibold">Conversation</h2>
  <p role="status" aria-live="polite">{status}</p>
  <audio ref={audio} autoPlay playsInline />
  {error&&<p role="alert">{error}</p>}
  {playBlocked&&<button onClick={()=>{void audio.current?.play().then(()=>setPlayBlocked(false)).catch(()=>setError('Speaker playback blocked. Check browser audio permissions.'));}}>Enable speaker</button>}
  {!active&&!busy?<button onClick={()=>void start()}>Start conversation</button>:<button onClick={()=>void stop()}>End conversation</button>}
  {active&&<button aria-pressed={muted} onClick={()=>{session.current?.setMuted(!muted);setMuted(!muted);}}>{muted?'Unmute microphone':'Mute microphone'}</button>}
  <p className="text-xs">Experimental Pipecat voice path. Learning updates and conversation history are not yet verified.</p>
 </section>;
}
