import type {Express,RequestHandler} from 'express';
import {providerPolicy} from '../lib/provider-policy.js';

/** Register before provider handlers. Never expose deployment URLs or keys. */
export function installProviderPolicyRoutes(app:Express,auth:RequestHandler,env:NodeJS.ProcessEnv=process.env) {
 providerPolicy(env); // Reject invalid policy at startup, not after the first edit.
 app.get('/api/provider-policy',auth,(_req,res)=>{
  const policy=providerPolicy(env);
  res.json({policy,editable:policy==='user'});
 });
 app.use('/api/users/:userId', (req,res,next)=>{
  const providerPath=/^\/(?:providers|provider-keys|google-key)(?:\/|$)/.test(req.path);
  if(!providerPath || ['GET','HEAD','OPTIONS'].includes(req.method) || providerPolicy(env)==='user') return next();
  return auth(req,res,()=>{res.status(403).json({error:'Provider configuration is locked by deployment',code:'PROVIDERS_LOCKED'});});
 });
}
