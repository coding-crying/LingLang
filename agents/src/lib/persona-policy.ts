// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export const PERSONA_FIELDS = [
  'tone',
  'correctionStyle',
  'teachingMode',
  'personaOverride',
  'extraInstructions',
  'voice',
] as const;
export type PersonaValues = Partial<Record<(typeof PERSONA_FIELDS)[number], string | null>>;
export interface PersonaLayers {
  explicit: PersonaValues;
  inferred: PersonaValues;
}
const enums: Record<string, readonly string[]> = {
  tone: ['roast', 'warm', 'neutral', 'formal', 'drill-sergeant'],
  correctionStyle: ['immediate', 'gentle', 'ignore', 'end-of-turn'],
  teachingMode: ['conversational', 'drill', 'roleplay', 'storytelling'],
  voice: ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'],
};
export function validatePersonaPatch(raw: unknown): PersonaValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid preference patch');
  const values = raw as Record<string, unknown>;
  const out: PersonaValues = {};
  for (const key of PERSONA_FIELDS) {
    if (!(key in values)) continue;
    const value = values[key];
    if (value === null || value === '') {
      out[key] = null;
      continue;
    }
    if (
      typeof value !== 'string' ||
      value.length > 2000 ||
      (enums[key] && !enums[key]!.includes(value))
    )
      throw new Error(`Invalid ${key}`);
    out[key] = value.trim() || null;
  }
  return out;
}
export function parseSupervisorPersona(text: string): PersonaValues {
  if (text.trim().startsWith('{')) return validatePersonaPatch(JSON.parse(text));
  const raw: Record<string, string> = {};
  const fields = [
    ...text.matchAll(
      /(?:^|,\s*)(tone|correctionStyle|teachingMode|personaOverride|extraInstructions)\s*=\s*/g,
    ),
  ];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    raw[field[1]!] = text
      .slice(field.index! + field[0].length, fields[i + 1]?.index ?? text.length)
      .trim();
  }
  return validatePersonaPatch(raw);
}
export function resolvePersonaLayers(
  global: PersonaLayers,
  specific: PersonaLayers,
): PersonaValues {
  return { ...global.inferred, ...specific.inferred, ...global.explicit, ...specific.explicit };
}
