// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { ResolvedProviders } from '../provider-config.js';

export interface ConversationRoute {
  transport: 'openai' | 'google-live' | 'unsupported';
  endpoint: string;
  model: string;
  apiKey: string;
  input: 'text' | 'audio';
  options: Record<string, unknown>;
}
/** mode is the resolved ServiceFactory mode, NOT the dashboard's Cloud label. */
export function resolveConversationRoute(
  mode: string,
  providers?: ResolvedProviders | null,
  googleApiKey?: string,
): ConversationRoute {
  const env = process.env;
  if (mode === 'gemini')
    return {
      transport: 'google-live',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview',
      apiKey: googleApiKey || env.GOOGLE_API_KEY || env.GEMINI_API_KEY || '',
      input: 'audio',
      options: { responseModalities: ['AUDIO'] },
    };
  if (providers?.llm?.baseUrl) {
    const p = providers.llm;
    return {
      transport: 'openai',
      endpoint: p.baseUrl!,
      model: p.model || 'gpt-4o-mini',
      apiKey: p.apiKey || '',
      input: 'text',
      options: /localhost|127\.0\.0\.1/.test(p.baseUrl!)
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {},
    };
  }
  if (mode === 'audex')
    return {
      transport: 'unsupported',
      endpoint: env.AUDEX_URL || 'http://127.0.0.1:7860',
      model: 'audex',
      apiKey: '',
      input: 'audio',
      options: {},
    };
  if (mode === 'local-gemma-audio' || mode === 'local-qwen') {
    const qwen = mode === 'local-qwen';
    return {
      transport: 'openai',
      endpoint:
        (qwen && env.QWEN_LOCAL_LLM_URL) ||
        env.GEMMA_AUDIO_LLM_URL ||
        env.LOCAL_LLM_URL ||
        'http://localhost:8093/v1',
      model:
        (qwen && env.QWEN_LOCAL_LLM_MODEL) ||
        env.GEMMA_AUDIO_LLM_MODEL ||
        env.LOCAL_LLM_MODEL ||
        (qwen ? 'gemma4-12b-it-qat' : 'gemma4-12b-it'),
      apiKey: '',
      input: qwen ? 'text' : 'audio',
      options: { chat_template_kwargs: { enable_thinking: false } },
    };
  }
  return {
    transport: 'openai',
    endpoint: env.CONVERSATION_LLM_URL || 'https://openrouter.ai/api/v1',
    model: env.CONVERSATION_LLM_MODEL || 'google/gemma-4-26b-a4b-it',
    apiKey: env.CONVERSATION_LLM_KEY || '',
    input: 'text',
    options: {
      provider: { order: [env.CONVERSATION_LLM_PROVIDER || 'deepinfra'], allow_fallbacks: false },
    },
  };
}
export function profileIdentity(route: ConversationRoute, language: string) {
  const url = new URL(route.endpoint);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const identity = {
    endpoint: url.toString().replace(/\/$/, ''),
    model: route.model,
    transport: route.transport,
    input: route.input,
    options: route.options,
    language,
    contractVersion: 'conversation-v1',
  };
  return { ...identity, key: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}
export function validateGuidance(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Guidance must be text');
  if (value.length > 2000) throw new Error('Guidance exceeds 2000 characters');
  return value.trim();
}
