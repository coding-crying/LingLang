import * as openai from '@livekit/agents-plugin-openai';

/**
 * OpenRouter LLM that forces requests through a specific provider (e.g., DeepInfra).
 * OpenRouter's `provider.order` body parameter routes requests to the chosen provider
 * for consistent low-latency inference.
 */
export class OpenRouterLLM extends openai.LLM {
  private providerOrder: string;

  constructor(opts: {
    baseURL: string;
    model: string;
    apiKey: string;
    provider: string;
  }) {
    super({
      baseURL: opts.baseURL,
      model: opts.model,
      apiKey: opts.apiKey,
    });
    this.providerOrder = opts.provider;
  }

  override chat(params: Parameters<openai.LLM['chat']>[0]) {
    const extraKwargs = {
      ...(params.extraKwargs || {}),
      provider: {
        order: [this.providerOrder],
        allow_fallbacks: true,
      },
    };
    return super.chat({ ...params, extraKwargs });
  }
}
