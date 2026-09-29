// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getLanguageConfig } from '../../config/languages.js';
import {
  DEFAULT_MODEL_GUIDANCE,
  type PromptContext,
  buildInstructions,
} from '../../config/prompts/base.js';
import { resolveVoice } from '../../config/voices.js';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { ServiceFactory } from '../../services/factory.js';
import { getGoogleKeyPlan, recordGoogleUsage } from '../google-budget.js';
import { buildPersonaBlock, readPersona } from '../persona.js';
import { resolveProviders } from '../provider-config.js';
import { type AlignmentReport, runAlignment } from './alignment.js';
import { profileIdentity, resolveConversationRoute, validateGuidance } from './profile.js';
import { createDialogue } from './provider.js';
import { profileHistory, readProfile, saveProfile } from './store.js';

const active = new Map<string, AbortController>();
const contextHash = (context: PromptContext) =>
  createHash('sha256').update(JSON.stringify(context)).digest('hex');

async function settings(userId: string, language: unknown, mode: unknown) {
  if (
    typeof language !== 'string' ||
    !/^[a-z]{2,3}$/.test(language) ||
    !['cloud', 'local'].includes(String(mode))
  )
    throw new Error('Invalid language or mode');
  if (mode === 'local' && process.env.ALLOW_LOCAL_MODE !== 'true')
    throw new Error('Local mode disabled');
  const lang = getLanguageConfig(language);
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error('Account unavailable');
  const providers = await resolveProviders(userId);
  const google = await getGoogleKeyPlan(userId);
  const factory = new ServiceFactory({
    mode: mode === 'local' ? 'local-gemma-audio' : 'gemini',
    targetLanguage: language,
    providers: providers ?? undefined,
    googleApiKey: google.apiKey ?? undefined,
  });
  const route = resolveConversationRoute(factory.getMode(), providers, google.apiKey ?? undefined);
  const identity = profileIdentity(route, language);
  const persona = await readPersona(userId, language);
  const context: PromptContext = {
    targetLanguage: lang.name,
    nativeLanguage: getLanguageConfig(user.nativeLanguage || 'en').name,
    userLevel: 'A1',
    persona: buildPersonaBlock(persona),
    realtime: route.transport === 'google-live',
    specialInstructions: lang.pedagogy.specialInstructions,
    frontier: { state: 'balance', directive: '', dueWords: '', newWords: '' },
  };
  return {
    route,
    identity,
    context,
    persona,
    google,
    profile: await readProfile(userId, identity.key),
  };
}
export async function interruptAlignmentJobs() {
  await db.execute(sql`UPDATE model_alignment_jobs SET status='interrupted', updated_at=now()
    WHERE status IN ('running','queued')`);
}
async function getJob(owner: string, id: string) {
  const rows = await db.execute(
    sql`SELECT id,profile_key AS "profileKey",status,report,created_at AS "createdAt" FROM model_alignment_jobs WHERE user_id=${owner} AND id=${id}`,
  );
  return rows[0] as
    | { id: string; profileKey: string; status: string; report: Record<string, any> }
    | undefined;
}

