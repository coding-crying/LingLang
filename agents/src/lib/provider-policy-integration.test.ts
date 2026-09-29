import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/unused';
process.env.LINGLANG_PROVIDER_POLICY='deployment';
process.env.SERVICE_MODE='gemini';
const {db}=await import('../db/index.js');
const providers=await import('./provider-config.js');
const google=await import('./google-budget.js');
// Any attempted provider database access fails immediately; no live data used.
(db as any).update=()=>{throw Error('unexpected DB write');};
(db as any).insert=()=>{throw Error('unexpected DB write');};
(db as any).delete=()=>{throw Error('unexpected DB write');};
db.query.users.findFirst=(async()=>{throw Error('unexpected DB read');}) as any;
test('locked resolver ignores even an unsaved user override without DB access',async()=>{
 assert.deepEqual(await providers.resolveProviders('fixture',{realtime:{enabled:false},llm:{baseUrl:'https://wrong.example',model:'wrong'}}),{realtimeEnabled:true});
});
test('deployment Google plan ignores stored personal key and uses shared budget',async()=>{
 db.query.users.findFirst=(async()=>({googleApiKeyEncrypted:'invalid-ciphertext-must-not-be-decrypted',googleUsagePeriodStart:new Date(),googleUsageMicros:12,googleUsageLimitMicros:100})) as any;
 const plan=await google.getGoogleKeyPlan('fixture');
 assert.equal(plan.apiKey,null);assert.equal(plan.useShared,true);assert.equal(plan.remainingMicros,88);
});
test('all provider and Google-key mutations reject before DB writes',async()=>{
 for(const operation of [()=>providers.setProviders('fixture',{}),()=>providers.putProviderKey('fixture','key','fixture'),()=>providers.deleteProviderKey('fixture','key'),()=>google.setGoogleApiKey('fixture','fixture'),()=>google.clearGoogleApiKey('fixture')]) {
  await assert.rejects(operation,/locked/);
 }
});
