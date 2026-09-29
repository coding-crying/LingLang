import {createHash,timingSafeEqual} from 'node:crypto';
import type {Express,RequestHandler} from 'express';
import type {SQL} from 'drizzle-orm';
import {PipecatSessionStore} from '../lib/pipecat-session-store.js';
import {PipecatEventInbox} from '../lib/pipecat-event-inbox.js';
import {loadPipecatBootstrap} from '../lib/pipecat-bootstrap.js';
import {installPipecatRoutes} from './pipecat-routes.js';
import {installVoiceOfferProxy} from './pipecat-offer.js';

export function voiceRuntimeConfig(env:NodeJS.ProcessEnv=process.env) {
 const enabled=env.LINGLANG_VOICE_ENABLED ?? '0';
 if(!['0','1'].includes(enabled)) throw Error('LINGLANG_VOICE_ENABLED must be 0 or 1');
 if(enabled==='0') return null;
 const serviceToken=env.LINGLANG_VOICE_SERVICE_TOKEN;
 const ticketSecret=env.LINGLANG_VOICE_TICKET_SECRET;
 if(!serviceToken || !ticketSecret || serviceToken.length<32 || ticketSecret.length<32 || serviceToken===ticketSecret) throw Error('Voice runtime requires distinct service and ticket secrets of at least 32 characters');
 return {serviceToken,ticketSecret};
}
export function voiceServiceAuth(secret:string):RequestHandler {
 const expected=createHash('sha256').update(`Bearer ${secret}`).digest();
 return (req,res,next)=>{
  const address=req.socket.remoteAddress;
  const loopback=address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
  const actual=createHash('sha256').update(req.get('authorization') ?? '').digest();
  if(!loopback || !timingSafeEqual(actual,expected)) {res.status(403).json({error:'Voice service authentication required'});return;}
  next();
 };
}
/** Register before the legacy /internal router (it has a different token).
 * Schema creation is an installation concern; never migrate production here.
 */
export function mountPipecatRuntime(app:Express, browserAuth:RequestHandler,
 execute:(query:SQL)=>PromiseLike<readonly Record<string,unknown>[]>,
 resolveLanguage:(userId:string,requested:unknown)=>Promise<string>,env:NodeJS.ProcessEnv=process.env) {
 const config=voiceRuntimeConfig(env);
 app.get('/api/voice/config',browserAuth,(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({transport:config?'smallwebrtc':'livekit'});});
 if(!config) return false;
 installVoiceOfferProxy(app,browserAuth,config.ticketSecret,env.LINGLANG_VOICE_RUNNER_URL || 'http://127.0.0.1:7860');
 const store=new PipecatSessionStore(execute,config.ticketSecret);
 installPipecatRoutes(app,{browserAuth,serviceAuth:voiceServiceAuth(config.serviceToken),store,resolveLanguage,bootstrap:loadPipecatBootstrap,inbox:new PipecatEventInbox(execute)});
 return true;
}
