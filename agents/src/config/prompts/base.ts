// Prompt template engine

export interface PromptContext {
  targetLanguage: string
  nativeName: string
  targetRatio: number
  userLevel: string
  initialContext: string
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
}
