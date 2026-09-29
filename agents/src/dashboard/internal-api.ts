/**
 * Internal service-to-service API — the agentic layer over HTTP.
 *
 * Exists so a non-Node voice pipeline (the Pipecat service in `voice-py/`,
 * see PIPECAT_MIGRATION.md) can drive the Processor, the Supervisor and the
 * cross-session ContextManager without re-implementing any of them. The
 * prompt-tuned logic in `tools/supervisor-functions.ts` and `lib/context.ts`
 * is the product; it stays in TypeScript and is reached over the wire.
 *
 * These are THIN TRANSPORT WRAPPERS. No business logic belongs in this file.
 * If you find yourself computing something here, it belongs in the module
 * being wrapped.
 *
 * Two deliberate constraints:
 *
 *  1. Mounted at `/internal`, NOT `/api`. `server.ts` has a blanket
 *     `app.use('/api', requireAuth)` built around browser session cookies;
 *     a service caller has no cookie, and widening that middleware to
 *     understand service tokens would put a second auth path on every
 *     existing user-facing route. Separate prefix, separate middleware.
 *
 *  2. Nothing here imports `@livekit/agents`. `tools/db-tools.ts`,
 *     `tools/supervisor.ts` and `tools/content-tools.ts` each import `llm`
 *     from the SDK at module top, so importing their query helpers would
 *     pull the whole agents framework into the dashboard process. The
 *     Processor/Supervisor/Context core below is SDK-free, so the dashboard
 *     stays as light as it is today. The DB tools' queries were since split
 *     into `tools/db-queries.ts`, which carries no SDK import, so the tool
 *     passthroughs below use that rather than the llm.tool() shells.
 */

import express from 'express';
import crypto from 'node:crypto';

import { runProcessor, runSupervisor } from '../tools/supervisor-functions.js';
import { ContextManager } from '../lib/context.js';
import {
  lookupLexemeWithFSRSQuery,
  getDueReviewsQuery,
  getVocabularyOverviewQuery,
  getSemanticNeighborsQuery,
  getActiveGoalsQuery,
} from '../tools/db-queries.js';

// ============================================================================
// AUTH
// ============================================================================

/**
 * Constant-time compare that does not leak length. `timingSafeEqual` throws
 * on differing buffer lengths, and catching that throw would itself be a
 * length oracle, so both sides are hashed to a fixed width first.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLoopback(req: express.Request): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

/**
 * Fails closed. If INTERNAL_SERVICE_TOKEN is unset the whole router is
 * disabled rather than open — an unconfigured deployment must not silently
 * expose the agentic layer, which can write FSRS state for any user id.
 */
export function requireServiceToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Internal API disabled: INTERNAL_SERVICE_TOKEN is not set' });
    return;
  }

  // Loopback-only by default. The voice service is expected to run beside
  // the dashboard (same host, or same pod with a shared loopback). Opt out
  // explicitly when that stops being true, so exposing it is a decision
  // someone made rather than a default they inherited.
  if (!isLoopback(req) && process.env.INTERNAL_API_ALLOW_REMOTE !== 'true') {
    res.status(403).json({ error: 'Internal API is loopback-only' });
    return;
  }

  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !safeEqual(presented, expected)) {
    res.status(401).json({ error: 'Invalid or missing service token' });
    return;
  }

  next();
}

// ============================================================================
// HELPERS
// ============================================================================

/** Wraps an async handler so a rejected promise becomes a 500, not a hang. */
function handle(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[internal-api] ${req.method} ${req.originalUrl} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: message });
    });
  };
}

/** Reads a required non-empty string field, or throws a 400-shaped error. */
class BadRequest extends Error {}

