/**
 * BYO speech-stack provider config (2026-09-02).
 *
 * The operator's env vars (CLOUD_STT_URL, LOCAL_LLM_URL, ...) were the only
 * way to point a component at a different server — fine for a single-tenant
 * box, wrong for a hosted product where learner A has an ElevenLabs key and
 * a local Ollama, and learner B has nothing but a Groq key. This module
 * stores a per-user provider map in users.speech_providers (JSONB) plus an
 * encrypted key vault (provider_api_keys) and resolves them into concrete
 * service options at session start.
 *
 * Shape (all fields optional; absent component falls through to the
 * ServiceFactory's existing env-var behavior — so enabling BYO changes
 * nothing for users who never touch it):
 *
 *   {
 *     "stt":  { "baseUrl": "http://192.168.1.5:8001/v1", "model": "qwen3-asr", "keyRef": "local" },
 *     "llm":  { "baseUrl": "https://openrouter.ai/api/v1", "model": "meta-llama/llama-3.3-70b", "keyRef": "openrouter" },
 *     "tts":  { "vendor": "elevenlabs", "model": "eleven_v3", "voice": "pNInz6obpgDQGcFmaJgB", "keyRef": "elevenlabs" },
 *     "realtime": { "enabled": true }   // Gemini Live opt-in (needs googleApiKey)
 *   }
 *
 * "Hot-swappable" here means: each component independently points at any
 * OpenAI-compatible endpoint (STT/LLM), or a named vendor (TTS: elevenlabs
 * | openai-compatible | omnivoice-compatible). Streaming is a property of
 * the vendor adapter, not a user choice — the ElevenLabs adapter streams,
 * the OpenAI-compatible STT adapter doesn't (no realtime protocol exists
 * for arbitrary /v1/audio/transcriptions servers), and we use whichever is
 * available for what the endpoint actually speaks.
 *
 * Keys: keyRef names a row in provider_api_keys. We never return key
 * material to the client; the resolver decrypts server-side only, and the
 * dispatch metadata carries the decrypted values to the agent worker the
 * same way googleApiKey already does.
 */
import { assertProvidersEditable, deploymentProviders } from './provider-policy.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, providerApiKeys } from '../db/schema.js';
import { encryptSecret, decryptSecret } from './crypto.js';

export type ProviderComponent = 'stt' | 'llm' | 'tts';

export interface ComponentProvider {
  /** OpenAI-compatible base URL (stt/llm) or vendor endpoint (tts). */
  baseUrl?: string;
  model?: string;
  /** TTS only: which adapter to build. */
  vendor?: 'elevenlabs' | 'openai' | 'omnivoice';
  /** TTS voice id / name, vendor-specific. */
  voice?: string;
  /** provider_api_keys.key_name for this component's credential. */
  keyRef?: string;
}

export interface SpeechProviders {
  stt?: ComponentProvider;
  llm?: ComponentProvider;
  tts?: ComponentProvider;
  realtime?: { enabled?: boolean };
}

/** Fully-resolved per-session provider bundle (keys decrypted). */
export interface ResolvedProviders {
  stt?: ComponentProvider & { apiKey?: string };
  llm?: ComponentProvider & { apiKey?: string };
  tts?: ComponentProvider & { apiKey?: string };
  realtimeEnabled: boolean;
}

const VALID_VENDORS = new Set(['elevenlabs', 'openai', 'omnivoice']);

/** Validate + normalize untrusted input from the Profile UI. Throws on
 *  anything structurally wrong so a bad save fails loudly at the API. */
