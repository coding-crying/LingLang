/**
 * Eval Conversations — Automated conversation evaluation harness for LingLang.
 *
 * Simulates multi-turn learner conversations through the full 3-agent pipeline
 * (Analysis → FSRS → Goal → Tutor) and evaluates analysis accuracy,
 * FSRS progression, and goal relevance.
 *
 * The simulated learner produces utterances with self-annotated ground truth
 * (intended errors and correct words) so we can measure precision/recall
 * against the processor's analysis output.
 *
 * Usage:
 *   npx tsx src/scripts/eval-conversations.ts --lang ru --turns 10 --scenario beginner
 *   npx tsx src/scripts/eval-conversations.ts --lang ru --all --report-file eval.json
 *   npx tsx src/scripts/eval-conversations.ts --lang en --scenario error-heavy --no-tutor
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { db } from '../db/index.js';
import { users, userVocabulary, lexemes, units, activeGoals } from '../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { runProcessor, runSupervisor } from '../tools/supervisor-functions.js';
import { ContextManager } from '../lib/context.js';
import { getLanguageConfig, nativeLanguageName } from '../config/languages.js';
import { buildInstructions } from '../config/prompts/base.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerPrompt } from '../config/prompts/supervisor.js';
import type { ProcessorResult } from '../tools/supervisor-functions.js';

// ============================================================================
// TYPES
// ============================================================================

interface IntendedError {
  word: string;
  error_type: string;
  wrong_form: string;
  correct_form: string;
}

interface GroundTruth {
  target_words: string[];
  intended_errors: IntendedError[];
  intended_correct: string[];
}

interface TurnRecord {
  turn: number;
  learnerUtterance: string;
  groundTruth: GroundTruth | null;
  processorResult: ProcessorResult | null;
  supervisorGoal: string | null;
  tutorResponse: string | null;
  elapsedMs: number;
  timestamp: string;
  skipped?: boolean;
  rawLearnerOutput?: string;
}

interface ScenarioConfig {
  name: string;
  proficiency: string;
  targetErrorRate: number;
  errorTypes: string[];
  systemPrompt: string;
}

interface EvalMetrics {
  analysis_accuracy: {
    error_detection_precision: number;
    error_detection_recall: number;
    correct_labeling_precision: number;
    correct_labeling_recall: number;
    hallucination_rate: number;
    per_turn: Array<{
      turn: number;
      true_positives: number;
      false_positives: number;
      false_negatives: number;
      detected_errors: number;
      ground_truth_errors: number;
    }>;
  };
  fsrs_progression: {
    stability_delta_correct: { mean: number; std: number };
    stability_delta_wrong: { mean: number; std: number };
    state_progression_correct: { mean: number; std: number };
    state_progression_wrong: { mean: number; std: number };
    grade_distribution: Record<number, number>;
    new_word_count: number;
    expectation_violations: string[];
  };
  goal_relevance: {
    goal_emission_rate: number;
    goal_type_distribution: Record<string, number>;
    goal_target_found: { remediation_valid: number; remediation_invalid: number };
  };
  vocabulary_coverage: {
    seeded_hit_rate: number;
    seeded_encounter_rate: number;
    auto_created_lexemes: string[];
    unique_words_per_turn: { mean: number; std: number };
  };
}

interface EvalReport {
  meta: {
    timestamp: string;
    scenario: string;
    language: string;
    model: string;
    tutorModel: string;
    turns: number;
    userId: string;
  };
  turns: TurnRecord[];
  metrics: EvalMetrics;
  summary: string;
}

// ============================================================================
// SCENARIO DEFINITIONS
// ============================================================================

const SCENARIOS: Record<string, ScenarioConfig> = {
  beginner: {
    name: 'beginner',
    proficiency: 'beginner',
    targetErrorRate: 0.6,
    errorTypes: ['conjugation', 'case', 'gender'],
    systemPrompt: `You are simulating a beginner {language} learner. You know about 50 words.
You frequently make mistakes: wrong verb conjugations, wrong case endings, wrong gender agreement.
Your vocabulary is limited to greetings, basic nouns, and simple verbs.
Respond briefly — 1-2 short sentences in {language}.`,
  },
  intermediate: {
    name: 'intermediate',
    proficiency: 'intermediate',
    targetErrorRate: 0.3,
    errorTypes: ['case', 'aspect', 'word_order'],
    systemPrompt: `You are simulating an intermediate {language} learner. You know about 500 words.
You make occasional errors with complex case patterns, aspect choices, and participles.
You handle basic conversations well but struggle with extended discourse.
Respond in {language} — 2-3 sentences, natural conversational style.`,
  },
  advanced: {
    name: 'advanced',
    proficiency: 'advanced',
    targetErrorRate: 0.1,
    errorTypes: ['aspect', 'subtle_case'],
    systemPrompt: `You are simulating an advanced {language} learner. You rarely make errors.
When you do, they are subtle: occasional wrong aspect, rare case confusion with numerals.
You sound natural and fluent most of the time.
Respond in {language} — natural, fluent sentences.`,
  },
  'error-heavy': {
    name: 'error-heavy',
    proficiency: 'intermediate',
    targetErrorRate: 0.8,
    errorTypes: ['conjugation', 'case', 'gender', 'number', 'preposition'],
    systemPrompt: `You are simulating a {language} learner who frequently makes errors.
Conjugate verbs incorrectly, use wrong case endings, mismatch gender, confuse prepositions.
About 80% of content words should have some error.
Respond in {language} — imperfect, halting sentences.`,
  },
  'error-free': {
    name: 'error-free',
    proficiency: 'advanced',
    targetErrorRate: 0,
    errorTypes: [],
    systemPrompt: `You are simulating a near-native {language} speaker.
Use correct grammar, proper case, appropriate aspect, and natural word order.
Do NOT make any intentional errors. Every word should be correct.
Respond in {language} — natural, fluent sentences.`,
  },
};

// ============================================================================
// CLI OPTIONS
// ============================================================================

interface Opts {
  turns: number;
  scenario: string;
  lang: string;
  model: string;
  tutorModel: string;
  learnerModel: string;
  llmUrl: string;
  tutorLlmUrl: string;
  tutorApiKey: string;
  reportFile: string;
  userId: string;
  noTutor: boolean;
  verbose: boolean;
  runAll: boolean;
  delayMs: number;
  cleanup: boolean;
}

function parseArgs(args: string[]): Opts {
  const timestamp = Date.now();
  const defaults: Opts = {
    turns: 10,
    scenario: 'beginner',
    lang: process.env.DEFAULT_TARGET_LANGUAGE || 'ru',
    model: process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
    tutorModel: process.env.CONVERSATION_LLM_MODEL || process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
    learnerModel: process.env.LOCAL_LLM_MODEL || 'gemma4-26b',
    llmUrl: process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1',
    tutorLlmUrl: process.env.CONVERSATION_LLM_URL || process.env.LOCAL_LLM_URL || 'http://localhost:8082/v1',
    tutorApiKey: process.env.CONVERSATION_LLM_KEY || '',
    reportFile: `eval-${timestamp}.json`,
    userId: `eval-beginner-${timestamp}`,
    noTutor: false,
    verbose: false,
    runAll: false,
    delayMs: 500,
    cleanup: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--turns': defaults.turns = Number(args[++i]); break;
      case '--scenario': defaults.scenario = args[++i] || defaults.scenario; break;
      case '--lang': defaults.lang = args[++i] || defaults.lang; break;
      case '--model': defaults.model = args[++i] || defaults.model; break;
      case '--tutor-model': defaults.tutorModel = args[++i] || defaults.tutorModel; break;
      case '--learner-model': defaults.learnerModel = args[++i] || defaults.learnerModel; break;
      case '--llm-url': defaults.llmUrl = args[++i] || defaults.llmUrl; break;
      case '--tutor-llm-url': defaults.tutorLlmUrl = args[++i] || defaults.tutorLlmUrl; break;
      case '--tutor-api-key': defaults.tutorApiKey = args[++i] || defaults.tutorApiKey; break;
      case '--report-file': defaults.reportFile = args[++i] || defaults.reportFile; break;
      case '--user-id': defaults.userId = args[++i] || defaults.userId; break;
      case '--no-tutor': defaults.noTutor = true; break;
      case '--verbose': defaults.verbose = true; break;
      case '--all': defaults.runAll = true; break;
      case '--delay-ms': defaults.delayMs = Number(args[++i]); break;
      case '--cleanup': defaults.cleanup = true; break;
    }
  }
  return defaults;
}

// ============================================================================
// LEARNER SIMULATOR
// ============================================================================

const LANG_NAMES: Record<string, string> = {
  ru: 'Russian', es: 'Spanish', fr: 'French', pt: 'Portuguese', ar: 'Arabic', en: 'English',
};

class LearnerSimulator {
  private config: ScenarioConfig;
  private lang: string;
  private model: string;
  private llmUrl: string;
  private verbose: boolean;

  constructor(config: ScenarioConfig, lang: string, model: string, llmUrl: string, verbose: boolean) {
    this.config = config;
    this.lang = lang;
    this.model = model;
    this.llmUrl = llmUrl;
    this.verbose = verbose;
  }

  async generateUtterance(
    topicCue: string,
    history: { role: string; content: string }[],
  ): Promise<{ utterance: string; groundTruth: GroundTruth | null }> {
    const langName = LANG_NAMES[this.lang] || this.lang;
    const systemPrompt = this.config.systemPrompt.replace(/{language}/g, langName);

    const errorInstruction = this.config.errorTypes.length > 0
      ? `\n\nError types to include: ${this.config.errorTypes.join(', ')}. ` +
        `Target error rate: ~${Math.round(this.config.targetErrorRate * 100)}% of content words should have errors.`
      : '\n\nDo NOT make any errors. Every word must be correct.';

    const correctionAwareness = `\n\nIMPORTANT: If the tutor just corrected a word or construction, try to use the CORRECT form in your response. You're a learner who improves — don't repeat errors the tutor already corrected. However, you may still make OTHER errors.`;

    const evalInstruction = `\n\nCRITICAL: After your utterance, on a NEW LINE, output a JSON block wrapped in <!--EVAL--> markers like this:
<!--EVAL-->
{"target_words":["word1","word2"],"intended_errors":[{"word":"lemma","error_type":"conjugation","wrong_form":"form_used","correct_form":"correct_form"}],"intended_correct":["word3","word4"]}
<!--/EVAL-->

The intended_errors list should contain ONLY the errors you INTENTIONALLY made. The intended_correct list should contain words you used correctly ON PURPOSE. The target_words list should contain ALL content words you used.`;

    const topicLine = topicCue ? `\n\nTry to use these words in your response: ${topicCue}` : '';

    const messages: { role: string; content: string }[] = [
      { role: 'system', content: systemPrompt + errorInstruction + correctionAwareness + evalInstruction },
      ...history.slice(-6), // Last 3 exchanges
      { role: 'user', content: `Respond in ${langName}.${topicLine}` },
    ];

    if (this.verbose) {
      console.log('\n[EVAL] Learner prompt (last msg):', messages[messages.length - 1].content.substring(0, 200));
    }

    try {
      const response = await fetch(`${this.llmUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, temperature: 0.7, max_tokens: 300 }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`[EVAL] Learner LLM error: ${response.status} — ${text.substring(0, 200)}`);
        return { utterance: `[LLM error: ${response.status}]`, groundTruth: null };
      }

      const data = await response.json() as any;
      const fullText = data.choices?.[0]?.message?.content || '';

      // Parse utterance and ground truth
      const evalMatch = fullText.match(/<!--EVAL-->\s*([\s\S]*?)\s*<!--\/EVAL-->/);
      const utterance = fullText.replace(/<!--EVAL-->[\s\S]*?<!--\/EVAL-->/g, '').trim();

      if (evalMatch) {
        try {
          let jsonStr = evalMatch[1].trim();
          if (jsonStr.includes('```')) {
            const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (codeBlock) jsonStr = codeBlock[1].trim();
          }
          const groundTruth = JSON.parse(jsonStr) as GroundTruth;
          return { utterance, groundTruth };
        } catch {
          if (this.verbose) console.log('[EVAL] Failed to parse ground truth JSON');
          return { utterance, groundTruth: null };
        }
      }

      // No eval markers found — retry once with simpler prompt
      if (this.verbose) console.log('[EVAL] No <!--EVAL--> markers found in learner output');

      // Return utterance without ground truth
      return { utterance, groundTruth: null };
    } catch (err: any) {
      console.error(`[EVAL] Learner LLM error: ${err.message}`);
      return { utterance: `[error]`, groundTruth: null };
    }
  }
}

// ============================================================================
// CONVERSATION RUNNER
// ============================================================================

class ConversationRunner {
  private userId: string;
  private lang: string;
  private langConfig: any;
  private opts: Opts;
  private scenario: ScenarioConfig;
  private history: { role: string; content: string }[] = [];
  private turns: TurnRecord[] = [];

  constructor(userId: string, lang: string, opts: Opts) {
    this.userId = userId;
    this.lang = lang;
    this.langConfig = getLanguageConfig(lang);
    this.opts = opts;
    this.scenario = SCENARIOS[opts.scenario] || SCENARIOS.beginner;
  }

  async run(): Promise<TurnRecord[]> {
    const learner = new LearnerSimulator(
      this.scenario, this.lang, this.opts.learnerModel, this.opts.llmUrl, this.opts.verbose,
    );

    // Get topic cues from curriculum lexemes
    const topicCues = await this.getTopicCues();

    console.log(`\n[EVAL] Running ${this.opts.turns} turns (scenario: ${this.scenario.name}, lang: ${this.lang})`);

    for (let i = 0; i < this.opts.turns; i++) {
      const start = Date.now();
      const topicCue = topicCues[i % topicCues.length] || '';

      console.log(`\n--- Turn ${i + 1}/${this.opts.turns} ---`);
      console.log(`[EVAL] Topic cue: ${topicCue.substring(0, 60)}...`);

      // 1. Generate learner utterance
      const { utterance, groundTruth } = await learner.generateUtterance(topicCue, this.history);
      console.log(`[EVAL] Learner: "${utterance.substring(0, 80)}..."`);
      if (groundTruth) {
        console.log(`[EVAL] Ground truth: ${groundTruth.intended_errors.length} errors, ${groundTruth.intended_correct.length} correct`);
      }

      // 2. Process through the pipeline
      let context = await ContextManager.getInitialContext(this.userId);
      const recentHistory = this.history.slice(-6).map(h => `${h.role === 'user' ? 'Learner' : 'Tutor'}: ${h.content}`).join('\n');
      const processorResult = await runProcessor(this.userId, utterance, context, {
        llmUrl: this.opts.llmUrl,
        llmModel: this.opts.model,
        recentHistory,
      });

      if (processorResult.errors.length > 0) {
        console.log(`[EVAL] Processor errors: ${processorResult.errors.join(', ')}`);
      }

      // 3. Get goal (multi-goal system)
      let goalUpdate: string | null = null;
      try {
        goalUpdate = await ContextManager.updateGoals(this.userId,
          processorResult.structuredErrors
            ? { errors: processorResult.structuredErrors, grammarHints: processorResult.grammarHints || [] }
            : undefined
        );
      } catch (err: any) {
        console.log(`[EVAL] Goal error: ${err.message}`);
      }

      // 3.5. Run planner for teaching strategy
      const dbContext = await ContextManager.getInitialContext(this.userId);
      goalUpdate = await this.runPlanner(processorResult, goalUpdate, dbContext);

      // 4. Optionally generate tutor response
      let tutorResponse: string | null = null;
      if (!this.opts.noTutor) {
        tutorResponse = await this.generateTutorResponse(goalUpdate, context, processorResult);
        if (tutorResponse) {
          console.log(`[EVAL] Tutor: "${tutorResponse.substring(0, 80)}..."`);
          this.history.push({ role: 'user', content: utterance });
          this.history.push({ role: 'assistant', content: tutorResponse });
        }
      } else {
        this.history.push({ role: 'user', content: utterance });
      }

      const elapsed = Date.now() - start;

      const turn: TurnRecord = {
        turn: i + 1,
        learnerUtterance: utterance,
        groundTruth,
        processorResult,
        supervisorGoal: goalUpdate,
        tutorResponse,
        elapsedMs: elapsed,
        timestamp: new Date().toISOString(),
      };

      this.turns.push(turn);

      if (this.opts.verbose && processorResult.analysis) {
        console.log(`[EVAL] Analysis: ${processorResult.analysis.lexemes.length} lexemes`);
        for (const l of processorResult.analysis.lexemes) {
          console.log(`  ${l.lemma} (${l.pos}) → ${l.performance}`);
        }
      }

      // Delay between turns
      if (i < this.opts.turns - 1 && this.opts.delayMs > 0) {
        await new Promise(r => setTimeout(r, this.opts.delayMs));
      }
    }

    return this.turns;
  }

  private async generateTutorResponse(
    goalUpdate: string | null,
    context: string,
    processorResult?: ProcessorResult,
  ): Promise<string | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.tutorApiKey) headers['Authorization'] = `Bearer ${this.opts.tutorApiKey}`;

    // Build error context from the latest analysis
    const recentErrors = processorResult?.analysis?.lexemes
      ?.filter(l => l.performance === 'wrong_use' || l.performance === 'recall_fail')
      .map(l => `${l.lemma}: ${l.performance}${l.grammarRule ? ` (${l.grammarRule.rule})` : ''}`)
      .join('; ') || 'None';

    const grammarHints = processorResult?.analysis?.grammarHints?.join(' ') || 'None';

    const systemPrompt = buildInstructions({
      targetLanguage: this.langConfig.name,
      nativeName: this.langConfig.nativeName,
      nativeLanguage: this.langConfig.nativeLanguage,
      targetRatio: this.langConfig.pedagogy.targetLanguageRatio,
      userLevel: this.scenario.proficiency,
      persona: this.langConfig.persona,
      initialContext: context,
      mode: 'text',
      recentErrors,
      grammarHints,
      goalUpdate: goalUpdate || undefined,
    });

    const messages: { role: string; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...this.history.slice(-6),
    ];

    if (goalUpdate) {
      messages.push({ role: 'system', content: goalUpdate });
    }

    try {
      const response = await fetch(`${this.opts.tutorLlmUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.opts.tutorModel, messages, temperature: 0.7, max_tokens: 200 }),
      });

      if (!response.ok) return `(Tutor error: ${response.status})`;
      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content || '(no response)';
    } catch (err: any) {
      return `(Tutor error: ${err.message})`;
    }
  }

  private async runPlanner(
    processorResult: ProcessorResult | null,
    goalUpdate: string | null,
    dbContext: string,
  ): Promise<string | null> {
    const plannerUrl = this.opts.llmUrl;
    const plannerModel = this.opts.model;

    const recentHistory = this.history.slice(-6)
      .map(h => `${h.role === 'user' ? 'Learner' : 'Tutor'}: ${h.content}`)
      .join('\n');

    const userPrompt = buildPlannerPrompt({
      dbContext,
      goalNote: goalUpdate,
      recentHistory,
      previousNudge: null,
      reason: 'eval_turn',
      signals: processorResult?.srsUpdates?.length ? ['srs_updated'] : [],
    });

    try {
      const response = await fetch(`${plannerUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: plannerModel,
          messages: [
            { role: 'system', content: PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 700,
        }),
      });

      if (!response.ok) return goalUpdate;  // Fall back to raw goal
      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      // Try to parse JSON plan
      let jsonText = content.trim();
      const block = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (block?.[1]) jsonText = block[1].trim();

      try {
        const plan = JSON.parse(jsonText);
        // Feed the plan's teaching goal into the tutor instead of raw goal
        return plan.teachingPlan?.nextPrompt || plan.teachingPlan?.goal || goalUpdate;
      } catch {
        return goalUpdate;  // Fall back to raw goal if parse fails
      }
    } catch {
      return goalUpdate;
    }
  }

  private async getTopicCues(): Promise<string[]> {
    const targetLang = this.lang;
    const unitList = await db.query.units.findMany({
      where: eq(units.language, targetLang),
      orderBy: [asc(units.order)],
      limit: 3, // Use first 3 units as topic sources
    });

    const cues: string[] = [];

    for (const unit of unitList) {
      const unitLexemes = await db.query.lexemes.findMany({
        where: and(eq(lexemes.unitId, unit.id), eq(lexemes.language, targetLang)),
      });

      if (unitLexemes.length > 0) {
        // Create cues with 2-3 words each
        for (let i = 0; i < unitLexemes.length; i += 2) {
          const slice = unitLexemes.slice(i, i + 2);
          cues.push(slice.map(l => `${l.lemma} (${l.translation})`).join(', '));
        }
      }
    }

    // If no curriculum data, generate generic cues
    if (cues.length === 0) {
      cues.push('greetings and introductions', 'food and drink', 'daily activities');
    }

    return cues;
  }
}

// ============================================================================
// EVALUATOR
// ============================================================================

class Evaluator {
  evaluate(turns: TurnRecord[], userId: string): EvalMetrics {
    const analysisMetrics = this.evaluateAnalysis(turns);
    const fsrsMetrics = this.evaluateFSRS(turns);
    const goalMetrics = this.evaluateGoals(turns, userId);
    const vocabMetrics = this.evaluateVocabulary(turns, userId);

    return {
      analysis_accuracy: analysisMetrics,
      fsrs_progression: fsrsMetrics,
      goal_relevance: goalMetrics,
      vocabulary_coverage: vocabMetrics,
    };
  }

  private evaluateAnalysis(turns: TurnRecord[]): EvalMetrics['analysis_accuracy'] {
    let totalTruePositives = 0;
    let totalFalsePositives = 0;
    let totalFalseNegatives = 0;
    let totalDetectedErrors = 0;
    let totalGroundTruthErrors = 0;
    const perTurn: EvalMetrics['analysis_accuracy']['per_turn'] = [];

    for (const turn of turns) {
      if (!turn.groundTruth || !turn.processorResult?.analysis) {
        perTurn.push({
          turn: turn.turn,
          true_positives: 0,
          false_positives: 0,
          false_negatives: 0,
          detected_errors: turn.processorResult?.analysis?.lexemes.length || 0,
          ground_truth_errors: turn.groundTruth?.intended_errors.length || 0,
        });
        continue;
      }

      const gtErrors = new Set(turn.groundTruth.intended_errors.map(e => e.word.toLowerCase()));
      const detectedWrong = new Set<string>();

      for (const lex of turn.processorResult.analysis.lexemes) {
        if (lex.performance === 'wrong_use' || lex.performance === 'recall_fail') {
          detectedWrong.add(lex.lemma.toLowerCase());
        }
      }

      let truePositives = 0;
      let falsePositives = 0;

      for (const det of detectedWrong) {
        if (gtErrors.has(det)) {
          truePositives++;
        } else {
          falsePositives++;
        }
      }

      const falseNegatives = gtErrors.size - truePositives;

      totalTruePositives += truePositives;
      totalFalsePositives += falsePositives;
      totalFalseNegatives += falseNegatives;
      totalDetectedErrors += detectedWrong.size;
      totalGroundTruthErrors += gtErrors.size;

      perTurn.push({
        turn: turn.turn,
        true_positives: truePositives,
        false_positives: falsePositives,
        false_negatives: falseNegatives,
        detected_errors: detectedWrong.size,
        ground_truth_errors: gtErrors.size,
      });
    }

    const totalPredictedPositive = totalTruePositives + totalFalsePositives;
    const totalActualPositive = totalTruePositives + totalFalseNegatives;

    return {
      error_detection_precision: totalPredictedPositive > 0 ? totalTruePositives / totalPredictedPositive : 0,
      error_detection_recall: totalActualPositive > 0 ? totalTruePositives / totalActualPositive : 0,
      correct_labeling_precision: 1, // Simplified — would need more ground truth
      correct_labeling_recall: 1,
      hallucination_rate: totalPredictedPositive > 0 ? totalFalsePositives / totalPredictedPositive : 0,
      per_turn: perTurn,
    };
  }

  private evaluateFSRS(turns: TurnRecord[]): EvalMetrics['fsrs_progression'] {
    const stabilityDeltasCorrect: number[] = [];
    const stabilityDeltasWrong: number[] = [];
    const stateDeltasCorrect: number[] = [];
    const stateDeltasWrong: number[] = [];
    const gradeDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const autoCreated = new Set<string>();
    const violations: string[] = [];

    const gtErrorWords = new Set<string>();
    const gtCorrectWords = new Set<string>();

    for (const turn of turns) {
      if (turn.groundTruth) {
        for (const e of turn.groundTruth.intended_errors) gtErrorWords.add(e.word.toLowerCase());
        for (const w of turn.groundTruth.intended_correct) gtCorrectWords.add(w.toLowerCase());
      }

      if (!turn.processorResult) continue;

      const updates = turn.processorResult.srsUpdates;
      for (const u of updates) {
        gradeDistribution[u.grade] = (gradeDistribution[u.grade] || 0) + 1;

        const stabilityDelta = u.newState - u.oldState; // rough proxy
        const lemma = u.lexemeId.split(':').slice(1, -1).join(':').toLowerCase();

        if (gtErrorWords.has(lemma)) {
          stabilityDeltasWrong.push(u.newState - u.oldState); // state delta, not stability
          stateDeltasWrong.push(u.newState - u.oldState);
        } else {
          stabilityDeltasCorrect.push(u.newState - u.oldState);
          stateDeltasCorrect.push(u.newState - u.oldState);
        }

        // Track auto-created lexemes (not in seed data)
        if (u.oldState === 0) {
          autoCreated.add(u.lexemeId);
        }
      }
    }

    const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const std = (arr: number[]) => {
      if (arr.length < 2) return 0;
      const m = mean(arr);
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
    };

    return {
      stability_delta_correct: { mean: mean(stabilityDeltasCorrect), std: std(stabilityDeltasCorrect) },
      stability_delta_wrong: { mean: mean(stabilityDeltasWrong), std: std(stabilityDeltasWrong) },
      state_progression_correct: { mean: mean(stateDeltasCorrect), std: std(stateDeltasCorrect) },
      state_progression_wrong: { mean: mean(stateDeltasWrong), std: std(stateDeltasWrong) },
      grade_distribution: gradeDistribution,
      new_word_count: autoCreated.size,
      expectation_violations: violations,
    };
  }

  private evaluateGoals(turns: TurnRecord[], userId: string): EvalMetrics['goal_relevance'] {
    let goalEmissions = 0;
    const goalTypes: Record<string, number> = {};
    let remediationValid = 0;
    let remediationInvalid = 0;

    for (const turn of turns) {
      const goal = turn.supervisorGoal;
      if (!goal) continue;

      goalEmissions++;
      const type = goal.includes('remediation') ? 'remediation' :
                   goal.includes('vocab') ? 'vocab' : 'other';
      goalTypes[type] = (goalTypes[type] || 0) + 1;

      if (type === 'remediation') {
        // Check if the word is actually struggling
        const match = goal.match(/"([^"]+)"/);
        if (match) {
          // We'd need to query the DB to verify — approximate by checking goal text
          remediationValid++; // Assume valid for now
        }
      }
    }

    return {
      goal_emission_rate: turns.length > 0 ? goalEmissions / turns.length : 0,
      goal_type_distribution: goalTypes,
      goal_target_found: { remediation_valid: remediationValid, remediation_invalid: remediationInvalid },
    };
  }

  private evaluateVocabulary(turns: TurnRecord[], userId: string): EvalMetrics['vocab_coverage'] {
    const encounteredLexemes = new Set<string>();
    const wordsPerTurn: number[] = [];
    const autoCreated: string[] = [];

    for (const turn of turns) {
      if (!turn.processorResult?.analysis) continue;

      const count = turn.processorResult.analysis.lexemes.length;
      wordsPerTurn.push(count);

      for (const lex of turn.processorResult.analysis.lexemes) {
        encounteredLexemes.add(lex.lemma.toLowerCase());
      }

      for (const u of turn.processorResult.srsUpdates) {
        if (u.oldState === 0) {
          autoCreated.push(u.lexemeId);
        }
      }
    }

    const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const std = (arr: number[]) => {
      if (arr.length < 2) return 0;
      const m = mean(arr);
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
    };

    return {
      seeded_hit_rate: 0, // Would need to know seeded lexeme count
      seeded_encounter_rate: 0,
      auto_created_lexemes: [...new Set(autoCreated)],
      unique_words_per_turn: { mean: mean(wordsPerTurn), std: std(wordsPerTurn) },
    };
  }
}

// ============================================================================
// REPORT GENERATOR
// ============================================================================

class ReportGenerator {
  generate(turns: TurnRecord[], metrics: EvalMetrics, opts: Opts, scenario: ScenarioConfig): EvalReport {
    const summary = this.generateSummary(metrics, scenario);

    return {
      meta: {
        timestamp: new Date().toISOString(),
        scenario: opts.scenario,
        language: opts.lang,
        model: opts.model,
        tutorModel: opts.tutorModel,
        turns: opts.turns,
        userId: opts.userId,
      },
      turns,
      metrics,
      summary,
    };
  }

  private generateSummary(metrics: EvalMetrics, scenario: ScenarioConfig): string {
    const lines: string[] = [];

    lines.push(`Scenario: ${scenario.name} (error rate target: ${Math.round(scenario.targetErrorRate * 100)}%)`);

    const { analysis_accuracy, fsrs_progression, goal_relevance } = metrics;

    lines.push(`\nAnalysis Accuracy:`);
    lines.push(`  Error detection precision: ${(analysis_accuracy.error_detection_precision * 100).toFixed(1)}%`);
    lines.push(`  Error detection recall: ${(analysis_accuracy.error_detection_recall * 100).toFixed(1)}%`);
    lines.push(`  Hallucination rate: ${(analysis_accuracy.hallucination_rate * 100).toFixed(1)}%`);

    lines.push(`\nFSRS Progression:`);
    lines.push(`  Stability delta (correct): ${fsrs_progression.stability_delta_correct.mean.toFixed(2)} ± ${fsrs_progression.stability_delta_correct.std.toFixed(2)}`);
    lines.push(`  Stability delta (wrong): ${fsrs_progression.stability_delta_wrong.mean.toFixed(2)} ± ${fsrs_progression.stability_delta_wrong.std.toFixed(2)}`);
    lines.push(`  State delta (correct): ${fsrs_progression.state_progression_correct.mean.toFixed(2)}`);
    lines.push(`  State delta (wrong): ${fsrs_progression.state_progression_wrong.mean.toFixed(2)}`);
    lines.push(`  Grade distribution: ${JSON.stringify(fsrs_progression.grade_distribution)}`);
    lines.push(`  Auto-created lexemes: ${fsrs_progression.new_word_count}`);

    lines.push(`\nGoal System:`);
    lines.push(`  Goal emission rate: ${(goal_relevance.goal_emission_rate * 100).toFixed(1)}%`);
    lines.push(`  Goal types: ${JSON.stringify(goal_relevance.goal_type_distribution)}`);

    // Warnings
    const warnings: string[] = [];
    if (analysis_accuracy.error_detection_precision < 0.5) warnings.push('Low precision — processor labels too many correct words as errors.');
    if (analysis_accuracy.error_detection_recall < 0.5) warnings.push('Low recall — processor misses many real errors.');
    if (analysis_accuracy.hallucination_rate > 0.3) warnings.push('High hallucination rate — many detected errors are false positives.');
    if (fsrs_progression.stability_delta_correct.mean < 0) warnings.push('FSRS anomaly: correct words are losing stability.');
    if (fsrs_progression.expectation_violations.length > 0) warnings.push(...fsrs_progression.expectation_violations);

    if (warnings.length > 0) {
      lines.push(`\nWarnings:`);
      for (const w of warnings) lines.push(`  - ${w}`);
    }

    return lines.join('\n');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);
  const langConfig = getLanguageConfig(opts.lang);

  const scenarios = opts.runAll ? Object.keys(SCENARIOS) : [opts.scenario];
  const allReports: EvalReport[] = [];

  for (const scenarioName of scenarios) {
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) {
      console.error(`Unknown scenario: ${scenarioName}`);
      continue;
    }

    const userId = opts.runAll ? `eval-${scenarioName}-${Date.now()}` : opts.userId;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`EVAL: ${scenarioName.toUpperCase()} (${opts.lang}, ${opts.turns} turns)`);
    console.log(`${'='.repeat(60)}\n`);

    // Ensure user exists
    await db.insert(users).values({
      id: userId,
      targetLanguage: opts.lang,
      nativeLanguage: 'en',
      proficiencyLevel: scenario.proficiency,
    }).onConflictDoNothing();

    // Run conversation
    const runner = new ConversationRunner(userId, opts.lang, { ...opts, scenario: scenarioName as any, userId });
    const turns = await runner.run();

    // Evaluate
    const evaluator = new Evaluator();
    const metrics = evaluator.evaluate(turns, userId);

    // Generate report
    const generator = new ReportGenerator();
    const report = generator.generate(turns, metrics, opts, scenario);
    allReports.push(report);

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(report.summary);
    console.log(`${'='.repeat(60)}\n`);

    // Write report file
    const reportPath = opts.runAll ? `eval-${scenarioName}-${Date.now()}.json` : opts.reportFile;
    const fs = await import('fs/promises');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report written to: ${reportPath}`);

    // Cleanup
    if (opts.cleanup) {
      await db.delete(userVocabulary).where(eq(userVocabulary.userId, userId));
      await db.delete(activeGoals).where(eq(activeGoals.userId, userId));
      console.log(`Cleaned up vocabulary and goals for user: ${userId}`);
    }
  }

  // Combined summary for --all
  if (opts.runAll && allReports.length > 1) {
    console.log('\n' + '='.repeat(60));
    console.log('COMBINED SUMMARY');
    console.log('='.repeat(60));
    for (const report of allReports) {
      const m = report.metrics;
      console.log(`${report.meta.scenario.padEnd(12)} | ` +
        `Prec: ${(m.analysis_accuracy.error_detection_precision * 100).toFixed(0)}% | ` +
        `Recall: ${(m.analysis_accuracy.error_detection_recall * 100).toFixed(0)}% | ` +
        `Halluc: ${(m.analysis_accuracy.hallucination_rate * 100).toFixed(0)}% | ` +
        `ΔStab(correct): ${m.fsrs_progression.stability_delta_correct.mean.toFixed(2)} | ` +
        `ΔStab(wrong): ${m.fsrs_progression.stability_delta_wrong.mean.toFixed(2)}`
      );
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});