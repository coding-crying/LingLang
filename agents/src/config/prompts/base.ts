// Prompt template engine

export interface PromptContext {
  targetLanguage: string
  nativeName: string
  targetRatio: number
  userLevel: string
  initialContext: string
  /** 'voice' for LiveKit/TTS sessions, 'text' for CLI/web chat */
  mode?: 'voice' | 'text'
}

export function buildInstructions(
  template: string,
  context: PromptContext
): string {
  return template
    .replace(/{targetLanguage}/g, context.targetLanguage)
    .replace(/{nativeName}/g, context.nativeName)
    .replace(/{targetRatio}/g, String(Math.round(context.targetRatio * 100)))
    .replace(/{userLevel}/g, context.userLevel)
    .replace(/{initialContext}/g, context.initialContext)
    .replace(/{mode}/g, context.mode || 'voice')
}