export function sanitizeProviders(input: unknown): SpeechProviders {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('providers must be an object');
  }
  const raw = input as Record<string, unknown>;
  const out: SpeechProviders = {};
  for (const comp of ['stt', 'llm', 'tts'] as const) {
    const c = raw[comp];
    if (c === undefined || c === null) continue;
    if (typeof c !== 'object' || Array.isArray(c)) throw new Error(`${comp} must be an object`);
    const cc = c as Record<string, unknown>;
    const p: ComponentProvider = {};
    if (typeof cc.baseUrl === 'string' && cc.baseUrl.trim()) {
      const u = cc.baseUrl.trim();
      // SSRF guard: http(s) only, no credentials in the URL. On a self-
      // hosted box pointing at http://localhost:8001 is the POINT, so we
      // can't restrict hosts — but we can refuse file://, metadata IPs
      // smuggled via userinfo, etc.
      const parsed = new URL(u);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${comp}.baseUrl must be http(s)`);
      if (parsed.username || parsed.password) throw new Error(`${comp}.baseUrl must not embed credentials`);
      p.baseUrl = u;
    }
    if (typeof cc.model === 'string' && cc.model.trim()) p.model = cc.model.trim();
    if (typeof cc.voice === 'string' && cc.voice.trim()) p.voice = cc.voice.trim();
    if (typeof cc.keyRef === 'string' && cc.keyRef.trim()) p.keyRef = cc.keyRef.trim();
    if (cc.vendor !== undefined) {
      if (typeof cc.vendor !== 'string' || !VALID_VENDORS.has(cc.vendor)) {
        throw new Error(`${comp}.vendor must be one of: ${[...VALID_VENDORS].join(', ')}`);
      }
      p.vendor = cc.vendor as ComponentProvider['vendor'];
    }
    out[comp] = p;
  }
  const rt = raw.realtime;
  if (rt && typeof rt === 'object' && (rt as any).enabled === true) {
    out.realtime = { enabled: true };
  }
  return out;
}

export async function getProviders(userId: string): Promise<SpeechProviders | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return (user?.speechProviders as SpeechProviders | null) ?? null;
}

export async function setProviders(userId: string, providers: SpeechProviders): Promise<void> {
  assertProvidersEditable();
  await db.update(users)
    .set({ speechProviders: providers })
    .where(eq(users.id, userId));
}

// ---- key vault ----

export async function putProviderKey(userId: string, keyName: string, apiKey: string): Promise<void> {
  assertProvidersEditable();
  const name = keyName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
  if (!name) throw new Error('invalid key name');
  await db.insert(providerApiKeys)
    .values({ userId, keyName: name, keyEncrypted: encryptSecret(apiKey.trim()) })
    .onConflictDoUpdate({
      target: [providerApiKeys.userId, providerApiKeys.keyName],
      set: { keyEncrypted: encryptSecret(apiKey.trim()) },
    });
}

export async function deleteProviderKey(userId: string, keyName: string): Promise<void> {
  assertProvidersEditable();
  await db.delete(providerApiKeys)
    .where(and(eq(providerApiKeys.userId, userId), eq(providerApiKeys.keyName, keyName)));
}

/** Names only — safe for the client (which key exists, not what it is). */
export async function listProviderKeyNames(userId: string): Promise<string[]> {
  const rows = await db.query.providerApiKeys.findMany({ where: eq(providerApiKeys.userId, userId) });
  return rows.map((r) => r.keyName);
}

/** Decrypt one vault key by name; undefined if absent. Server-side only —
 * never exposed raw to a client route (models-list uses this to attach
 * Authorization to a user-chosen endpoint, same posture as the probe). */
export async function getDecryptedKey(userId: string, keyName: string): Promise<string | null> {
  const rows = await db.query.providerApiKeys.findMany({
    where: and(eq(providerApiKeys.userId, userId), eq(providerApiKeys.keyName, keyName)),
  });
  if (rows.length === 0) return null;
  const enc = rows[0]?.keyEncrypted;
  return enc ? decryptSecret(enc) : null;
}

/**
 * Resolve a user's provider map into concrete options with decrypted keys.
 * Returns null when the user configured nothing — callers then behave
 * exactly as before this feature existed. `override` probes an unsaved
 * draft config (same key vault) without touching the stored row.
 */
export async function resolveProviders(userId: string, override?: SpeechProviders): Promise<ResolvedProviders | null> {
  const deployment = deploymentProviders();
  if (deployment) return deployment;
  const providers = override ?? (await getProviders(userId));
  if (!providers || (!providers.stt && !providers.llm && !providers.tts && !providers.realtime?.enabled)) {
    return null;
  }
  const keyRows = await db.query.providerApiKeys.findMany({ where: eq(providerApiKeys.userId, userId) });
  const keys = new Map(keyRows.map((r) => [r.keyName, decryptSecret(r.keyEncrypted)]));

  const resolve = (p?: ComponentProvider) => {
    if (!p) return undefined;
    const apiKey = p.keyRef ? keys.get(p.keyRef) : undefined;
    if (p.keyRef && apiKey === undefined) {
      // Referenced a deleted key: fall back to no key (endpoint may be a
      // local server that needs none) rather than failing the session.
      console.warn(`[provider-config] user ${userId} references missing keyRef '${p.keyRef}' — continuing keyless`);
    }
    return { ...p, apiKey };
  };

  return {
    stt: resolve(providers.stt),
    llm: resolve(providers.llm),
    tts: resolve(providers.tts),
    realtimeEnabled: providers.realtime?.enabled === true,
  };
}
