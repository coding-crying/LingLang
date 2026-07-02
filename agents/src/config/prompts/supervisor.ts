/**
 * Planner prompt — produces natural teaching guidance, not rigid JSON.
 *
 * The planner is a background agent that reads the DB and produces a
 * short nudge for the conversation agent. The nudge gets injected into
 * the tutor's system prompt as CURRENT_FOCUS.
 *
 * The planner should care about TWO things equally:
 *   1. Learning effectiveness (FSRS state, review timing, difficulty)
 *   2. User enjoyment (variety, pacing, not grinding the same drill)
 */

export const PLANNER_SYSTEM_PROMPT = `You are a language tutor planner. Read the learner's state and produce two things:

1. A short teaching nudge for the conversation agent (1-3 sentences)
2. An updated running summary of what's happened in this session

Your nudge adds STRATEGY, not data. The agent already knows what errors just happened and what grammar hints to give. Your job is to decide: what matters most right now, and how to approach it. Suggest context, angle, or tone — not just "review this word."

The running summary is your memory of the session so far. Update it each cycle to reflect what happened. Keep it 2-3 sentences. It should capture: topics covered, what the learner struggled with, what they got comfortable with, and any patterns you noticed. This summary gets passed back to you next cycle so you remember what already happened.

Session gap: if the learner's last session was recent (minutes ago), pick up where they left off. If it was hours ago, do a light review of what they learned. If it was days ago or longer, start with a warm-up review of struggling words before introducing new material.

Match the learner's level:
- Beginner (A1-A2): teach basic words, give lots of support
- Intermediate (B1-B2): focus on nuance, idioms, natural phrasing — they already know function words
- Advanced (C1-C2): challenge them with register, style, subtlety

Do NOT create remediation goals for basic function words (pronouns, conjunctions, prepositions, articles). Those are acquired through exposure, not drilling.

Balance:
- Learning: review due/struggling words, introduce new ones when ready
- Enjoyment: variety, natural flow, no repetitive drilling

FSRS states:
  New (0) = never seen, Learning (1) = struggling, Review (2) = stable, Relearning (3) = forgot

If a word keeps showing up as Learning or Relearning, try a different angle — don't just quiz the same way.

Output format — exactly two lines:
NUDGE: your 1-3 sentence teaching nudge
SUMMARY: your updated 2-3 sentence session summary

LEARNER NOTES:
If you discover something durable about this learner that you'd want to remember tomorrow, append a NOTE line. Only write a note when you've learned something genuinely new — most cycles should NOT produce a note. Categories: preference, level, frustration, goal, engagement. Max 1 note per cycle. Format:

NOTE[category]: one sentence

Example: NOTE[preference]: Engages more with role-play scenarios than vocabulary drills.
Do NOT repeat or restate notes that are already in the Learner Notes section below.

PERSONA UPDATES:
If you observe that the current teaching style is clearly wrong for this learner (e.g. they're frustrated by the roasting, or they explicitly asked for something different), you may patch the persona. Only do this when you have clear evidence — not on a whim. Format:

PERSONA: field=value[, field=value...]

Valid fields: tone (roast|warm|neutral|formal|drill-sergeant), correctionStyle (immediate|gentle|ignore|end-of-turn), teachingMode (conversational|drill|roleplay|storytelling), personaOverride (free text), extraInstructions (free text)

Example: PERSONA: tone=warm, correctionStyle=gentle
Example: PERSONA: extraInstructions=pretend we are at a café in Lisbon
Do NOT emit PERSONA unless you have clear evidence the current style is wrong.` as const;


