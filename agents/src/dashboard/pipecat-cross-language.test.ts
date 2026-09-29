import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import express from 'express';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {PipecatSessionStore} from '../lib/pipecat-session-store.js';
import {PipecatEventInbox} from '../lib/pipecat-event-inbox.js';
import {installPipecatRoutes} from './pipecat-routes.js';
import {voiceServiceAuth} from './pipecat-runtime.js';
const url=process.env.PIPECAT_TEST_DATABASE_URL;
test('Python to Node to PostgreSQL: transcript persistence, replay dedupe and revocation',{skip:!url,timeout:30000},async()=>{
 const client=postgres(url!,{max:4});const db=drizzle(client);
 const app=express();app.use(express.json());
 const secret='integration-service-token-not-production';
 const store=new PipecatSessionStore(q=>db.execute(q),'integration-ticket-secret-not-production');
 installPipecatRoutes(app,{
  browserAuth:(req,res,next)=>{if(req.get('x-fixture-auth')!=='fixture'){res.sendStatus(401);return;}(req as any).user={id:'integration-learner'};next();},
  serviceAuth:voiceServiceAuth(secret),store,inbox:new PipecatEventInbox(q=>db.execute(q)),
  resolveLanguage:async()=> 'ar',
  bootstrap:async scope=>({...scope,prompt:'Integration fixture; no inference requested',providers:{mode:'gemini'}}),
 });
 const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));
 try {
  await client.unsafe("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('integration-learner');");
  await client.unsafe(await readFile(new URL('../lib/pipecat-session-schema.sql',import.meta.url),'utf8'));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const response=await fetch(base+'/api/voice/sessions',{method:'POST',headers:{'x-fixture-auth':'fixture'}});
  assert.equal(response.status,201);
  const {ticket,sessionId}=await response.json();
  const voiceDir=fileURLToPath(new URL('../../../voice-py/',import.meta.url));
  const output=await new Promise<string>((resolve,reject)=>{
   const child=spawn(voiceDir+'.venv/bin/python',[voiceDir+'probe_product_session.py'],{cwd:voiceDir,stdio:['pipe','pipe','pipe']});
   let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
   child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(output)));
   child.stdin.end(JSON.stringify({base,serviceToken:secret,ticket}));
  });
  const rows=await client`SELECT user_id,language,payload,processing_status FROM pipecat_events ORDER BY event_id`;
  assert.equal(rows.length,3);
  assert.ok(rows.every(r=>r.user_id==='integration-learner' && r.language==='ar' && r.processing_status==='pending'));
  assert.deepEqual(rows.map(r=>r.payload.text).sort(),['مرحبا','أهلاً!','شكراً'].sort());
  assert.equal(rows.find(r=>r.payload.role==='tutor')!.payload.interrupted,true);
  const sessions=await client`SELECT closed_at FROM pipecat_sessions WHERE id=${sessionId}`;
  assert.ok(sessions[0]!.closed_at);
  console.log(output.trim());console.log('Database readback: 3 exact fixture events, pending, owner/language correct; session closed.');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await client.end();}
});
