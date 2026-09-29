import {createHash} from 'node:crypto';
import {sql, type SQL} from 'drizzle-orm';
type Execute=(query:SQL)=>PromiseLike<readonly Record<string,unknown>[]>;
export interface FinalVoiceTurn {
 eventId:string;
 turnId:string;
 role:'learner'|'tutor';
 text:string;
 occurredAt:string;
 interrupted:boolean|null;
}
/** Durable inbox only: acceptance is NOT processor/evidence success. The drain
 * must preserve event identity and deduplicate downstream effects before release.
 */
export class PipecatEventInbox {
 constructor(private execute:Execute,private now=()=>Math.floor(Date.now()/1000)){}
 async accept(sessionId:string,workerToken:string,input:FinalVoiceTurn) {
  if(!/^[a-f0-9]{64}$/.test(workerToken) || !input ||
   !['eventId','turnId'].every(k=>typeof input[k as keyof FinalVoiceTurn]==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(String(input[k as keyof FinalVoiceTurn]))) ||
   !['learner','tutor'].includes(input.role) || typeof input.text!=='string' || !input.text.trim() || input.text.length>50000 ||
   typeof input.occurredAt!=='string' || !Number.isFinite(Date.parse(input.occurredAt)) ||
   ![true,false,null].includes(input.interrupted)) throw Error('Invalid final voice turn');
  // Explicit allowlist: discard browser/provider-supplied owner/language fields.
  const event:FinalVoiceTurn={eventId:input.eventId,turnId:input.turnId,role:input.role,text:input.text,occurredAt:input.occurredAt,interrupted:input.interrupted};
  const body=JSON.stringify(event);
  const hash=createHash('sha256').update(body).digest('hex');
  const workerHash=createHash('sha256').update(workerToken).digest('hex');
  const rows=await this.execute(sql`WITH authorized AS (
   SELECT id,user_id,language FROM pipecat_sessions WHERE id=${sessionId}
   AND worker_hash=${workerHash} AND closed_at IS NULL AND expires_at>${this.now()} FOR UPDATE
  ) INSERT INTO pipecat_events(session_id,event_id,user_id,language,payload,payload_hash)
   SELECT id,${event.eventId},user_id,language,${body}::jsonb,${hash} FROM authorized
   ON CONFLICT(session_id,event_id) DO UPDATE SET payload_hash=pipecat_events.payload_hash
    WHERE pipecat_events.payload_hash=EXCLUDED.payload_hash
   RETURNING event_id,processing_status`);
  if(!rows[0]) throw Error('Voice event rejected');
  return {eventId:String(rows[0].event_id),accepted:true as const,processingStatus:String(rows[0].processing_status)};
 }
}
