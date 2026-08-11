import { describe, expect, it } from 'vitest';
import { isSupportedTargetLanguage } from './language-selection.js';

describe('isSupportedTargetLanguage', () => {
  it('accepts configured language codes', () => {
    expect(isSupportedTargetLanguage('pt')).toBe(true);
    expect(isSupportedTargetLanguage('zh')).toBe(true);
  });

  it('rejects missing and unsupported values', () => {
    expect(isSupportedTargetLanguage(undefined)).toBe(false);
    expect(isSupportedTargetLanguage(null)).toBe(false);
    // 'de' is realtime-only (DYNAMIC_LANGUAGES): the language menu never
    // offers it, so the PATCH boundary must not accept it either.
    expect(isSupportedTargetLanguage('de')).toBe(false);
    expect(isSupportedTargetLanguage('xx')).toBe(false);
    expect(isSupportedTargetLanguage(42)).toBe(false);
  });
});
