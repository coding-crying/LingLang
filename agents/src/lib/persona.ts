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
import { and, eq, or, sql } from 'drizzle-orm';
import { resolvePersonaLayers, validatePersonaPatch } from './persona-policy.js';

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

// Default style is replaceable. Explicit tone does not inherit contradictory wit.
const DEFAULT_PERSONA_LINE = `Be an attentive, quick-witted conversation partner who happens to teach languages. Match the learner's rhythm and interests; be playful when welcome, never mock confusion. Avoid canned praise and compulsory questions or repetition. Say when you did not understand.`;

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

  const values = resolvePersonaLayers(
    { explicit: global?.explicitPreferences ?? {}, inferred: global?.inferredPreferences ?? {} },
    { explicit: specific?.explicitPreferences ?? {}, inferred: specific?.inferredPreferences ?? {} },
  );
  return {
    userId,
    languageCode,
    personaOverride: values.personaOverride ?? null,
    tone: values.tone ?? null,
    correctionStyle: values.correctionStyle ?? null,
    teachingMode: values.teachingMode ?? null,
    extraInstructions: values.extraInstructions ?? null,
    voice: values.voice ?? null,
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
  if (!/^(all|[a-z]{2,3})$/.test(languageCode)) throw new Error('Invalid preference language');
  const values = validatePersonaPatch(patch);
  const inferred = patch.source === 'supervisor' || patch.source === 'system';
  const column = inferred ? userPersona.inferredPreferences : userPersona.explicitPreferences;
  await db.insert(userPersona).values({
    userId, languageCode, source: patch.source ?? 'ui',
    explicitPreferences: inferred ? {} : values,
    inferredPreferences: inferred ? values : {},
  }).onConflictDoUpdate({
    target: [userPersona.userId, userPersona.languageCode],
    set: {
      [inferred ? 'inferredPreferences' : 'explicitPreferences']: sql`${column} || ${JSON.stringify(values)}::jsonb`,
      updatedAt: new Date(),
    },
  });
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
  if (!/^(?:please\s+)?(?:can you|could you|would you|i (?:want|prefer|need)|be |keep |stop |don.t |let me |pretend |act like |imagine |drill me|push me|tell me|just talk|more casual|less formal)/.test(t)) return null;
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

  if (/(?:keep|make).*(?:replies|answers|responses|turns).*(?:short|brief)|(?:be|speak).*(?:brief|concise)|let me finish|give me.*(?:time|space)/.test(t)) patch.extraInstructions = text.trim().slice(0, 2000);
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
  const personaLine = persona.personaOverride?.trim() || (persona.tone ? 'Be an attentive language tutor.' : DEFAULT_PERSONA_LINE);
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

  const personaLine = personaOverride?.trim() || (tone ? 'Be an attentive language tutor.' : DEFAULT_PERSONA_LINE);
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
