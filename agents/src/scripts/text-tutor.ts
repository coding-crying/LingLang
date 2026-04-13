/**
 * Text-Mode Tutor — Interactive CLI for testing the agentic pipeline
 *
 * Runs the full supervisor pipeline (analysis → FSRS → goal selection)
 * without LiveKit, STT, or TTS. Uses local llama-swap for analysis and
 * optionally a cloud LLM for tutor responses.
 *
 * Usage:
 *   npx tsx src/scripts/text-tutor.ts --lang ru
 *   npx tsx src/scripts/text-tutor.ts --lang ru --no-tutor --verbose
 *   npx tsx src/scripts/text-tutor.ts --lang ru --tutor-llm-url https://cake.nano-gpt.com/api/v1 --tutor-model allenai/olmo-3.1-32b-instruct
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as readline from 'node:readline';
import { db } from '../db/index.js';
import { users, userVocabulary, lexemes } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { ContextManager } from '../lib/context.js';
import { runProcessor, runSupervisor, analyzeUtteranceWithLocalLLM, type UtteranceAnalysis, type UtteranceAnalysisResult } from '../tools/supervisor-functions.js';
import { getLanguageConfig } from '../config/languages.js';
import { buildInstructions } from '../config/prompts/base.js';

// ============================================================================
// CLI OPTIONS
// ============================================================================

interface Opts {
  userId: string;
  lang: string;
  model: string;
  llmUrl: string;
  noTutor: boolean;
  tutorModel: string;
  tutorLlmUrl: string;
  tutorApiKey: string;
  verbose: boolean;
}

function parseArgs(args: string[]): Opts {
  const opts: Opts = {
    userId: 'text-test-user',
    lang: process.env.DEFAULT_TARGET_LANGUAGE || 'ru',
    model: process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
    llmUrl: process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1',
    noTutor: false,
    tutorModel: process.env.CONVERSATION_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
    tutorLlmUrl: process.env.CONVERSATION_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1',
    tutorApiKey: process.env.CONVERSATION_LLM_KEY || '',
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--user': opts.userId = args[++i] || opts.userId; break;
      case '--lang': opts.lang = args[++i] || opts.lang; break;
      case '--model': opts.model = args[++i] || opts.model; break;
      case '--llm-url': opts.llmUrl = args[++i] || opts.llmUrl; break;
      case '--no-tutor': opts.noTutor = true; break;
      case '--tutor-model': opts.tutorModel = args[++i] || opts.tutorModel; break;
      case '--tutor-llm-url': opts.tutorLlmUrl = args[++i] || opts.tutorLlmUrl; break;
      case '--tutor-api-key': opts.tutorApiKey = args[++i] || opts.tutorApiKey; break;
      case '--verbose': opts.verbose = true; break;
      case '--help': printHelp(); process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Text-Mode Tutor — Test the agentic pipeline via CLI

Usage: npx tsx src/scripts/text-tutor.ts [options]

Options:
  --user <id>            User ID (default: text-test-user)
  --lang <code>          Target language: ru, es, fr, pt, ar, en (default: ru)
  --model <model>        Analysis LLM model (default: gemma4-26b)
  --llm-url <url>        Analysis LLM endpoint (default: http://localhost:8082/v1)
  --no-tutor             Skip tutor response, just show analysis + FSRS
  --tutor-model <model>  Tutor LLM model (default: same as analysis)
  --tutor-llm-url <url>  Tutor LLM endpoint (default: same as analysis)
  --tutor-api-key <key>  API key for cloud tutor LLM
  --verbose              Show raw LLM prompts and responses

Commands (inside REPL):
  /context    Show current context string
  /vocab      Show vocabulary with FSRS states
  /goal       Force a goal check
  /analyze <text>  Run analysis only (no SRS update)
  /reset      Delete all vocabulary progress for this user
  /help       Show this help
  /quit       Exit
`);
}

// ============================================================================
// TUTOR RESPONSE GENERATION
// ============================================================================

async function generateTutorResponse(
  history: { role: string; content: string }[],
  context: string,
  langConfig: any,
  goalUpdate: string | null,
  opts: Opts,
  processorResult?: import('../tools/supervisor-functions.js').ProcessorResult,
): Promise<string> {
  // Build error context from the latest analysis
  const recentErrors = processorResult?.analysis?.lexemes
    ?.filter(l => l.performance === 'wrong_use' || l.performance === 'recall_fail')
    .map(l => `${l.lemma}: ${l.performance}${l.grammarRule ? ` (${l.grammarRule.rule})` : ''}`)
    .join('; ') || 'None';

  const grammarHints = processorResult?.analysis?.grammarHints?.join(' ') || 'None';

  const systemPrompt = buildInstructions(langConfig.prompts.instructionsTemplate, {
    targetLanguage: langConfig.name,
    nativeName: langConfig.nativeName,
    targetRatio: langConfig.pedagogy.targetLanguageRatio,
    userLevel: 'beginner',
    initialContext: context,
    mode: 'text',
    recentErrors,
    grammarHints,
    goalUpdate: goalUpdate || undefined,
  });

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  if (goalUpdate) {
    messages.push({ role: 'system', content: goalUpdate });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.tutorApiKey) {
    headers['Authorization'] = `Bearer ${opts.tutorApiKey}`;
  }

  try {
    const response = await fetch(`${opts.tutorLlmUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: opts.tutorModel, messages }),
    });

    if (!response.ok) {
      const text = await response.text();
      return `(Tutor LLM error: ${response.status} — ${text.substring(0, 200)})`;
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '(no response)';
  } catch (err: any) {
    return `(Tutor LLM failed: ${err.message})`;
  }
}

// ============================================================================
// VOCABULARY DISPLAY
// ============================================================================

const STATE_LABELS: Record<number, string> = {
  0: 'New',
  1: 'Learning',
  2: 'Review',
  3: 'Relearning',
};

async function showVocabulary(userId: string): Promise<void> {
  const vocab = await db.query.userVocabulary.findMany({
    where: eq(userVocabulary.userId, userId),
    with: { lexeme: true },
    orderBy: [asc(userVocabulary.state)],
  });

  if (vocab.length === 0) {
    console.log('  (no vocabulary yet — type something in the target language!)');
    return;
  }

  console.log(`\nFSRS Vocabulary (${vocab.length} words):`);
  for (const v of vocab) {
    const lemma = v.lexeme?.lemma || v.lexemeId;
    const translation = v.lexeme?.translation || '?';
    const stateLabel = STATE_LABELS[v.state] || `Unknown(${v.state})`;
    const dueStr = v.due <= new Date() ? 'now' : v.due.toISOString().split('T')[0];

    console.log(
      `  ${lemma} (${translation})`.padEnd(30) +
      `— State: ${stateLabel} (${v.state})  ` +
      `Stability: ${v.stability.toFixed(1)}  ` +
      `Difficulty: ${v.difficulty.toFixed(1)}  ` +
      `Due: ${dueStr}  ` +
      `Reps: ${v.reps}`
    );
  }
  console.log('');
}

// ============================================================================
// ANALYSIS-ONLY (dry-run, no DB writes)
// ============================================================================

async function analyzeOnly(
  utterance: string,
  context: string,
  opts: Opts,
): Promise<void> {
  const result = await analyzeUtteranceWithLocalLLM(utterance, context, opts.llmUrl, opts.model);

  if (opts.verbose && result.rawPrompt) {
    console.log('\n--- RAW PROMPT ---');
    console.log(result.rawPrompt.substring(0, 500));
  }

  if (result.analysis) {
    console.log(`\n[Analysis] ${result.analysis.lexemes.length} lexemes:`);
    for (const l of result.analysis.lexemes) {
      console.log(`  ${l.lemma} (${l.pos}) → ${l.performance}${l.form ? ` [form: ${l.form}]` : ''}`);
    }
    if (result.analysis.grammarHints?.length) {
      console.log(`  Grammar hints: ${result.analysis.grammarHints.join('; ')}`);
    }
    console.log(`  Language: ${result.analysis.language}`);
  } else {
    console.log('\n[Analysis] FAILED — no result');
  }

  if (opts.verbose && result.rawResponse) {
    console.log('\n--- RAW RESPONSE ---');
    console.log(result.rawResponse.substring(0, 500));
  }
  console.log('');
}

// ============================================================================
// RESET USER PROGRESS
// ============================================================================

async function resetProgress(userId: string): Promise<void> {
  const deleted = await db.delete(userVocabulary)
    .where(eq(userVocabulary.userId, userId))
    .returning({ id: userVocabulary.id });

  console.log(`\n  Deleted ${deleted.length} vocabulary entries for user "${userId}". Fresh start!\n`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const langConfig = getLanguageConfig(opts.lang);

  console.log(`
╔════════════════════════════════════════════════════════════╗
║              LingLang Text-Mode Tutor                       ║
╠════════════════════════════════════════════════════════════╣
║  Language:  ${langConfig.name.padEnd(42)}║
║  User:      ${opts.userId.padEnd(42)}║
║  Analysis:  ${opts.model.padEnd(42)}║
║  Tutor:     ${opts.noTutor ? '(disabled)' : `${opts.tutorModel} @ ${new URL(opts.tutorLlmUrl).host}`.padEnd(42)}║
╚════════════════════════════════════════════════════════════╝
  `);

  // Ensure user exists
  let user = await db.query.users.findFirst({
    where: eq(users.id, opts.userId),
  });

  if (!user) {
    console.log(`[Init] Creating user "${opts.userId}"...`);
    await db.insert(users).values({
      id: opts.userId,
      targetLanguage: opts.lang,
      nativeLanguage: 'en',
      proficiencyLevel: 'beginner',
    }).onConflictDoNothing();
    user = await db.query.users.findFirst({
      where: eq(users.id, opts.userId),
    });
  }

  // Get initial context
  let currentContext = await ContextManager.getInitialContext(opts.userId);
  console.log('[Context] Initial context loaded.\n');

  // Conversation history for tutor LLM
  const history: { role: string; content: string }[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  console.log('Type in the target language (or /help for commands):\n');

  // Main REPL loop
  while (true) {
    const input = await question('You> ');

    if (!input.trim()) continue;

    // === SLASH COMMANDS ===
    const trimmed = input.trim();

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Bye!');
      break;
    }

    if (trimmed === '/help') {
      printHelp();
      continue;
    }

    if (trimmed === '/context') {
      console.log('\n--- CURRENT CONTEXT ---');
      console.log(currentContext);
      console.log('');
      continue;
    }

    if (trimmed === '/vocab') {
      await showVocabulary(opts.userId);
      continue;
    }

    if (trimmed === '/goal') {
      const goal = await ContextManager.getDynamicGoal(opts.userId);
      console.log(goal ? `\n[Goal] ${goal}\n` : '\n[Goal] No new goal (all good!)\n');
      continue;
    }

    if (trimmed.startsWith('/analyze ')) {
      const text = trimmed.slice('/analyze '.length);
      await analyzeOnly(text, currentContext, opts);
      continue;
    }

    if (trimmed === '/reset') {
      await resetProgress(opts.userId);
      currentContext = await ContextManager.getInitialContext(opts.userId);
      continue;
    }

    // === MAIN PIPELINE ===
    console.log('');
    history.push({ role: 'user', content: input });

    // Run supervisor: analysis + FSRS + goal
    const recentHistory = history.slice(-6).map(h => `${h.role === 'user' ? 'Learner' : 'Tutor'}: ${h.content}`).join('\n');
    const result = await runSupervisor(opts.userId, input, currentContext, {
      useGemini: false,
      llmUrl: opts.llmUrl,
      llmModel: opts.model,
      recentHistory,
    });

    // Print analysis
    if (result.analysis) {
      console.log(`[Analysis] ${result.analysis.lexemes.length} lexemes:`);
      for (const l of result.analysis.lexemes) {
        console.log(`  ${l.lemma} (${l.pos}) → ${l.performance}${l.form ? ` [form: ${l.form}]` : ''}`);
      }
    } else {
      console.log('[Analysis] FAILED — no result');
    }

    // Print FSRS updates
    if (result.srsUpdates.length > 0) {
      const gradeLabels: Record<number, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
      for (const u of result.srsUpdates) {
        console.log(`  [FSRS] ${u.lexemeId}: state ${u.oldState}→${u.newState} (grade ${u.grade}=${gradeLabels[u.grade] || '?'})`);
      }
    }

    // Print goal update
    if (result.goalUpdate) {
      console.log(`\n[Goal] ${result.goalUpdate}`);
    }

    // Print errors
    for (const e of result.errors) {
      console.log(`[Error] ${e}`);
    }

    // Verbose: show raw LLM output
    if (opts.verbose && result.analysis) {
      // We don't have rawPrompt/rawResponse on SupervisorResult, but we can show the analysis JSON
      console.log('\n--- VERBOSE: Analysis JSON ---');
      console.log(JSON.stringify(result.analysis, null, 2).substring(0, 800));
    }

    // Tutor response
    if (!opts.noTutor) {
      console.log(''); // blank line before tutor
      // Construct a ProcessorResult-like object from the SupervisorResult for tutor context
      const procLike: import('../tools/supervisor-functions.js').ProcessorResult = {
        analysis: result.analysis,
        srsUpdates: result.srsUpdates,
        errors: result.errors,
        structuredErrors: result.structuredErrors,
        grammarHints: result.grammarHints,
        rawPrompt: undefined,
        rawResponse: undefined,
      };
      const tutorResult = await generateTutorResponse(
        history,
        currentContext,
        langConfig,
        result.goalUpdate,
        opts,
        procLike,
      );
      console.log(`Tutor> ${tutorResult}`);
      history.push({ role: 'assistant', content: tutorResult });
    }

    // Refresh context for next turn
    currentContext = await ContextManager.getInitialContext(opts.userId);
    console.log('');
  }

  rl.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});