export function createModelPromptRouter(): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    next();
  });
  router.get('/', async (req, res) => {
    try {
      const s = await settings(req.user!.id, req.query.language, req.query.mode || 'cloud');
      const jobs = await db.execute(
        sql`SELECT id,status,created_at AS "createdAt" FROM model_alignment_jobs WHERE user_id=${req.user!.id} AND profile_key=${s.identity.key} ORDER BY created_at DESC LIMIT 5`,
      );
      res.json({
        identity: s.identity,
        profile: s.profile,
        defaultGuidance: DEFAULT_MODEL_GUIDANCE,
        history: await profileHistory(req.user!.id, s.identity.key),
        jobs,
        preview: buildInstructions({
          ...s.context,
          modelGuidance: s.profile.guidance ?? undefined,
        }),
        previewNotice:
          'Effective stable prompt for an A1 screening context. Live level, vocabulary, session history and tools are added by the session; these are not sent to calibration.',
        activation: 'next-session',
        calibrationModality:
          s.route.transport === 'google-live'
            ? 'text-in / realtime audio-out'
            : 'text-in / text-out',
        canAlign:
          s.route.transport !== 'unsupported' &&
          !(s.route.transport === 'google-live' && s.google.overBudget),
      });
    } catch {
      res.status(400).json({ error: 'Cannot resolve this language/model configuration' });
    }
  });
  router.put('/', async (req, res) => {
    try {
      const s = await settings(req.user!.id, req.body.language, req.body.mode || 'cloud');
      if (req.body.profileKey !== s.identity.key || !Number.isInteger(req.body.revision))
        return res.status(409).json({ error: 'Model configuration changed; reload' });
      const guidance = req.body.reset === true ? null : validateGuidance(req.body.guidance);
      res.json(await saveProfile(req.user!.id, s.identity.key, guidance, req.body.revision));
    } catch (error) {
      res
        .status(String(error).includes('changed') ? 409 : 400)
        .json({
          error: String(error).includes('changed')
            ? 'Profile changed; reload'
            : 'Invalid model guidance (maximum 2000 characters)',
        });
    }
  });
  router.post('/align', async (req, res) => {
    const owner = req.user!.id;
    try {
      if (req.body.confirmCost !== true)
        return res.status(400).json({ error: 'Confirm provider usage first' });
      const s = await settings(owner, req.body.language, req.body.mode || 'cloud');
      if (req.body.profileKey !== s.identity.key || req.body.revision !== s.profile.revision)
        return res
          .status(409)
          .json({ error: 'Provider or profile changed; reload before aligning' });
      if (s.route.transport === 'unsupported')
        return res.status(400).json({ error: 'Calibration not supported for this transport' });
      if (s.route.transport === 'google-live' && s.google.overBudget)
        return res.status(402).json({ error: 'Google budget exhausted' });
      const id = randomUUID();
      const report = {
        identity: s.identity,
        baselineRevision: s.profile.revision,
        contextHash: contextHash(s.context),
        language: req.body.language,
        mode: req.body.mode || 'cloud',
        completed: 0,
        total: 12,
        modality:
          s.route.transport === 'google-live'
            ? 'text-in / realtime audio-out (not a microphone test)'
            : 'text-in / text-out (not a voice test)',
        requestLimits: {
          maxTokens: 512,
          maxTurnMs: 45000,
          maxJobMs: 600000,
          trialCount: 12,
          turnCount: 25,
        },
        result: null as AlignmentReport | null,
      };
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${owner}),hashtext('alignment-job'))`,
        );
        const recent = await tx.execute(
          sql`SELECT count(*)::int AS count FROM model_alignment_jobs WHERE user_id=${owner} AND created_at>now()-interval '24 hours'`,
        );
        if (Number(recent[0]?.count) >= 3) throw new Error('Daily alignment limit');
        await tx.execute(
          sql`INSERT INTO model_alignment_jobs(id,user_id,profile_key,status,report) VALUES (${id},${owner},${s.identity.key},'running',${JSON.stringify(report)}::jsonb)`,
        );
      });
      const controller = new AbortController();
      active.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 600000);
      const started = Date.now();
      const persist = async (result: AlignmentReport, status = 'running') => {
        report.result = result;
        report.completed = result.trials.length;
        await db.execute(
          sql`UPDATE model_alignment_jobs SET report=${JSON.stringify(report)}::jsonb,status=${status},updated_at=now() WHERE id=${id} AND user_id=${owner} AND status='running'`,
        );
      };
      void runAlignment(
        s.context,
        s.profile.guidance ?? DEFAULT_MODEL_GUIDANCE,
        createDialogue(s.route, resolveVoice(s.persona.voice)),
        controller.signal,
        (result) => persist(result),
      )
        .then((result) => persist(result, 'review'))
        .catch(async () => {
          await db.execute(
            sql`UPDATE model_alignment_jobs SET status=${controller.signal.aborted ? 'cancelled' : 'failed'},updated_at=now() WHERE id=${id} AND user_id=${owner} AND status='running'`,
          );
        })
        .finally(async () => {
          clearTimeout(timeout);
          active.delete(id);
          if (s.route.transport === 'google-live' && s.google.useShared)
            await recordGoogleUsage(
              owner,
              Math.ceil((Date.now() - started) / 1000) *
                Number(process.env.GOOGLE_REALTIME_MICROS_PER_SECOND || 350),
            );
        })
        .catch(() => console.error('[Alignment] Failed to persist job status/billing'));
      res.status(202).json({ id, status: 'running' });
    } catch {
      res
        .status(409)
        .json({
          error:
            'Could not start alignment: another run is active, the daily limit was reached, or the provider configuration is unavailable',
        });
    }
  });
  router.get('/jobs/:id', async (req, res) => {
    try {
      const job = await getJob(req.user!.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'Run not found' });
      res.json(job);
    } catch {
      res.status(503).json({ error: 'Run temporarily unavailable' });
    }
  });
  router.post('/jobs/:id/cancel', async (req, res) => {
    try {
      const job = await getJob(req.user!.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'Run not found' });
      await db.execute(
        sql`UPDATE model_alignment_jobs SET status='cancelled',updated_at=now() WHERE user_id=${req.user!.id} AND id=${job.id} AND status='running'`,
      );
      active.get(job.id)?.abort();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: 'Could not cancel run' });
    }
  });
  router.post('/jobs/:id/apply', async (req, res) => {
    try {
      const job = await getJob(req.user!.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'Run not found' });
      if (job.status !== 'review' || req.body.reviewed !== true)
        return res.status(400).json({ error: 'Review a completed comparison first' });
      const report = job.report;
      const s = await settings(req.user!.id, report.language, report.mode);
      if (s.identity.key !== job.profileKey || contextHash(s.context) !== report.contextHash)
        return res
          .status(409)
          .json({ error: 'Provider or preferences changed; realign before applying' });
      const candidate = (report.result as AlignmentReport).candidates.find(
        (c) => c.id === req.body.candidate,
      );
      if (!candidate) return res.status(400).json({ error: 'Unknown candidate' });
      res.json(
        await saveProfile(
          req.user!.id,
          job.profileKey,
          candidate.guidance,
          report.baselineRevision,
          job.id,
        ),
      );
    } catch {
      res
        .status(409)
        .json({ error: 'Profile changed or result unavailable; reload before applying' });
    }
  });
  return router;
}
