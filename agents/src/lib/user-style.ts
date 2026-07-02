/**
 * User style (personality mirroring) — read/merge helpers.
 *
 * The processor emits a `styleSignals` object per turn. We EMA those into
 * the user's `user_style` table (one row per key). The conversation prompt
 * reads the current style and tells the LLM to mirror it.
 *
 * Confidence grows with sample count. Below threshold (~0.3) the signal is
 * considered noise and the default style is used.
 */

import { db } from '../db/index.js';
import { userStyle } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

export type StyleKey = 'humor' | 'pacing' | 'register' | 'preamble' | 'bsCallouts';

export const STYLE_KEYS: StyleKey[] = ['humor', 'pacing', 'register', 'preamble', 'bsCallouts'];

/** Default style for new users until ~3 turns of signal accumulate. */
export const DEFAULT_STYLE: Record<StyleKey, string> = {
  humor: 'warm',
  pacing: 'medium',
  register: 'casual',
  preamble: 'low',
  bsCallouts: 'neutral',
};

/** Smooth each new value into the stored value with EMA. Weight α = 0.3. */
const EMA_ALPHA = 0.3;

/**
 * Read the user's current style profile. Returns defaults for missing keys.
 */
export async function readUserStyle(userId: string): Promise<Record<StyleKey, string>> {
  const rows = await db
    .select()
    .from(userStyle)
    .where(eq(userStyle.userId, userId));
  const result: Record<StyleKey, string> = { ...DEFAULT_STYLE };
  for (const r of rows) {
    if ((STYLE_KEYS as string[]).includes(r.styleKey) && r.confidence >= 0.3) {
      result[r.styleKey as StyleKey] = r.styleValue;
    }
  }
  return result;
}

/**
 * Apply a single turn's styleSignals to the user's profile via EMA.
 * Keys not present in the new signal are left unchanged.
 * Sample count increments by 1 per call (regardless of how many keys were updated).
 */
export async function updateUserStyle(
  userId: string,
  signals: Record<string, string> | undefined,
): Promise<void> {
  if (!signals) return;
  const validKeys = new Set<string>(STYLE_KEYS);
  for (const [key, value] of Object.entries(signals)) {
    if (!validKeys.has(key) || typeof value !== 'string' || value.length === 0) continue;

    const existing = await db.query.userStyle.findFirst({
      where: and(eq(userStyle.userId, userId), eq(userStyle.styleKey, key)),
    });

    if (!existing) {
      await db.insert(userStyle).values({
        userId,
        styleKey: key,
        styleValue: value,
        confidence: EMA_ALPHA,
        sampleSize: 1,
        lastUpdated: new Date(),
      });
    } else {
      // EMA: if the new value matches the existing, boost confidence.
      // If different, only switch once confidence in the new value exceeds 0.5
      // (i.e. we've seen it consistently enough to trust it).
      // We track this by counting how many consecutive turns agree with the new value
      // via a simple majority: if new value != existing, we blend confidence DOWN
      // (the signal is noisy) and only flip the value when confidence drops below 0.3.
      const valueChanged = value !== existing.styleValue;
      const newValue = valueChanged
        ? (existing.confidence < 0.4 ? value : existing.styleValue)  // flip if confidence is low
        : existing.styleValue;
      const newConfidence = valueChanged
        ? Math.max(0, existing.confidence - EMA_ALPHA * existing.confidence)  // erode on disagreement
        : Math.min(1.0, existing.confidence + EMA_ALPHA * (1 - existing.confidence));  // grow on agreement
      const newSampleSize = existing.sampleSize + 1;
      await db
        .update(userStyle)
        .set({
          styleValue: newValue,
          confidence: newConfidence,
          sampleSize: newSampleSize,
          lastUpdated: new Date(),
        })
        .where(and(eq(userStyle.userId, userId), eq(userStyle.styleKey, key)));
    }
  }
}

/**
 * Format the user's current style as a directive for the conversation prompt.
 * Returns empty string if no signal has accumulated yet (use default).
 */
export async function buildStyleDirective(userId: string): Promise<string> {
  const style = await readUserStyle(userId);
  return formatStyleDirective(style);
}

export function formatStyleDirective(style: Record<StyleKey, string>): string {
  return [
    'STYLE — Mirror the user\'s communication style. Do not change topic or pace to match this — keep moving the lesson forward. The user\'s current detected style:',
    `  • humor: ${style.humor} (matching this: ${humorGuide(style.humor)})`,
    `  • pacing: ${style.pacing} (matching this: ${pacingGuide(style.pacing)})`,
    `  • register: ${style.register} (matching this: ${registerGuide(style.register)})`,
    `  • preamble tolerance: ${style.preamble} (matching this: ${preambleGuide(style.preamble)})`,
    `  • BS-callout tendency: ${style.bsCallouts} (matching this: ${bsGuide(style.bsCallouts)})`,
  ].join('\n');
}

function humorGuide(v: string): string {
  switch (v) {
    case 'none': return 'be matter-of-fact, no jokes';
    case 'dry': return 'occasional dry wit, deadpan observations';
    case 'sarcastic': return 'playful sarcasm OK, ironic observations';
    case 'warm': return 'genuine warmth, light encouragement, occasional friendly jokes';
    case 'literal': return 'strictly literal, no figurative language';
    default: return 'be warm and natural';
  }
}
function pacingGuide(v: string): string {
  switch (v) {
    case 'fast': return 'be terse, no fluff, get to the next question quickly';
    case 'medium': return 'normal conversational rhythm';
    case 'slow': return 'give the user time, longer pauses, allow for detailed answers';
    default: return 'normal conversational rhythm';
  }
}
function registerGuide(v: string): string {
  switch (v) {
    case 'formal': return 'use formal grammar, no contractions in the target language, full forms';
    case 'casual': return 'use everyday grammar, contractions, colloquial expressions';
    case 'profane': return 'casual to the point of crude — occasional swearing is fine, mirror the user\'s tone without forcing it';
    default: return 'casual, conversational';
  }
}
function preambleGuide(v: string): string {
  switch (v) {
    case 'low': return 'skip the long intros — go straight to the lesson or question';
    case 'medium': return 'one sentence of framing, then the lesson';
    case 'high': return 'the user enjoys a bit of context and scene-setting';
    default: return 'one sentence of framing, then the lesson';
  }
}
function bsGuide(v: string): string {
  switch (v) {
    case 'tolerant': return 'the user accepts the tutor\'s responses as-is — don\'t over-explain';
    case 'neutral': return 'standard — correct yourself when wrong, but don\'t belabor it';
    case 'skeptical': return 'the user pushes back on errors — be honest about uncertainty, correct mistakes explicitly';
    default: return 'standard';
  }
}
