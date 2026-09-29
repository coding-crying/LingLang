// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { GoogleGenAI, Modality } from '@google/genai';
import type { Dialogue, Exchange } from './alignment.js';
import type { ConversationRoute } from './profile.js';

/** Cancellation must also bound the websocket handshake, not just generated turns. */
export function connectBounded<T extends { close(): void }>(
  connect: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 45000,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const abort = () => fail(new Error('Alignment aborted'));
    const timer = setTimeout(() => fail(new Error('Realtime connection timed out')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(connect)
      .then((session) => {
        if (settled) {
          session.close();
          return;
        }
        settled = true;
        cleanup();
        resolve(session);
      }, fail);
  });
}

export function createDialogue(route: ConversationRoute, voice = 'Puck'): Dialogue {
  if (route.transport === 'unsupported') throw new Error('This transport cannot be calibrated yet');
  if (route.transport === 'google-live')
    return async (system, turns, signal) => {
      const ai = new GoogleGenAI({ apiKey: route.apiKey });
      let current: {
        resolve: (value: Exchange) => void;
        reject: (reason: Error) => void;
        result: Exchange;
        started: number;
      } | null = null;
      let closed = false;
      const session = await connectBounded(
        () =>
          ai.live.connect({
            model: route.model,
            config: {
              responseModalities: [Modality.AUDIO],
              maxOutputTokens: 512,
              systemInstruction: system,
              outputAudioTranscription: {},
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
            callbacks: {
              onmessage(message) {
                if (!current) return;
                const content = message.serverContent;
                if (!content) return;
                current.result.text += content.outputTranscription?.text || '';
                for (const part of content.modelTurn?.parts || [])
                  if (part.inlineData?.data) {
                    current.result.firstOutputMs ??= Date.now() - current.started;
                    current.result.audioBytes += Buffer.from(part.inlineData.data, 'base64').length;
                  }
                if (current.result.text.length > 12000) {
                  current.reject(new Error('Provider output exceeded limit'));
                  current = null;
                  return;
                }
                if (content.turnComplete) {
                  current.result.durationMs = Date.now() - current.started;
                  current.resolve(current.result);
                  current = null;
                }
              },
              onerror() {
                current?.reject(new Error('Realtime provider error'));
              },
              onclose() {
                closed = true;
                current?.reject(new Error('Realtime connection closed'));
              },
            },
          }),
        signal,
      );
      const abort = () => {
        current?.reject(new Error('Alignment aborted'));
        session.close();
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const results: Exchange[] = [];
        for (const input of turns) {
          signal.throwIfAborted();
          if (closed) throw new Error('Realtime connection closed');
          const response = new Promise<Exchange>((resolve, reject) => {
            current = {
              resolve,
              reject,
              started: Date.now(),
              result: { input, text: '', durationMs: 0, firstOutputMs: null, audioBytes: 0 },
            };
          });
          const timer = setTimeout(
            () => current?.reject(new Error('Realtime turn timed out')),
            45000,
          );
          try {
            session.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: input }] }],
              turnComplete: true,
            });
            results.push(await response);
          } finally {
            clearTimeout(timer);
          }
        }
        return results;
      } finally {
        signal.removeEventListener('abort', abort);
        session.close();
      }
    };
  return async (system, turns, signal) => {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: system },
    ];
    const results: Exchange[] = [];
    for (const input of turns) {
      signal.throwIfAborted();
      messages.push({ role: 'user', content: input });
      const started = Date.now();
      const response = await fetch(`${route.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        headers: {
          'Content-Type': 'application/json',
          ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: route.model,
          messages,
          stream: true,
          max_tokens: 512,
          ...route.options,
        }),
      });
      if (!response.ok || !response.body) throw new Error(`Provider HTTP ${response.status}`);
      const reader = response.body.getReader();
      let text = '',
        pending = '',
        bytes = 0,
        firstOutputMs: number | null = null;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 200000) throw new Error('Provider output exceeded limit');
          pending += decoder.decode(part.value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
            const chunk = JSON.parse(line.slice(5));
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              firstOutputMs ??= Date.now() - started;
              text += delta;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!text.trim()) throw new Error('Provider returned no text');
      messages.push({ role: 'assistant', content: text });
      results.push({ input, text, durationMs: Date.now() - started, firstOutputMs, audioBytes: 0 });
    }
    return results;
  };
}
