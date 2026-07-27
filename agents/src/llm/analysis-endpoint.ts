/**
 * Endpoint resolution for the analysis LLMs (processor + supervisor).
 *
 * These run behind the conversation, not in it: the processor extracts
 * lexemes from what the user just said, the supervisor plans. Neither is
 * on the audio path, but both are on a ~3-second budget before their
 * result is too late to shape the next turn.
 *
 * Local is preferred when it's there (free, private, no rate limit), but
 * it is NOT always there: llama-swap unloads idle models, and the box it
 * runs on is regularly under memory pressure from other work. So this
 * picks per-call, with OpenRouter as the fallback.
 *
 * The probe deliberately asks "is the model WARM", not "is the endpoint
 * UP". llama-swap answers /v1/models from config, so it reports a model
 * it hasn't loaded and would happily accept a request that then blocks
 * for however long a 15.6 GB load takes. Routing a live turn into that is
 * worse than just using the cloud: the analysis lands after the turn it
 * was meant to inform. /running lists what is actually resident, so a
 * cold local model falls back instead of stalling, and the moment
 * something else warms that model up we ride along for free.
 */

export interface AnalysisEndpoint {
  url: string;
  key: string;
  model: string;
  /** Which side we resolved to, for logging. */
  source: 'local' | 'cloud';
}

/** How long a probe result is trusted before re-checking. */
const PROBE_TTL_MS = 30_000;
/** How long /running gets to answer. It's a local status read, so this is
 *  generous; anything slower is itself a sign the box is struggling. */
const PROBE_TIMEOUT_MS = 1_500;

let cached: { at: number; warm: boolean } | null = null;

/** Base origin of an OpenAI-style base URL ("http://h:8083/v1" → "http://h:8083"). */
function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, '');
  }
}

/**
 * Is `model` currently resident in the local llama-swap instance?
 * Any failure (not running, not llama-swap, timeout, unparseable) is a
 * "no" — this must never throw into the caller's turn.
 */
async function isLocalWarm(baseUrl: string, model: string): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.warm;

  let warm = false;
  try {
    const res = await fetch(`${originOf(baseUrl)}/running`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { running?: Array<{ model?: string }> };
      warm = (body.running ?? []).some((m) => m?.model === model);
    }
  } catch {
    warm = false;
  }

  cached = { at: now, warm };
  return warm;
}

/**
 * Resolve where analysis should run for this call.
 *
 * `prefix` selects the env var family, so the processor and supervisor can
 * be pointed at different models: PROCESSOR_LLM_* / SUPERVISOR_LLM_* for
 * local, CLOUD_PROCESSOR_LLM_* / CLOUD_SUPERVISOR_LLM_* for the fallback.
 * With no cloud URL configured, local is used unconditionally — an
 * unconfigured fallback shouldn't silently disable analysis.
 */
export async function resolveAnalysisEndpoint(
  prefix: 'PROCESSOR' | 'SUPERVISOR',
  opts: { allowCloud?: boolean } = {},
): Promise<AnalysisEndpoint> {
  const env = process.env;

  const local: AnalysisEndpoint = {
    url: env[`${prefix}_LLM_URL`] || env.LOCAL_LLM_URL || 'http://localhost:8083/v1',
    key: env[`${prefix}_LLM_KEY`] || env.LOCAL_LLM_KEY || '',
    model: env[`${prefix}_LLM_MODEL`] || env.LOCAL_LLM_MODEL || 'gemma4-31b-qat',
    source: 'local',
  };

  // Local-mode sessions send real audio to the processor for pronunciation
  // grading, and the cloud models are text+image only. Falling back there
  // wouldn't error, it would silently downgrade the analysis, so callers on
  // the audio path opt out and stay local even when local is cold.
  const cloudUrl = opts.allowCloud === false
    ? undefined
    : env[`CLOUD_${prefix}_LLM_URL`] || env.CLOUD_PROCESSOR_LLM_URL;
  if (!cloudUrl) return local;

  const cloud: AnalysisEndpoint = {
    url: cloudUrl,
    key: env[`CLOUD_${prefix}_LLM_KEY`] || env.CLOUD_PROCESSOR_LLM_KEY || '',
    model:
      env[`CLOUD_${prefix}_LLM_MODEL`] ||
      env.CLOUD_PROCESSOR_LLM_MODEL ||
      'google/gemma-4-26b-a4b-it',
    source: 'cloud',
  };

  return (await isLocalWarm(local.url, local.model)) ? local : cloud;
}
