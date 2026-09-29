// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { wordBankStateAriaLabel } from './word-bank-ui';

describe('word bank compact state controls', () => {
  it('keeps the state meaning and count available to assistive technology', () => {
    expect(wordBankStateAriaLabel('Heard', '12')).toBe('Heard: 12 words');
  });

  it('announces loading without exposing a placeholder dash', () => {
    expect(wordBankStateAriaLabel('Review', '-')).toBe('Review: loading words');
  });
});
