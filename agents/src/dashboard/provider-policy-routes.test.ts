import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {installProviderPolicyRoutes} from './provider-policy-routes.js';
test('authenticated metadata and locked provider requests return explicit 403',async()=>{
 const app=express();const env={LINGLANG_PROVIDER_POLICY:'deployment'};
 installProviderPolicyRoutes(app,(req,res,next)=>req.get('x-test-auth')?next():res.sendStatus(401),env);
 app.use((_req,res)=>res.json({reached:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try {
  assert.equal((await fetch(base+'/api/provider-policy')).status,401);
  const headers={'x-test-auth':'fixture'};
  assert.deepEqual(await (await fetch(base+'/api/provider-policy',{headers})).json(),{policy:'deployment',editable:false});
  for(const path of ['providers','google-key','provider-keys/name']) assert.equal((await fetch(base+'/api/users/fixture/'+path,{method:'PUT',headers})).status,403);
  assert.equal((await fetch(base+'/api/users/fixture/providers/probe',{method:'POST',headers})).status,403);
  env.LINGLANG_PROVIDER_POLICY='user';
  assert.equal((await fetch(base+'/api/users/fixture/providers',{method:'PUT',headers})).status,200);
 } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
