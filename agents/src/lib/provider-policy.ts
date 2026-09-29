import type {ResolvedProviders} from './provider-config.js';

export function providerPolicy(env:NodeJS.ProcessEnv=process.env):'user'|'deployment' {
 const policy=env.LINGLANG_PROVIDER_POLICY ?? 'user';
 if(policy!=='user' && policy!=='deployment') throw Error('LINGLANG_PROVIDER_POLICY must be user or deployment');
 return policy;
}
export function assertProvidersEditable(env:NodeJS.ProcessEnv=process.env):void {
 if(providerPolicy(env)==='deployment') throw Error('Provider configuration is locked by deployment');
}
/** Server-only: includes secrets. Never return this bundle from dashboard GET. */
export function deploymentProviders(env:NodeJS.ProcessEnv=process.env):ResolvedProviders|null {
 if(providerPolicy(env)==='user') return null;
 if(env.SERVICE_MODE==='gemini') return {realtimeEnabled:true};
 const component=(name:'LLM'|'STT'|'TTS')=>{
  const baseUrl=env[`LINGLANG_${name}_URL`];
  const model=env[`LINGLANG_${name}_MODEL`];
  if(!baseUrl || !model) throw Error(`Deployment requires LINGLANG_${name}_URL and LINGLANG_${name}_MODEL`);
  const url=new URL(baseUrl);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error(`Invalid deployment ${name} URL`);
  return {baseUrl,model,apiKey:env[`LINGLANG_${name}_API_KEY`] || '',...(name==='TTS'?{voice:env.LINGLANG_TTS_VOICE || 'alloy',vendor:'openai' as const}:{})};
 };
 return {realtimeEnabled:false,llm:component('LLM'),stt:component('STT'),tts:component('TTS')};
}