function requireString(body: any, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`Field "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalString(body: any, field: string): string | undefined {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequest(`Field "${field}" must be a string`);
  return value;
}

/** Reads a query-string value, optionally requiring it. */
function queryString(req: express.Request, name: string, required = false): string | undefined {
  const raw = req.query[name];
  const value = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  if (required && value === undefined) {
    throw new BadRequest(`Query parameter "${name}" is required`);
  }
  return value;
}

/** Reads a positive integer query param, falling back to a default. */
function queryInt(req: express.Request, name: string, fallback: number): number {
  const raw = queryString(req, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequest(`Query parameter "${name}" must be a positive integer`);
  }
  return parsed;
}

/**
 * This project's Express types widen `req.params.x` to
 * `string | string[] | undefined`, so a route param needs narrowing before
 * it can be passed to anything expecting a plain id.
 */
function pathParam(req: express.Request, name: string): string {
  const raw = (req.params as Record<string, unknown>)[name];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BadRequest(`Path parameter "${name}" is required`);
  }
  return raw;
}

/**
 * JSON has no Date. writeSessionSummary takes real Dates and inserts them
 * straight into Postgres, so an ISO string would reach the driver as a
 * string and fail (or worse, coerce oddly) — parse and validate at the edge.
 */
function requireDate(body: any, field: string): Date {
  const raw = body?.[field];
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new BadRequest(`Field "${field}" must be an ISO date string`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequest(`Field "${field}" is not a valid date: ${String(raw)}`);
  }
  return parsed;
}

// ============================================================================
// ROUTER
// ============================================================================

export function createInternalRouter(): express.Router {
  const router = express.Router();

  router.use(requireServiceToken);

  // Request logging. Without it there is no way to tell "the model never
  // called the tool" from "the tool returned nothing" — during the first live
  // session both looked identical from outside, because express logs nothing
  // by default and the answer to "did it call get_due_reviews?" was
  // unknowable. Terse by design: one line, no bodies, no user data.
  router.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(
        `[internal] ${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${Date.now() - started}ms)`,
      );
    });
    next();
  });

  // Turns a BadRequest thrown inside a handler into a clean 400.
  const guard = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
    handle(async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof BadRequest) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    });

  /** Liveness + "is my token right", so a caller can verify wiring cheaply. */
  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'linglang-internal', version: 1 });
  });

  // --------------------------------------------------------------------------
  // Processor / Supervisor
  // --------------------------------------------------------------------------

  /**
   * The Processor: reads an utterance and writes vocabulary/FSRS state.
   * `options` is forwarded verbatim — every field on it (useGemini, llmUrl,
   * llmModel, llmKey, recentHistory, historyMessages, the lexeme ceiling)
   * encodes tuned behavior, so this must not filter or defaults-fill them.
   */
  router.post(
    '/processor',
    guard(async (req, res) => {
      const userId = requireString(req.body, 'userId');
      const utterance = requireString(req.body, 'utterance');
      const context = optionalString(req.body, 'context') ?? '';
      const options = req.body?.options ?? {};
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new BadRequest('Field "options" must be an object');
      }
      const result = await runProcessor(userId, utterance, context, options);
      res.json(result);
    }),
  );

  /** The Supervisor: cross-session planning / goal-seeking. */
  router.post(
    '/supervisor',
    guard(async (req, res) => {
      const userId = requireString(req.body, 'userId');
      const utterance = requireString(req.body, 'utterance');
      const context = optionalString(req.body, 'context') ?? '';
      const options = req.body?.options ?? {};
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new BadRequest('Field "options" must be an object');
      }
      const result = await runSupervisor(userId, utterance, context, options);
      res.json(result);
    }),
  );

  // --------------------------------------------------------------------------
  // ContextManager
  // --------------------------------------------------------------------------

  /**
   * The session-open context bundle. `tutor-event-driven.ts` fetches these
   * together at session start (see its Promise.all around line 1462), so
   * serving them in one round trip keeps the voice service's cold start from
   * paying four sequential hops.
   *
   * `languageCode` is required for the summary halves: summaries are
   * language-scoped, and omitting the scope is what produced a Portuguese
   * goal surfacing inside a Russian session (see the 2026-07-02 note in
   * lib/context.ts).
   */
  router.get(
    '/context/:userId',
    guard(async (req, res) => {
      const userId = pathParam(req, 'userId');
      const languageCode = typeof req.query.languageCode === 'string' ? req.query.languageCode : null;

      const [initial, notes] = await Promise.all([
        ContextManager.getInitialContext(userId),
        ContextManager.getNotesContext(userId),
      ]);

      let summaries: string | null = null;
      let recent: unknown[] = [];
      if (languageCode) {
        const recentLimit = Number.parseInt(String(req.query.recentLimit ?? '1'), 10);
        [summaries, recent] = await Promise.all([
          ContextManager.getSummariesContext(userId, languageCode),
          ContextManager.getRecentSummaries(
            userId,
            languageCode,
            Number.isFinite(recentLimit) ? recentLimit : 1,
          ),
        ]);
      }

      res.json({ initial, notes, summaries, recent, languageCode });
    }),
  );

  /** The learner's current dynamic goal, or null. */
  router.get(
    '/context/:userId/goal',
    guard(async (req, res) => {
      const goal = await ContextManager.getDynamicGoal(pathParam(req, 'userId'));
      res.json({ goal });
    }),
  );

  router.get(
    '/context/:userId/notes',
    guard(async (req, res) => {
      const notes = await ContextManager.getUserNotes(pathParam(req, 'userId'));
      res.json({ notes });
    }),
  );

  router.post(
    '/context/:userId/note',
    guard(async (req, res) => {
      const category = requireString(req.body, 'category');
      const content = requireString(req.body, 'content');
      const source = optionalString(req.body, 'source') ?? 'observed';
      const id = await ContextManager.writeNote(pathParam(req, 'userId'), category, content, source);
      res.json({ id });
    }),
  );

  /**
   * Goal update. `recentAnalysis` is optional — ContextManager.updateGoals
   * has a meaningful no-argument behavior (re-scoring existing goals), so an
   * absent body is a valid call, not a malformed one.
   */
  router.post(
    '/context/:userId/goals',
    guard(async (req, res) => {
      const recentAnalysis = req.body?.recentAnalysis ?? undefined;
      const note = await ContextManager.updateGoals(pathParam(req, 'userId'), recentAnalysis);
      res.json({ note });
    }),
  );

  /** End-of-session write. Dates arrive as ISO strings and are parsed here. */
  router.post(
    '/session-summary',
    guard(async (req, res) => {
      const userId = requireString(req.body, 'userId');
      const durationMinutes = Number(req.body?.durationMinutes);
      if (!Number.isFinite(durationMinutes)) {
        throw new BadRequest('Field "durationMinutes" must be a number');
      }
      const id = await ContextManager.writeSessionSummary(userId, {
        languageCode: requireString(req.body, 'languageCode'),
        startedAt: requireDate(req.body, 'startedAt'),
        endedAt: requireDate(req.body, 'endedAt'),
        durationMinutes,
        topicsCovered: optionalString(req.body, 'topicsCovered') ?? null,
        wordsWorked: optionalString(req.body, 'wordsWorked') ?? null,
        errorsPattern: optionalString(req.body, 'errorsPattern') ?? null,
        summary: requireString(req.body, 'summary'),
        nextSessionHint: optionalString(req.body, 'nextSessionHint') ?? null,
      });
      res.json({ id });
    }),
  );

  // --------------------------------------------------------------------------
  // DB tool passthroughs
  // --------------------------------------------------------------------------
  //
  // These mirror the llm.tool() registrations in tools/db-tools.ts, but call
  // the underlying queries in tools/db-queries.ts directly. Two reasons: the
  // tool shells expect a LiveKit run context (they read userId out of
  // `opts.ctx.userData`), and importing them would drag @livekit/agents into
  // this process. Same queries, same results, no SDK.
  //
  // GET, not POST: every one of these is a read. A voice service can cache
  // and retry them freely.

  router.get(
    '/tools/lexeme',
    guard(async (req, res) => {
      const lemma = queryString(req, 'lemma', true)!;
      const language = queryString(req, 'language', true)!;
      const userId = queryString(req, 'userId', true)!;
      const result = await lookupLexemeWithFSRSQuery(lemma, language, userId);
      // Mirrors the tool's own contract: absence is a normal answer, not a 404.
      res.json(result ? { found: true, ...result } : { found: false, lemma });
    }),
  );

  router.get(
    '/tools/due-reviews',
    guard(async (req, res) => {
      const userId = queryString(req, 'userId', true)!;
      const reviews = await getDueReviewsQuery(userId, queryInt(req, 'limit', 10));
      res.json({ count: reviews.length, reviews });
    }),
  );

  router.get(
    '/tools/vocab-overview',
    guard(async (req, res) => {
      res.json(await getVocabularyOverviewQuery(queryString(req, 'userId', true)!));
    }),
  );

  router.get(
    '/tools/semantic-neighbors',
    guard(async (req, res) => {
      const lemma = queryString(req, 'lemma', true)!;
      const language = queryString(req, 'language', true)!;
      const neighbors = await getSemanticNeighborsQuery(lemma, language, queryInt(req, 'limit', 5));
      res.json({ neighbors });
    }),
  );

  router.get(
    '/tools/active-goals',
    guard(async (req, res) => {
      res.json(await getActiveGoalsQuery(queryString(req, 'userId', true)!));
    }),
  );

  return router;
}
