/**
 * User Persona — adaptive conversation shell.
 *
 * The conversation agent's prompt has two layers:
 *   - Functional core (level, frontier vocab, error treatment) — lives in base.ts, never touched here
 *   - Adaptive shell (tone, teaching mode, persona override) — lives here, writable by anyone
 *
 * Write sources (in priority order for conflicts):
 *   1. UI (explicit user setting) — highest trust
 *   2. user_voice ("be more casual", "pretend you're a bartender") — high trust
 *   3. supervisor (NOTE[preference] or PERSONA: output) — observed, medium trust
 *   4. system default — fallback
 *
 * The language-specific row takes precedence over the 'all' row.
 * Both are merged: 'all' provides defaults, language-specific overrides.
 */

import { db } from '../db/index.js';
import { userPersona } from '../db/schema.js';
import { and, eq, or } from 'drizzle-orm';

export interface PersonaRow {
  userId: string;
  languageCode: string;
  personaOverride: string | null;
  tone: string | null;
  correctionStyle: string | null;
  teachingMode: string | null;
  extraInstructions: string | null;
  /** Realtime voice; null = shared default. Applies from the next session. */
  voice: string | null;
  source: string;
  updatedAt: Date;
}

export interface PersonaPatch {
  personaOverride?: string | null;
  tone?: string | null;
  correctionStyle?: string | null;
  teachingMode?: string | null;
  extraInstructions?: string | null;
  voice?: string | null;
  source?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PERSONA_LINE =
  "You are a sharp, witty language tutor. Roast mistakes with charm — not cruelty. No cheerleading. No 'great job.'";

const TONE_LINES: Record<string, string> = {
  roast:           "Roast freely — they can take it. Sharp wit, no cruelty.",
  warm:            "Be warm and encouraging. Celebrate progress, soften corrections.",
  neutral:         "Be matter-of-fact. Correct clearly, no editorializing.",
  formal:          "Keep a formal register. No slang, no jokes.",
  'drill-sergeant': "Be demanding. Short, direct, no hand-holding. Drill until it sticks.",
};

const CORRECTION_LINES: Record<string, string> = {
  immediate:   "Correct errors immediately — say the right form, then move on.",
  gentle:      "Correct gently — acknowledge what they got right first.",
  ignore:      "Don't correct errors explicitly. Model the right form naturally in your reply.",
  'end-of-turn': "Let them finish, then give one correction at the end of your reply.",
};

const TEACHING_MODE_LINES: Record<string, string> = {
  conversational: "Keep it conversational — teach through natural dialogue, not drills.",
  drill:          "Drill mode — repeat patterns until they stick. Short, focused exchanges.",
  roleplay:       "Use roleplay — give them a scenario and stay in character.",
  storytelling:   "Use storytelling — build a narrative together, weave vocabulary in.",
};

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the merged persona for a user+language.
 * Language-specific row overrides 'all' row field-by-field.
 */
export async function readPersona(
  userId: string,
  languageCode: string,
): Promise<PersonaRow & { merged: true }> {
  const rows = await db
    .select()
    .from(userPersona)
    .where(
      and(
        eq(userPersona.userId, userId),
        or(
          eq(userPersona.languageCode, languageCode),
          eq(userPersona.languageCode, 'all'),
        ),
      ),
    );

  const global = rows.find((r) => r.languageCode === 'all') ?? null;
  const specific = rows.find((r) => r.languageCode === languageCode) ?? null;

  // Merge: specific wins over global, global wins over null
  return {
    userId,
    languageCode,
    personaOverride: specific?.personaOverride ?? global?.personaOverride ?? null,
    tone: specific?.tone ?? global?.tone ?? null,
    correctionStyle: specific?.correctionStyle ?? global?.correctionStyle ?? null,
    teachingMode: specific?.teachingMode ?? global?.teachingMode ?? null,
    extraInstructions: specific?.extraInstructions ?? global?.extraInstructions ?? null,
    voice: specific?.voice ?? global?.voice ?? null,
    source: specific?.source ?? global?.source ?? 'system',
    updatedAt: specific?.updatedAt ?? global?.updatedAt ?? new Date(),
    merged: true,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert a persona patch for a user+language.
 * Only fields present in the patch are written — null explicitly clears a field.
 * Undefined fields are left unchanged (partial update).
 */
export async function writePersona(
  userId: string,
  languageCode: string,
  patch: PersonaPatch,
): Promise<void> {
  const existing = await db.query.userPersona.findFirst({
    where: and(
      eq(userPersona.userId, userId),
      eq(userPersona.languageCode, languageCode),
    ),
  });

  const now = new Date();

  if (!existing) {
    await db.insert(userPersona).values({
      userId,
      languageCode,
      personaOverride: patch.personaOverride ?? null,
      tone: patch.tone ?? null,
      correctionStyle: patch.correctionStyle ?? null,
      teachingMode: patch.teachingMode ?? null,
      extraInstructions: patch.extraInstructions ?? null,
      voice: patch.voice ?? null,
      source: patch.source ?? 'system',
      updatedAt: now,
    });
  } else {
    const update: Partial<typeof existing> = { updatedAt: now };
    if (patch.source !== undefined) update.source = patch.source;
    if ('personaOverride' in patch) update.personaOverride = patch.personaOverride ?? null;
    if ('tone' in patch) update.tone = patch.tone ?? null;
    if ('correctionStyle' in patch) update.correctionStyle = patch.correctionStyle ?? null;
    if ('teachingMode' in patch) update.teachingMode = patch.teachingMode ?? null;
    if ('extraInstructions' in patch) update.extraInstructions = patch.extraInstructions ?? null;
    if ('voice' in patch) update.voice = patch.voice ?? null;

    await db
      .update(userPersona)
      .set(update)
      .where(
        and(
          eq(userPersona.userId, userId),
          eq(userPersona.languageCode, languageCode),
        ),
      );
  }
}

/**
 * Parse a natural-language persona update request (from user voice or supervisor)
 * into a PersonaPatch. Returns null if nothing actionable was found.
 *
 * Examples:
 *   "be more casual"         → { tone: 'warm', correctionStyle: 'gentle' }
 *   "stop correcting me"     → { correctionStyle: 'ignore' }
 *   "pretend we're at a café" → { extraInstructions: "pretend we're at a café" }
 *   "be more formal"         → { tone: 'formal' }
 *   "drill me harder"        → { tone: 'drill-sergeant', teachingMode: 'drill' }
 */
export function parsePersonaRequest(text: string): PersonaPatch | null {
  const t = text.toLowerCase().trim();
  const patch: PersonaPatch = {};

  // Tone signals
  if (/more casual|less formal|relax|chill|loosen up/.test(t)) patch.tone = 'warm';
  else if (/more formal|professional|serious/.test(t)) patch.tone = 'formal';
  else if (/roast|tease|be mean|be harsh|don.t hold back/.test(t)) patch.tone = 'roast';
  else if (/drill|harder|push me|no mercy|strict/.test(t)) {
    patch.tone = 'drill-sergeant';
    patch.teachingMode = 'drill';
  }
  else if (/be nice|be kind|encouraging|gentle/.test(t)) patch.tone = 'warm';

  // Correction style
  if (/stop correct|don.t correct|ignore.*mistake|no correction/.test(t)) {
    patch.correctionStyle = 'ignore';
  } else if (/correct.*end|wait.*correct|let me finish/.test(t)) {
    patch.correctionStyle = 'end-of-turn';
  } else if (/correct.*immediately|right away|instant/.test(t)) {
    patch.correctionStyle = 'immediate';
  }

  // Teaching mode
  if (/roleplay|role.play|scenario|pretend|act like|imagine/.test(t)) {
    patch.teachingMode = 'roleplay';
    // Capture the scenario as extra instructions
    const scenarioMatch = text.match(/pretend[^.!?]*|act like[^.!?]*|imagine[^.!?]*/i);
    if (scenarioMatch) patch.extraInstructions = scenarioMatch[0].trim();
  } else if (/tell.*story|storytell|narrative/.test(t)) {
    patch.teachingMode = 'storytelling';
  } else if (/conversational|just talk|natural/.test(t)) {
    patch.teachingMode = 'conversational';
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// ─── Build prompt block ───────────────────────────────────────────────────────

/**
 * Build the adaptive shell block for the conversation agent's system prompt.
 * Returns a string to inject after the functional core.
 *
 * This is the ONLY place that reads persona + style and produces prompt text.
 * Called inside buildDynamicInstructions() on every refresh.
 */
export function buildPersonaBlock(
  persona: ReturnType<typeof readPersona> extends Promise<infer T> ? T : never,
): string {
  const lines: string[] = [];

  // 1. Persona line — override or default
  const personaLine = persona.personaOverride?.trim() || DEFAULT_PERSONA_LINE;
  lines.push(personaLine);

  // 2. Tone
  const tone = persona.tone;
  if (tone && TONE_LINES[tone]) {
    lines.push(TONE_LINES[tone]);
  }

  // 3. Correction style
  const corrLine = persona.correctionStyle ? CORRECTION_LINES[persona.correctionStyle] : undefined;
  if (corrLine) lines.push(corrLine);

  // 4. Teaching mode
  const modeLineVal = persona.teachingMode ? TEACHING_MODE_LINES[persona.teachingMode] : undefined;
  if (modeLineVal) lines.push(modeLineVal);

  // 5. Extra instructions (freeform)
  if (persona.extraInstructions?.trim()) {
    lines.push(persona.extraInstructions.trim());
  }

  return lines.join('\n');
}

/**
 * Synchronous version for use inside buildDynamicInstructions where we
 * can't await. Pass the pre-loaded persona row.
 */
export function buildPersonaBlockSync(
  personaOverride: string | null,
  tone: string | null,
  correctionStyle: string | null,
  teachingMode: string | null,
  extraInstructions: string | null,
): string {
  const lines: string[] = [];

  const personaLine = personaOverride?.trim() || DEFAULT_PERSONA_LINE;
  lines.push(personaLine);

  const toneLine = tone ? TONE_LINES[tone] : undefined;
  if (toneLine) lines.push(toneLine);

  const corrLineSync = correctionStyle ? CORRECTION_LINES[correctionStyle] : undefined;
  if (corrLineSync) lines.push(corrLineSync);

  const modeLineSync = teachingMode ? TEACHING_MODE_LINES[teachingMode] : undefined;
  if (modeLineSync) lines.push(modeLineSync);

  if (extraInstructions?.trim()) {
    lines.push(extraInstructions.trim());
  }

  return lines.join('\n');
}
