import type {Express,RequestHandler} from 'express';
import {verifyVoiceTicket} from '../lib/pipecat-session-ticket.js';
/** Initial non-trickle WebRTC offer only. Restart requires a new session ticket.
 * Pipecat must bind loopback; never expose its unauthenticated runner publicly.
 */
export function installVoiceOfferProxy(app:Express,auth:RequestHandler,secret:string,runnerOrigin:string) {
 const url=new URL(runnerOrigin);
 if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw Error('Voice runner must use a loopback HTTP origin');
 app.post('/api/voice/offer',auth,async(req,res)=>{
  let ticket:string;
  try {
   ticket=req.body?.ticket;
   const scope=verifyVoiceTicket(ticket,secret);
   if(scope.userId!==(req as typeof req & {user?:{id:string}}).user?.id || scope.transport!=='smallwebrtc') throw Error('denied');
  } catch {res.status(403).json({error:'Voice session unavailable'});return;}
  if(req.body?.type!=='offer' || typeof req.body?.sdp!=='string' || !req.body.sdp || req.body.sdp.length>100000) {res.status(400).json({error:'Invalid voice offer'});return;}
  try {
   const response=await fetch(new URL('/api/offer',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json'},body:JSON.stringify({sdp:req.body.sdp,type:'offer',request_data:{ticket}})});
   if(!response.ok) throw Error('runner rejected offer');
   const answer=await response.json();
   if(answer.type!=='answer' || typeof answer.sdp!=='string' || typeof answer.pc_id!=='string') throw Error('invalid runner answer');
   res.setHeader('Cache-Control','no-store');res.json({type:'answer',sdp:answer.sdp,pc_id:answer.pc_id});
  } catch {res.status(502).json({error:'Voice connection unavailable'});}
 });
}
