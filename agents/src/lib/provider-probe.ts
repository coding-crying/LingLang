/**
 * BYO endpoint latency/streaming probe (2026-09-02).
 *
 * The Profile UI lets a learner point STT/LLM/TTS at any endpoint; this
 * answers "is what I typed actually fast, and does it really stream?"
 * BEFORE they start a session against it.
 *
 * Each probe mirrors the exact request the ServiceFactory's BYO branch
 * makes at session start (same paths, same bodies, same response
 * handling), so a green probe means the real pipeline will behave the
 * same way:
 *
 *   LLM  openai-compat  POST {base}/chat/completions  stream:true
 *        -> TTFB (first content token), total, tokens/sec, streaming =
 *           >=2 content chunks spread over time (a server that buffers
 *           and dumps one SSE event is "nominal" streaming at best).
 *   TTS  omnivoice      POST {base}/v1/audio/speech/stream (chunked PCM 24k s16le)
 *        openai-compat  POST {base}/v1/audio/speech  response_format:pcm
 *        elevenlabs     POST api.elevenlabs.io/v1/text-to-speech/{v}/stream?output_format=pcm_24000
 *        -> TTFB, total, audio seconds (bytes/48000), RTF = total/audio.
 *           RTF < 1 means the server out-runs speech (fine); > 1 means
 *           the learner will hear gaps in production.
 *   STT  openai-compat  POST {base}/audio/transcriptions (1s sine WAV)
 *        -> request/response latency + RTF vs clip length. streaming is
 *           structurally false: no realtime protocol exists for arbitrary
 *           /transcriptions servers (same conclusion the factory adapter
 *           reached — see provider-config.ts header).
 *        elevenlabs     wss realtime handshake latency; streaming=true is
 *           a protocol fact (Scribe WS), we verify the socket opens.
 *
 * SSRF note: this fetches user-supplied URLs server-side. sanitizeProviders
 * already restricts to http(s) without embedded credentials, and hosted
 * deployments dispatch real sessions to these same URLs — the probe adds
 * no new reach the product doesn't already grant. A per-user cooldown
 * keeps it from becoming a scan tool.
 */
import WebSocket from 'ws';
import type { ResolvedProviders, ComponentProvider } from './provider-config.js';

export interface ProbeResult {
  component: 'stt' | 'llm' | 'tts';
  endpoint: string;
  ok: boolean;
  /** null = not measurable (e.g. WS handshake only). */
  streaming: boolean | null;
  ttfbMs?: number;
  totalMs?: number;
  /** TTS/STT: processing time / audio duration. Bar depends on streaming:
   *  <1 keeps up when streaming; buffered needs far more headroom. */
  rtf?: number;
  /** RTF usability bar (see withBar): 1.0 streaming, 0.25 buffered. */
  bar?: number;
  meetsBar?: boolean;
  /** LLM only. */
  tokensPerSec?: number;
  audioSeconds?: number;
  chunks?: number;
  error?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const TTS_TEXT = 'Olá, tudo bem? Hoje vamos praticar uma conversa simples.';
const PCM_24K_BYTES_PER_SEC = 24000 * 2; // s16le mono

/**
 * Usability bar for RTF, which depends on HOW the audio arrives:
 *
 *  - streaming: generation runs ahead of playback, so RTF < 1.0 is all
 *    it takes to never starve the learner's ear.
 *  - buffered: the learner hears NOTHING until the whole utterance is
 *    generated — perceived dead-air is RTF x utterance-length, not
 *    RTF x 1s-of-audio. A 4s reply at RTF 0.9 is ~3.5s of silence even
 *    though it technically "keeps up." So the bar tightens to 0.25,
 *    which lands a typical 4s utterance under ~1s of wait.
 *
 * STT's request/response adapter is structurally buffered (bar 0.25);
 * realtime WS STT streams (bar 1.0). Applied to every result in
 * probeAll so the UI never invents its own threshold.
 */
export const RTF_BAR_STREAMING = 1.0;
export const RTF_BAR_BUFFERED = 0.25;

function withBar(r: ProbeResult): ProbeResult {
  if (r.rtf === undefined) return r;
  const bar = r.streaming === true ? RTF_BAR_STREAMING : RTF_BAR_BUFFERED;
  return { ...r, bar, meetsBar: r.rtf < bar };
}

function endpointOf(p: ComponentProvider, fallback: string): string {
  return p.baseUrl || fallback;
}

// ---- LLM ----------------------------------------------------------------

export async function probeLLM(p: ComponentProvider & { apiKey?: string }): Promise<ProbeResult> {
  const base = endpointOf(p, 'unknown');
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: p.model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { component: 'llm', endpoint: url, ok: false, streaming: null, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, totalMs: Date.now() - t0 };
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('event-stream') || !res.body) {
      // Server ignored stream:true and answered with plain JSON — still
      // usable, but the token stream won't trickle: one blob at the end.
      const body = await res.text();
      return {
        component: 'llm', endpoint: url, ok: true, streaming: false,
        ttfbMs: Date.now() - t0, totalMs: Date.now() - t0,
        tokensPerSec: Math.round((body.length / 4) / Math.max(0.001, (Date.now() - t0) / 1000)),
        chunks: 1,
      };
    }
    // SSE: count content deltas with timing.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let firstTokenAt = 0;
    let lastTokenAt = 0;
    let contentChunks = 0;
    let contentChars = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          const delta = evt?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            const now = Date.now();
            if (!firstTokenAt) firstTokenAt = now;
            lastTokenAt = now;
            contentChunks++;
            contentChars += delta.length;
          }
        } catch { /* partial line — ignore */ }
      }
    }
    const totalMs = Date.now() - t0;
    const genMs = Math.max(1, lastTokenAt - firstTokenAt);
    const estTokens = Math.max(1, Math.round(contentChars / 4));
    return {
      component: 'llm', endpoint: url, ok: contentChunks > 0,
      streaming: contentChunks >= 2 && genMs > 30, // incremental vs dumped
      ttfbMs: firstTokenAt ? firstTokenAt - t0 : totalMs,
      totalMs,
      tokensPerSec: Math.round((estTokens / genMs) * 1000),
      chunks: contentChunks,
      error: contentChunks === 0 ? 'stream opened but no content tokens arrived' : undefined,
    };
  } catch (e) {
    return { component: 'llm', endpoint: url, ok: false, streaming: null, error: String((e as Error).message || e).slice(0, 160), totalMs: Date.now() - t0 };
  }
}

