import type { Express, Request, RequestHandler } from 'express';
import type { PipecatSessionStore } from '../lib/pipecat-session-store.js';
import type { VoiceSessionScope } from '../lib/pipecat-session-ticket.js';

interface Dependencies {
  browserAuth: RequestHandler;
  serviceAuth: RequestHandler;
  store: Pick<PipecatSessionStore,'create'|'claim'|'close'|'authorizeWorker'>;
  resolveLanguage: (authenticatedUserId: string, requested: unknown) => Promise<string>;
  bootstrap: (scope: VoiceSessionScope) => Promise<unknown>;
  inbox: Pick<import('../lib/pipecat-event-inbox.js').PipecatEventInbox,'accept'>;
}
function owner(req: Request): string {
  const id=(req as Request & {user?:{id?:string}}).user?.id;
  if(!id) throw new Error('Authentication required');
  return id;
}
/** Explicitly mounted by product server only once session schema and bootstrap
 * resolver are ready. Keep /internal denied by public proxy; serviceAuth must
 * verify private service token and network policy independently of browser auth.
 */
export function installPipecatRoutes(app: Express, deps: Dependencies) {
  app.post('/api/voice/sessions',deps.browserAuth,async(req,res)=>{
    try {
      const userId=owner(req);
      const language=await deps.resolveLanguage(userId,req.body?.language);
      // Transport is server-owned; arbitrary browser fields never reach store.
      const {sessionId,ticket}=await deps.store.create(userId,language,'smallwebrtc');
      res.setHeader('Cache-Control','no-store');
      res.status(201).json({sessionId,ticket,transport:'smallwebrtc'});
    } catch { res.status(400).json({error:'Unable to create voice session'}); }
  });
  app.post('/api/voice/sessions/:sessionId/close',deps.browserAuth,async(req,res)=>{
    try {
      await deps.store.close(String(req.params.sessionId),owner(req));
      res.sendStatus(204);
    } catch { res.status(404).json({error:'Voice session unavailable'}); }
  });
  app.post('/internal/voice/sessions/:sessionId/events',deps.serviceAuth,async(req,res)=>{
    try {
      const ack=await deps.inbox.accept(String(req.params.sessionId),req.get('x-voice-worker-token') ?? '',req.body?.event);
      res.setHeader('Cache-Control','no-store');
      res.status(202).json(ack);
    } catch { res.status(403).json({error:'Voice event rejected'}); }
  });
  app.post('/internal/voice/sessions/:sessionId/close',deps.serviceAuth,async(req,res)=>{
    try {
      const scope=await deps.store.authorizeWorker(String(req.params.sessionId),req.get('x-voice-worker-token') ?? '');
      await deps.store.close(scope.sessionId,scope.userId);
      res.sendStatus(204);
    } catch { res.status(403).json({error:'Voice session unavailable'}); }
  });
  app.post('/internal/voice/claim',deps.serviceAuth,async(req,res)=>{
    let claim: Awaited<ReturnType<PipecatSessionStore['claim']>> | undefined;
    try {
      claim=await deps.store.claim(req.body?.ticket);
      const bootstrap=await deps.bootstrap(claim);
      res.setHeader('Cache-Control','no-store');
      res.json({sessionId:claim.sessionId,workerToken:claim.workerToken,bootstrap});
    } catch {
      // A failed bootstrap cannot leave a claimed live session behind.
      if(claim) await deps.store.close(claim.sessionId,claim.userId).catch(()=>{});
      res.status(403).json({error:'Voice session unavailable'});
    }
  });
}
