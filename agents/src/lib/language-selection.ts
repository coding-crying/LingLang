import { LANGUAGES } from '../config/languages.js';

export function isSupportedTargetLanguage(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value);
}
