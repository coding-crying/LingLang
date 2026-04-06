import { llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

// This custom LLM intercepts the LiveKit ChatContext.
// If it finds the special [AUDIO_PAYLOAD] marker from GemmaAudioSTT, 
// it reconstructs it into a multimodal request and sends it to the local vLLM.

export class GemmaAudioLLM extends openai.LLM {
  
  constructor(options: { baseURL: string; model: string }) {
    super({
      baseURL: options.baseURL,
      model: options.model,
      apiKey: 'dummy' // Not needed for local vLLM
    });
  }

  // Intercept the chat request to rebuild the multimodal context
  // @ts-ignore
  chat(options: {
    chatCtx: llm.ChatContext;
    toolCtx?: any;
    connOptions?: any;
    parallelToolCalls?: boolean;
    toolChoice?: any;
    extraKwargs?: any;
  }): any {
    
    const reconstructedMessages: any[] = [];

    // Parse the ChatContext to find our embedded audio data URIs
    for (const msg of options.chatCtx.items) {
      if (msg.type !== 'message') continue;
      
      const content = msg.textContent || '';
      
      // Check if this is one of our intercepted audio chunks
      if (content.includes('[AUDIO_PAYLOAD:data:audio/wav;base64,')) {
        
        // Extract the data URI string from between the brackets
        const match = content.match(/\[AUDIO_PAYLOAD:(data:audio\/wav;base64,[A-Za-z0-9+/=]+)\]/);
        
        if (match && match[1]) {
          const audioUri = match[1];
          reconstructedMessages.push({
            role: msg.role,
            content: [
              { type: 'text', text: "Please respond to this audio." },
              { type: 'audio_url', audio_url: { url: audioUri } }
            ]
          });
          continue;
        }
      }
      
      // Standard text message (e.g. system instructions or previous Gemma responses)
      reconstructedMessages.push({
        role: msg.role,
        content: content
      });
    }

    // We build a temporary new ChatContext specifically for the parent openai.LLM
    const newCtx = new llm.ChatContext();
    for (const msg of reconstructedMessages) {
       newCtx.addMessage({
         role: msg.role as llm.ChatRole,
         content: msg.content // Pass the multimodal array here
       });
    }

    // Pass the reconstructed context up to the standard OpenAI plugin 
    // which knows how to stream responses back from vLLM's /chat/completions
    return super.chat({
      ...options,
      chatCtx: newCtx
    });
  }
}
