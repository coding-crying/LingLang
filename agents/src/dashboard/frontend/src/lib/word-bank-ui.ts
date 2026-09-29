// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function wordBankStateAriaLabel(label: string, count: string): string {
  return `${label}: ${count === '-' ? 'loading' : count} words`;
}