// ---- TTS ----------------------------------------------------------------

/** Read a chunked PCM response and compute TTFB / total / RTF / streaming. */
async function measurePcmStream(res: Response, t0: number, endpoint: string, component: 'tts'): Promise<ProbeResult> {
  const reader = res.body!.getReader();
  let bytes = 0;
  let chunks = 0;
  let firstByteAt = 0;
  let lastByteAt = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      const now = Date.now();
      if (!firstByteAt) firstByteAt = now;
      lastByteAt = now;
      bytes += value.length;
      chunks++;
    }
  }
  const totalMs = Date.now() - t0;
  const audioSeconds = bytes / PCM_24K_BYTES_PER_SEC;
  return {
    component, endpoint, ok: bytes > 0,
    // A server that buffers everything delivers chunk #1 at ~total time;
    // real streaming spreads chunks across the generation window.
    streaming: chunks >= 2 && (lastByteAt - firstByteAt) > 50,
    ttfbMs: firstByteAt ? firstByteAt - t0 : totalMs,
    totalMs,
    audioSeconds: Math.round(audioSeconds * 100) / 100,
    rtf: audioSeconds > 0 ? Math.round((totalMs / 1000 / audioSeconds) * 100) / 100 : undefined,
    chunks,
    error: bytes === 0 ? 'no audio bytes returned' : undefined,
  };
}