export interface PlannerContext {
  /** DB snapshot text (SRS due items, new vocab candidates, etc.) */
  dbContext: string;
  /** Active goal note from the goal-seeking cycle, or null */
  goalNote: string | null;
  /** Recent conversation history (formatted string) */
  recentHistory: string;
  /** Previous nudge text, or null if first run */
  previousNudge: string | null;
  /** Running session summary from last planner cycle */
  runningSummary: string;
  /** Reason this planner invocation was triggered */
  reason: string;
  /** Accumulated signals since the last planner run */
  signals: string[];
  /** Active learner notes (formatted string) */
  notes: string;
  /** Recent session summaries (formatted string) */
  recentSessions: string;
  /** Onboarding state summary — null if complete, string if in-progress/not-started */
  onboardingContext?: string | null;
}

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const signals = ctx.signals.slice(-10).join(', ') || 'none';

  const notesSection = ctx.notes ? `\n${ctx.notes}` : '';
  const sessionsSection = ctx.recentSessions ? `\n${ctx.recentSessions}` : '';
  const summarySection = ctx.runningSummary ? `\nRunning Summary: ${ctx.runningSummary}` : '\nRunning Summary: (first cycle — no summary yet)';

  return `Reason: ${ctx.reason}
Signals: ${signals}

${ctx.previousNudge ? `Previous nudge (did the agent follow this?): ${ctx.previousNudge}` : 'No previous nudge — this is the first one.'}

DB state:
${ctx.dbContext}

Goals:
${ctx.goalNote || 'None'}${notesSection}${sessionsSection}${summarySection}

Recent conversation:
${ctx.recentHistory}`;
}

/**
 * Audio-aware planner messages. When the caller has audio history (recent
 * user audio as audio_url content, older audio collapsed), we send those
 * turns to the LLM directly so the planner can hear pronunciation issues
 * and tailor nudges accordingly (e.g. "drill palatal fricative next" if
 * the user keeps aspirating /x/).
 *
 * The control block (DB state, previous nudge, running summary, signals)
 * is sent as a single text user message so the planner has full context
 * before the audio turns.
 */
export interface AudioTurn {
  /** Original transcript text or placeholder */
  content: string;
  audioUri: string;
  durationSec: number;
}

export function buildPlannerMessages(
  ctx: PlannerContext,
  audioTurns: AudioTurn[] = [],
  opts: { keepRecentAudioTurns?: number } = {},
): any[] {
  const MAX_AUDIO_TURNS = opts.keepRecentAudioTurns ?? 3;
  const signals = ctx.signals.slice(-10).join(', ') || 'none';
  const notesSection = ctx.notes ? `\n${ctx.notes}` : '';
  const sessionsSection = ctx.recentSessions ? `\n${ctx.recentSessions}` : '';
  const summarySection = ctx.runningSummary ? `\nRunning Summary: ${ctx.runningSummary}` : '\nRunning Summary: (first cycle — no summary yet)';

  const controlBlock = `Reason: ${ctx.reason}
Signals: ${signals}

${ctx.previousNudge ? `Previous nudge (did the agent follow this?): ${ctx.previousNudge}` : 'No previous nudge — this is the first one.'}

DB state:
${ctx.dbContext}

Goals:
${ctx.goalNote || 'None'}${notesSection}${sessionsSection}${summarySection}`;

  const out: any[] = [
    { role: 'user', content: controlBlock },
  ];

  if (audioTurns.length > 0) {
    // Most-recent audio turns become audio_url. Older ones collapse to a
    // single text marker so the LLM knows they happened but doesn't waste
    // tokens on stale audio.
    const recentAudio = audioTurns.slice(-MAX_AUDIO_TURNS);
    const olderCount = audioTurns.length - recentAudio.length;

    if (olderCount > 0) {
      out.push({
        role: 'user',
        content: `[${olderCount} earlier user audio turn(s) — already analyzed; see running summary above.]`,
      });
    }

    for (const t of recentAudio) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: `[User spoke for ${t.durationSec.toFixed(2)}s. Listen for pronunciation patterns and what they said.]` },
          { type: 'audio_url', audio_url: { url: t.audioUri } },
        ],
      });
    }
  } else {
    // No audio — also include the text recent history so the planner has
    // something to read.
    out.push({ role: 'user', content: `Recent conversation:\n${ctx.recentHistory}` });
  }

  return out;
}