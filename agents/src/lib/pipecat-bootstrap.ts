import type {ResolvedProviders} from './provider-config.js';
import type {VoiceSessionScope} from './pipecat-session-ticket.js';

type Endpoint={baseUrl:string;model:string;apiKey:string;voice?:string};
interface Providers {mode:'gemini'|'cascade';gemini?:{apiKey:string;model:string};llm?:Endpoint;stt?:Endpoint;tts?:Endpoint;}
export function resolvePipecatProviders(byo:ResolvedProviders|null,googleKey:string|null,env:NodeJS.ProcessEnv=process.env):Providers {
 const cascadeSelected=!!(byo?.llm || byo?.stt || byo?.tts) && !byo?.realtimeEnabled;
 if(!cascadeSelected && (byo?.realtimeEnabled || env.SERVICE_MODE==='gemini' || googleKey || env.GOOGLE_API_KEY || env.GEMINI_API_KEY)) {
  const apiKey=googleKey || env.GOOGLE_API_KEY || env.GEMINI_API_KEY;
  if(!apiKey) throw Error('Google API key required');
  return {mode:'gemini',gemini:{apiKey,model:env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview'}};
 }
 const endpoint=(name:'llm'|'stt'|'tts'):Endpoint=>{
  const p=byo?.[name];const prefix=name.toUpperCase();
  const baseUrl=p?.baseUrl || env[`LOCAL_${prefix}_URL`] || env[`CLOUD_${prefix}_URL`];
  const model=p?.model || env[`LOCAL_${prefix}_MODEL`] || env[`CLOUD_${prefix}_MODEL`];
  if(!baseUrl || !model) throw Error(`Configure ${prefix} endpoint and model`);
  const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error(`Invalid ${prefix} endpoint`);
  return {baseUrl,model,apiKey:p?.apiKey || env[`${prefix}_API_KEY`] || '',...(name==='tts'?{voice:p?.voice || env.TTS_VOICE || 'alloy'}:{})};
 };
 return {mode:'cascade',llm:endpoint('llm'),stt:endpoint('stt'),tts:endpoint('tts')};
}

/** Server-only bootstrap. Reuses existing Node learner/persona/prompt readers;
 * no provider secrets or learner context may be returned from public routes.
 * Planner, tool and evidence lifecycle parity remains a separate release gate.
 */
export async function loadPipecatBootstrap(scope:VoiceSessionScope) {
 const [{db},{users},{eq},languageApi,learnerApi,personaApi,frontierApi,promptApi,onboardingApi,levelApi,providerApi,googleApi,profileApi,profileStore,contextApi,mixApi,{buildLearnerPromptContext}]=await Promise.all([
  import('../db/index.js'),import('../db/schema.js'),import('drizzle-orm'),import('../config/languages.js'),import('./learner-view.js'),import('./persona.js'),import('./frontier.js'),import('../config/prompts/base.js'),import('./onboarding.js'),import('./level-inference.js'),import('./provider-config.js'),import('./google-budget.js'),import('./model-prompts/profile.js'),import('./model-prompts/store.js'),import('./context.js'),import('./language-mix.js'),import('./tutor-prompt-context.js'),
 ]);
 const user=await db.query.users.findFirst({where:eq(users.id,scope.userId)});
 if(!user || user.targetLanguage!==scope.language) throw Error('Learner language changed; start a new session');
 const byo=await providerApi.resolveProviders(scope.userId);
 const google=await googleApi.getGoogleKeyPlan(scope.userId);
 const providers=resolvePipecatProviders(byo,google.apiKey);
 if(providers.mode==='gemini' && google.useShared && google.overBudget) throw Error('Shared Google budget exhausted');
 const language=languageApi.resolveSessionLanguage(scope.language,providers.mode==='gemini'?'gemini':'cloud');
 if(language.fellBackFrom) throw Error('Requested language not supported by configured route');
 const native=languageApi.nativeLanguageName(user.nativeLanguage || 'en');
 const [view,level,onboarding,summaries]=await Promise.all([
  learnerApi.readLearnerView(scope.userId,scope.language),levelApi.inferLevel(scope.userId,scope.language),onboardingApi.getOnboardingState(scope.userId,scope.language),contextApi.ContextManager.getRecentSummaries(scope.userId,scope.language,1),
 ]);
 const route=profileApi.resolveConversationRoute(providers.mode==='gemini'?'gemini':'cloud',providers.mode==='cascade'?{...byo,realtimeEnabled:false,llm:providers.llm}:byo,providers.gemini?.apiKey);
 const identity=profileApi.profileIdentity(route,scope.language);
 const profile=await profileStore.readProfile(scope.userId,identity.key);
 const persona=personaApi.buildPersonaBlockSync(view.persona.personaOverride,view.persona.tone,view.persona.correctionStyle,view.persona.teachingMode,view.persona.extraInstructions);
 let prompt:string;
 if(!onboarding?.isComplete) {
  prompt=promptApi.buildOnboardingInstructions({targetLanguage:language.config.name,nativeName:language.config.nativeName,nativeLanguage:native,demo:false,languageUndecided:false,persona,ladderWords:await onboardingApi.getOnboardingLadder(scope.language),existingData:onboarding?{priorStudy:onboarding.priorStudy??undefined,studyDetails:onboarding.studyDetails??undefined,goals:onboarding.goals??undefined,goalDetails:onboarding.goalDetails??undefined,selfRatedLevel:onboarding.selfRatedLevel??undefined}:undefined});
 } else {
  const mixLine=mixApi.buildMixLine({targetShare:mixApi.computeTargetShare({userLevel:level.level,recentSuccess:view.recentSuccess,throttleNotches:0}),lastMeasuredShare:null,targetLanguage:language.config.name,nativeLanguage:native});
  prompt=promptApi.buildInstructions(buildLearnerPromptContext(view,{targetLanguage:language.config.name,nativeLanguage:native,userLevel:level.level,persona,frontier:frontierApi.buildFrontierInfo(view.dueWords,view.newWords,view.dueBacklog,view.recentSuccess),modelGuidance:profile.guidance??undefined,previousSessionContext:summaries[0]?.nextSessionHint??null,recentErrors:'None',grammarHints:'None',goalUpdate:'Just chat. React to what they say. If quiet, ask a simple question.',mixLine,specialInstructions:language.config.pedagogy.specialInstructions,realtime:providers.mode==='gemini'}));
 }
 return {...scope,prompt,messages:[],providers,modelProfile:{key:identity.key,revision:profile.revision},onboarding:!onboarding?.isComplete};
}