export async function probeTTS(p: ComponentProvider & { apiKey?: string }): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    if (p.vendor === 'elevenlabs') {
      const voice = p.voice || '21m00Tcm4TlvDq8ikWAM';
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=pcm_24000`;
      if (!p.apiKey) return { component: 'tts', endpoint: url, ok: false, streaming: null, error: 'no key selected (add one in API keys)' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': p.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: TTS_TEXT, model_id: p.model || 'eleven_multilingual_v2' }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { component: 'tts', endpoint: url, ok: false, streaming: null, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
      return await measurePcmStream(res, t0, url, 'tts');
    }

    if (p.vendor === 'openai') {
      const base = endpointOf(p, 'http://localhost:8880');
      const url = `${base.replace(/\/$/, '')}/v1/audio/speech`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({ model: p.model || 'tts-1', voice: p.voice || 'alloy', input: TTS_TEXT, response_format: 'pcm' }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { component: 'tts', endpoint: url, ok: false, streaming: null, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
      return await measurePcmStream(res, t0, url, 'tts');
    }

    // default / omnivoice: our sentence-chunked endpoint, exactly what the
    // OmniVoiceTTS adapter calls in production.
    const base = endpointOf(p, 'http://localhost:8882');
    const url = `${base.replace(/\/$/, '')}/v1/audio/speech/stream`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify({ text: TTS_TEXT, voice: p.voice || 'auto', ...(p.model ? { model: p.model } : {}) }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // /stream missing on a plain OpenAI-TTS server? Fall back once so the
      // probe measures the endpoint the user actually has, not our guess.
      const fb = `${base.replace(/\/$/, '')}/v1/audio/speech`;
      const res2 = await fetch(fb, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({ model: p.model || 'tts-1', voice: p.voice || 'alloy', input: TTS_TEXT, response_format: 'pcm' }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res2.ok) return { component: 'tts', endpoint: url, ok: false, streaming: null, error: `HTTP ${res.status} (and fallback ${fb}: ${res2.status})` };
      return await measurePcmStream(res2, t0, fb, 'tts');
    }
    return await measurePcmStream(res, t0, url, 'tts');
  } catch (e) {
    return { component: 'tts', endpoint: p.baseUrl || p.vendor || 'elevenlabs', ok: false, streaming: null, error: String((e as Error).message || e).slice(0, 160), totalMs: Date.now() - t0 };
  }
}

// ---- STT ----------------------------------------------------------------

/** 1s 440Hz sine, 16kHz mono s16le WAV — enough for any ASR server to accept. */
function sineWav(seconds = 1): Blob {
  const sr = 16000;
  const n = sr * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3 * 32767);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return new Blob([Buffer.concat([header, data])], { type: 'audio/wav' });
}

export async function probeSTT(p: ComponentProvider & { apiKey?: string }): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    if (p.vendor === 'elevenlabs') {
      // Streaming STT is a protocol fact for Scribe realtime (WebSocket);
      // verify the socket actually opens with this key, and report the
      // handshake latency as the connection cost the session will pay.
      if (!p.apiKey) return { component: 'stt', endpoint: 'wss://api.elevenlabs.io', ok: false, streaming: null, error: 'no key selected (add one in API keys)' };
      const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?include_language_detection=true&keepalive_timeout_ms=5000&commit_strategy=vad&sample_rate=16000&model_id=${encodeURIComponent(p.model || 'scribe_v2_realtime')}`;
      return await new Promise<ProbeResult>((resolve) => {
        const ws = new WebSocket(url, { headers: { 'xi-api-key': p.apiKey! } });
        // ElevenLabs accepts the WS *upgrade* before checking the key —
        // 'open' proves nothing. The real adapter gates on
        // `session_started` (see elevenlabs-realtime.ts #handleMessage);
        // we mirror that so a bad key reports as a failure, not a pass.
        const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ component: 'stt', endpoint: url, ok: false, streaming: null, error: 'no session_started within 15s (key or network?)' }); }, PROBE_TIMEOUT_MS);
        const fail = (why: string) => {
          clearTimeout(timer);
          try { ws.terminate(); } catch {}
          resolve({ component: 'stt', endpoint: url, ok: false, streaming: null, error: why.slice(0, 160), totalMs: Date.now() - t0 });
        };
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.message_type === 'session_started') {
              clearTimeout(timer);
              const handshakeMs = Date.now() - t0;
              try { ws.close(); } catch {}
              resolve({ component: 'stt', endpoint: url, ok: true, streaming: true, ttfbMs: handshakeMs, totalMs: handshakeMs, chunks: 0 });
            } else if (['auth_error', 'quota_exceeded', 'rate_limited', 'input_error'].includes(msg.message_type)) {
              fail(`${msg.message_type}: ${msg.error?.message || JSON.stringify(msg).slice(0, 120)}`);
            }
          } catch { /* non-JSON frame — ignore */ }
        });
        ws.on('error', (err) => fail(String(err.message || err)));
        ws.on('closed', () => fail('socket closed before session_started'));
      });
    }

    const base = endpointOf(p, 'http://localhost:8001/v1');
    const url = `${base.replace(/\/$/, '')}/audio/transcriptions`;
    const form = new FormData();
    form.append('file', sineWav(), 'probe.wav');
    form.append('model', p.model || 'whisper-1');
    const res = await fetch(url, {
      method: 'POST',
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const totalMs = Date.now() - t0;
    if (!res.ok) return { component: 'stt', endpoint: url, ok: false, streaming: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, totalMs };
    await res.text();
    return {
      component: 'stt', endpoint: url, ok: true,
      streaming: false, // request/response adapter — matches factory behavior
      ttfbMs: totalMs, totalMs,
      audioSeconds: 1,
      rtf: Math.round((totalMs / 1000) * 100) / 100, // vs 1s clip
    };
  } catch (e) {
    return { component: 'stt', endpoint: p.baseUrl || p.vendor || '?', ok: false, streaming: null, error: String((e as Error).message || e).slice(0, 160), totalMs: Date.now() - t0 };
  }
}

// ---- bundle ---------------------------------------------------------------

export async function probeAll(resolved: ResolvedProviders): Promise<ProbeResult[]> {
  const jobs: Promise<ProbeResult | null>[] = [];
  jobs.push(resolved.stt ? probeSTT(resolved.stt) : Promise.resolve(null));
  jobs.push(resolved.llm ? probeLLM(resolved.llm) : Promise.resolve(null));
  jobs.push(resolved.tts ? probeTTS(resolved.tts) : Promise.resolve(null));
  return (await Promise.all(jobs))
    .filter((r): r is ProbeResult => r !== null)
    .map(withBar);
}
