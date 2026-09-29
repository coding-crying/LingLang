/**
 * Qwen3-ASR transcription client — replaces Gemma-self-transcription as the
 * STT pass feeding GemmaAudioSTT's transcript anchor (see
 * configureTranscription in tutor-event-driven.ts).
 *
 * 2026-07-12: live A/B against real dumped clips showed Gemma (both FP8 and
 * QAT) drops out of ASR mode into assistant-refusal prose under noisy/hard
 * audio ("I'm sorry, but I cannot fulfill this request...") — a failure
 * mode a dedicated ASR model structurally can't have, since it has no
 * assistant persona to fall into. Confirmed empirically: Qwen3-ASR-0.6B
 * produced clean, plausible Russian on all 3 clips that made Gemma refuse
 * outright. On clips Gemma already handled fine it's a mixed bag (not
 * strictly better on every word), but eliminating refusals outright is the
 * bigger win — refusals were corrupting real turns (a refusal string
 * spliced into a legitimate segment's text, then read aloud by TTS).
 *
 * This does NOT replace Gemma's own audio-native understanding for the
 * conversational reply — GemmaAudioLLM still receives the raw current-turn
 * audio for pronunciation/tone nuance (see gemma-audio-llm.ts's "anchored"
 * audio payload). This only replaces the transcription-only pass that
 * anchors the conversation, feeds the processor grading pass, and shows up
 * in the frontend chat.
 */

const QWEN3_ASR_URL = process.env.QWEN3_ASR_URL || 'http://localhost:8002/v1/audio/transcriptions';

function dataUriToBuffer(dataUri: string): Buffer {
  const commaIdx = dataUri.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUri.slice(commaIdx + 1) : dataUri;
  return Buffer.from(base64, 'base64');
}

/**
 * Transcribe a WAV data URI via the local Qwen3-ASR server. Returns null on
 * any failure (unreachable, timeout, empty result) so the caller's existing
 * placeholder-only fallback path handles it exactly like a Gemma-pass
 * failure — no separate error handling needed upstream.
 */
export async function transcribeAudioWithQwen3ASR(
  audioUri: string,
  targetLangCode: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const buf = dataUriToBuffer(audioUri);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', targetLangCode);

    const res = await fetch(QWEN3_ASR_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[Qwen3ASR] Transcription failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as { text?: string };
    const text = (data.text || '').trim();
    return text || null;
  } catch (error: any) {
    console.error(`[Qwen3ASR] Transcription error: ${error?.message || error}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
