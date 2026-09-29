/**
 * LingLang Dashboard Server
 *
 * Simple web dashboard to:
 * - View user progress (SRS levels)
 * - Monitor active goals
 * - View real-time session stats
 */
import { JobStatus } from '@livekit/protocol';
import { execFileSync } from 'child_process';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import express from 'express';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../config/languages.js';
import { db } from '../db/index.js';
import {
  activeGoals,
  contentChunks,
  contentSources,
  lexemes,
  reviewLogs,
  sessionSummaries,
  units,
  userContentProgress,
  userLanguageLevels,
  userPersona,
  userSourceProfiles,
  userVocabulary,
  users,
} from '../db/schema.js';
import {
  type ContentIntent,
  type ProfileAnswers,
  evaluateProfile,
  inferSource,
  questionsFor,
  resolveLastStudiedAt,
} from '../lib/content-profile.js';
import { applyProfileAnswers, onSourceReady } from '../lib/content-reconcile.js';
import { notifyNewSignup } from '../lib/admin-notifications.js';
import { activateChunk, listSourceChunks, placeUserInSource } from '../lib/curriculum.js';
import { DashboardSessions } from '../lib/dashboard-sessions.js';
import { createEvidenceRouter } from '../lib/evidence/api.js';
import { createConversationRouter } from '../lib/conversation-api.js';
import { clearGoogleApiKey, getGoogleKeyPlan, setGoogleApiKey } from '../lib/google-budget.js';
import { type ContentKind, ingestSource } from '../lib/ingest.js';
import { isSupportedTargetLanguage } from '../lib/language-selection.js';
import { readLearnerView } from '../lib/learner-view.js';
import { writePersona, readPersona } from '../lib/persona.js';
import { PERSONA_FIELDS, validatePersonaPatch } from '../lib/persona-policy.js';
import { invalidateLearnerView } from '../lib/learner-view.js';
import { createModelPromptRouter, interruptAlignmentJobs } from '../lib/model-prompts/api.js';
import { createConversationArchive } from '../lib/conversation-store.js';
import type { StudyIntensity } from '../lib/prior-knowledge.js';
import {
  deleteProviderKey,
  getDecryptedKey,
  getProviders,
  listProviderKeyNames,
  putProviderKey,
  resolveProviders,
  sanitizeProviders,
  setProviders,
} from '../lib/provider-config.js';
import { probeAll } from '../lib/provider-probe.js';
import { installProviderPolicyRoutes } from './provider-policy-routes.js';
import { type AgentEvent, watchEvents } from '../lib/trace.js';
import { authenticateByUsername, claimUser, createUser, hashPassword } from '../lib/user-auth.js';
import { mountPipecatRuntime } from './pipecat-runtime.js';
import { createInternalRouter } from './internal-api.js';
import { bucketVocabHistory, computeStreak } from './stats.js';

dotenv.config({ path: '.env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');

app.use(express.json());

// Cross-origin readiness (Capacitor wraps the same web build in an iOS/
// Android shell served from `capacitor://localhost`/`https://localhost`, a
// different origin than this server — always cross-origin, dev or prod).
// Both knobs below default OFF, so today's same-origin dev/PWA deployment
// is byte-for-byte unchanged unless explicitly opted in when a Capacitor
// build actually exists to test against.
//   CORS_ALLOWED_ORIGINS: comma-separated allow-list (e.g.
//     "capacitor://localhost,https://localhost,https://app.linglang.app").
//     Credentialed CORS can't use "*", hence an explicit list.
//   CROSS_ORIGIN_COOKIES=true: flips the session cookie from
//     SameSite=Strict to SameSite=None; Secure — required for the cookie to
//     ride along on a cross-origin request at all. Secure means it only
//     works over HTTPS (or the mobile WebView's equivalent), so don't set
//     this for plain-HTTP local dev.
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (corsAllowedOrigins.length > 0) {
  app.use(
    cors({
      origin: corsAllowedOrigins,
      credentials: true,
    }),
  );
  console.log(
    `[CORS] Allowing credentialed cross-origin requests from: ${corsAllowedOrigins.join(', ')}`,
  );
}

const crossOriginCookies = process.env.CROSS_ORIGIN_COOKIES === 'true';
function sessionCookieAttrs(req: express.Request): string {
  const behindProxy = req.headers['x-forwarded-proto'] === 'https';
  const secure = crossOriginCookies || behindProxy || process.env.NODE_ENV === 'production';
  const sameSite = crossOriginCookies ? 'None' : 'Strict';
  return `SameSite=${sameSite}${secure ? '; Secure' : ''}`;
}

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ============================================================================
// INTERNAL SERVICE API
// ============================================================================

// Mounted at /internal, deliberately NOT under /api: the blanket
// `app.use('/api', requireAuth)` further down is browser-session auth, and a
// service caller has no cookie. This router carries its own shared-secret
// middleware and is loopback-only by default. It fails closed — with
// INTERNAL_SERVICE_TOKEN unset every route returns 503, so an unconfigured
// deployment exposes nothing. See internal-api.ts.
mountPipecatRuntime(app, requireAuth, (query) => db.execute(query), async (userId, requested) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.targetLanguage || (requested !== undefined && requested !== user.targetLanguage)) {
    throw new Error('Voice session must use the authenticated learner target language');
  }
  return user.targetLanguage;
});
app.use('/internal', createInternalRouter());

// ============================================================================
// AUTHENTICATION
// ============================================================================

// Revocable sessions survive deployments; only token digests are stored in PostgreSQL.
const sessions = new DashboardSessions((query) => db.execute(query));

// Rate limiting for login attempts (per IP)
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const LOGIN_RATE_LIMIT = 10; // max attempts
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000; // per 15 minutes

// Scrypt-based password hashing (Node built-in, no deps) — 2026-06-25:
// moved to lib/user-auth.ts so the lib can be unit-tested and reused. The
// hash/verify helpers are imported at the top. We only keep the rate
// limit + session map here.

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.split('=');
    if (name && rest.length) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  }
  return cookies;
}

// Auth middleware — protects dashboard and API routes
async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['ll_session'];
  let session: { userId: string } | null = null;
  try {
    session = sessionId ? await sessions.get(sessionId) : null;
  } catch {
    // Fail closed, but don't mislabel a database outage as an expired login.
    res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again.' });
    return;
  }

  if (!session) {
    // Expired or missing session
    // req.path, not req.originalUrl: when this runs as the blanket
    // `app.use('/api', requireAuth)` mount, Express strips the mount
    // prefix from req.path (it'd be '/content-sources', not
    // '/api/content-sources') — that check always failed for any route
    // relying on the blanket rather than its own inline `requireAuth`,
    // silently sending an HTML redirect instead of 401 JSON to every
    // fetch() caller whose session had expired. originalUrl is never
    // rewritten by mount-path stripping, so it's the one that's actually
    // stable regardless of which requireAuth call site is running.
    if (req.originalUrl.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required' });
    } else {
      res.redirect('/login');
    }
    return;
  }

  req.user = { id: session.userId };
  next();
}

// Rate limit check for login endpoint
function checkLoginRateLimit(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  // Reset window if expired
  if (Date.now() - entry.lastAttempt > LOGIN_RATE_WINDOW_MS) {
    loginAttempts.delete(ip);
    return true;
  }
  return entry.count < LOGIN_RATE_LIMIT;
}

function recordLoginAttempt(ip: string, success: boolean): void {
  const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count = success ? 0 : entry.count + 1;
  entry.lastAttempt = Date.now();
  loginAttempts.set(ip, entry);
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
    }
  }
}

// Serve static files LAST so API routes take precedence
// app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// AUTH ROUTES (unprotected)
// ============================================================================

// 2026-07-16: serve the same React SPA bundle as /dashboard, not the old
// static login.html — the SPA's own App.tsx (useAuth()) already renders a
// LoginScreen/SignupScreen when unauthenticated, now rebuilt on HeroUI.
// Keeping this as a distinct route (rather than merging into '/') means
// requireAuth's existing non-API redirect target ('/login') still works
// unchanged for expired/missing sessions.
app.get('/login', (_req, res) => {
  const appPath = path.join(__dirname, 'public', 'app', 'index.html');
  if (fs.existsSync(appPath)) {
    res.sendFile(appPath);
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';

    // Rate limit check
    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // 2026-06-25: per-user auth via lib/user-auth.ts. The username is
    // matched case-insensitively, so "will" / "Will" / "WILL" all work.
    const user = await authenticateByUsername(username, password);
    if (!user) {
      recordLoginAttempt(clientIp, false);
      // Constant-time delay to slow down brute force
      await new Promise((r) => setTimeout(r, 500));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    recordLoginAttempt(clientIp, true);

    // Create session
    const sessionId = await sessions.create(user.id);

    // Set cookie — always use Secure when behind nginx (x-forwarded-proto)
    res.setHeader(
      'Set-Cookie',
      `ll_session=${sessionId}; HttpOnly; ${sessionCookieAttrs(req)}; Path=/; Max-Age=86400`,
    );

    console.log(`[Auth] User "${user.username}" (${user.id}) logged in from ${clientIp}`);
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// 2026-06-25: admin-only endpoint to create a new user. Currently `will`
// is hardcoded as admin — replace with a real role system later.
app.post('/api/register', requireAuth, async (req, res) => {
  try {
    if (req.user?.id !== 'will') {
      return res.status(403).json({ error: 'Only admin can register new users' });
    }
    const { username, password, targetLanguage, nativeLanguage } = req.body ?? {};
    if (targetLanguage !== undefined && !isSupportedTargetLanguage(targetLanguage)) {
      return res.status(400).json({ error: 'Unsupported target language' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    if (typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'password must be at least 4 characters' });
    }

    // Derive a URL-safe id from the username. Falls back to a random suffix
    // if the result is empty (e.g. username is all non-alphanumerics).
    const idBase = String(username)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const id = idBase || `user_${Date.now().toString(36)}`;

    const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (existing) {
      return res.status(409).json({ error: `User "${id}" already exists` });
    }

    await createUser({
      id,
      username: String(username),
      password: String(password),
      targetLanguage: targetLanguage || null,
      nativeLanguage: nativeLanguage || 'en',
    });

    void notifyNewSignup({
      kind: 'admin registration',
      id,
      username: String(username),
      targetLanguage: targetLanguage || null,
      nativeLanguage: nativeLanguage || 'en',
    });

    console.log(
      `[Auth] Admin ${req.user.id} created user ${id} (${username}) target=${targetLanguage || 'unset'}`,
    );
    res.json({ success: true, user: { id, username } });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// 2026-07-16: public self-serve signup — /api/register above stays
// admin-gated for manual/scripted account creation, this is the new path
// for users creating their own accounts. Reuses the login rate limiter
// (same IP-keyed map/window) since it's the same abuse surface. On
// success, logs the new user straight in (same cookie logic as
// /api/login) so signup lands directly in the app, no separate login step.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/signup', async (req, res) => {
  try {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';

    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }

    const { username, email, password, targetLanguage, nativeLanguage } = req.body ?? {};
    if (targetLanguage !== undefined && !isSupportedTargetLanguage(targetLanguage)) {
      return res.status(400).json({ error: 'Unsupported target language' });
    }
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password are required' });
    }
    if (typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'password must be at least 4 characters' });
    }
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      recordLoginAttempt(clientIp, false);
      return res.status(400).json({ error: 'a valid email is required' });
    }

    const idBase = String(username)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const id = idBase || `user_${Date.now().toString(36)}`;

    const existingId = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (existingId) {
      recordLoginAttempt(clientIp, false);
      return res.status(409).json({ error: `Username "${username}" is already taken` });
    }
    const existingEmail = await db.query.users.findFirst({
      where: sql`LOWER(${users.email}) = LOWER(${email})`,
    });
    if (existingEmail) {
      recordLoginAttempt(clientIp, false);
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    await createUser({
      id,
      username: String(username),
      email: String(email),
      password: String(password),
      targetLanguage: targetLanguage || null,
      nativeLanguage: nativeLanguage || 'en',
    });

    void notifyNewSignup({
      kind: 'self-serve signup',
      id,
      username: String(username),
      email: String(email),
      targetLanguage: targetLanguage || null,
      nativeLanguage: nativeLanguage || 'en',
    });

    recordLoginAttempt(clientIp, true);

    // Log the new user straight in — same session/cookie mechanics as /api/login.
    const sessionId = await sessions.create(id);
    res.setHeader(
      'Set-Cookie',
      `ll_session=${sessionId}; HttpOnly; ${sessionCookieAttrs(req)}; Path=/; Max-Age=86400`,
    );

    console.log(`[Auth] New self-serve signup: "${username}" (${id}) from ${clientIp}`);
    res.json({ success: true, user: { id, username } });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// 2026-07-23: claim-on-signup for the anonymous marketing-site demo (see
// ROADMAP.md in the LingLang.app repo). A demo session runs through the
// tutor agent with a synthetic `demo-<uuid>` users.id and no credentials —
// this attaches a real username/email/password to that SAME row instead of
// minting a new one, so all the FK'd data from the demo session (vocab,
// session summaries, memory graph) stays attached with no migration step.
// Deliberately its own endpoint rather than an optional field on
// /api/signup: the semantics are different enough (UPDATE vs INSERT, and
// the demoUserId must actually look like one of ours) to want a distinct,
// narrowly-scoped code path rather than branching logic inside signup.
app.post('/api/demo/claim', async (req, res) => {
  try {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';

    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }

    const { demoUserId, username, email, password } = req.body ?? {};
    if (!demoUserId || typeof demoUserId !== 'string' || !demoUserId.startsWith('demo-')) {
      return res.status(400).json({ error: 'Invalid demo session' });
    }
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password are required' });
    }
    if (typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'password must be at least 4 characters' });
    }
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      recordLoginAttempt(clientIp, false);
      return res.status(400).json({ error: 'a valid email is required' });
    }

    const demoRow = await db.query.users.findFirst({ where: eq(users.id, demoUserId) });
    if (!demoRow) {
      recordLoginAttempt(clientIp, false);
      return res.status(404).json({ error: 'Demo session not found or already expired' });
    }
    if (demoRow.username) {
      recordLoginAttempt(clientIp, false);
      return res.status(409).json({ error: 'This demo session has already been claimed' });
    }

    const usernameNorm = String(username).toLowerCase().trim();
    const existingUsername = await db.query.users.findFirst({
      where: sql`LOWER(${users.username}) = ${usernameNorm}`,
    });
    if (existingUsername) {
      recordLoginAttempt(clientIp, false);
      return res.status(409).json({ error: `Username "${username}" is already taken` });
    }
    const existingEmail = await db.query.users.findFirst({
      where: sql`LOWER(${users.email}) = LOWER(${email})`,
    });
    if (existingEmail) {
      recordLoginAttempt(clientIp, false);
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const claimed = await claimUser({
      id: demoUserId,
      username: String(username),
      email: String(email),
      password: String(password),
    });
    if (!claimed) {
      // Lost a race with another claim attempt on the same row between the
      // check above and the update's WHERE guard.
      recordLoginAttempt(clientIp, false);
      return res.status(409).json({ error: 'This demo session has already been claimed' });
    }

    void notifyNewSignup({
      kind: 'demo claim',
      id: demoUserId,
      username: String(username),
      email: String(email),
      targetLanguage: demoRow.targetLanguage,
      nativeLanguage: demoRow.nativeLanguage,
    });

    recordLoginAttempt(clientIp, true);

    const sessionId = await sessions.create(demoUserId);
    res.setHeader(
      'Set-Cookie',
      `ll_session=${sessionId}; HttpOnly; ${sessionCookieAttrs(req)}; Path=/; Max-Age=86400`,
    );

    console.log(`[Auth] Demo session claimed: "${username}" (${demoUserId}) from ${clientIp}`);
    res.json({ success: true, user: { id: demoUserId, username } });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['ll_session'];
  try {
    if (sessionId) await sessions.revoke(sessionId);
  } catch {
    return res.status(503).json({ error: 'Could not sign out. Please try again.' });
  }

  res.setHeader(
    'Set-Cookie',
    `ll_session=; HttpOnly; ${sessionCookieAttrs(req)}; Path=/; Max-Age=0`,
  );
  res.json({ success: true });
});

// Serve per-turn mic audio dumps for in-chat playback (2026-07-11) — lets
// the user hear exactly what the model heard, to tell transcription errors
// (model issue) apart from garbled capture (audio issue). Files are written
// by GemmaAudioSTT when LINGLANG_DUMP_AUDIO is set; named <iso-ts>_<key>.wav.
// Key is the audio id from user.transcript events. Strict [A-Za-z0-9] key
// match — no path traversal surface.
const AUDIO_DUMP_DIR =
  process.env.LINGLANG_DUMP_AUDIO && process.env.LINGLANG_DUMP_AUDIO !== '1'
    ? process.env.LINGLANG_DUMP_AUDIO
    : '/tmp/linglang-audio-dumps';
// Admin-only: dumped WAVs carry no per-user ownership metadata (audioId is
// generated in GemmaAudioSTT with no user context available at that scope),
// so any authenticated user could otherwise enumerate/brute-force another
// user's key (Date.now().toString(36) + counter — not cryptographically
// random) and listen to their raw voice recordings. This is a maintainer
// debugging tool (see DUMP_AUDIO's doc comment), not a user-facing feature,
// so restricting it to admin closes that cross-user exposure without
// needing to thread userId through the STT layer for an opt-in debug flag.
app.get('/api/audio-dumps/:key', requireAuth, (req, res) => {
  if (req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
  const key = String(req.params.key || '');
  if (!/^[A-Za-z0-9]{4,32}$/.test(key)) {
    return res.status(400).json({ error: 'bad key' });
  }
  let match: string | undefined;
  try {
    match = fs.readdirSync(AUDIO_DUMP_DIR).find((f) => f.endsWith(`_${key}.wav`));
  } catch {
    return res.status(404).json({ error: 'dumps unavailable' });
  }
  if (!match) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(AUDIO_DUMP_DIR, match));
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const userRow = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    const googlePlan = await getGoogleKeyPlan(req.user!.id);
    res.json({
      user: {
        id: req.user!.id,
        username: userRow?.username ?? req.user!.id,
        email: userRow?.email ?? null,
        targetLanguage: userRow?.targetLanguage ?? null,
        nativeLanguage: userRow?.nativeLanguage ?? 'en',
        proficiencyLevel: userRow?.proficiencyLevel ?? 'beginner',
        createdAt: userRow?.createdAt ?? null,
        hasGoogleApiKey: !!userRow?.googleApiKeyEncrypted,
        googleUsageMicros: googlePlan.useShared ? googlePlan.spentMicros : 0,
        googleUsageLimitMicros: googlePlan.useShared ? googlePlan.limitMicros : null,
      },
      // 2026-09-02: capabilities the UI adapts to. Local mode is off on
      // shared deployments (it burns the operator's GPU); self-hosters
      // flip ALLOW_LOCAL_MODE=true and the picker reappears.
      capabilities: {
        allowLocalMode: process.env.ALLOW_LOCAL_MODE === 'true',
      },
    });
  } catch {
    res.json({ user: req.user });
  }
});

// ============================================================================
// WAITLIST (public — no auth required, used by landing page)
// ============================================================================

app.post('/api/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const fsPromises = await import('node:fs/promises');
    const waitlistPath = path.join(__dirname, '..', '..', 'data', 'waitlist.txt');
    await fsPromises.mkdir(path.dirname(waitlistPath), { recursive: true });
    await fsPromises.appendFile(waitlistPath, `${new Date().toISOString()},${email}\n`);
    console.log(`[Waitlist] ${email}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// PROTECTED API ENDPOINTS
// ============================================================================

// Protect all /api/ routes below this point
app.use('/api', requireAuth);
// Evidence reads derive their owner from authentication, never a URL user ID.
app.use('/api/learning-evidence', createEvidenceRouter());
app.use('/api/conversations', createConversationRouter());
app.use('/api/model-prompts', createModelPromptRouter());

// Get all users — 2026-06-25: per-user data isolation. Non-admin users
// only see their own row.
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    if (req.user!.id === 'will') {
      const allUsers = await db.query.users.findMany({
        orderBy: [desc(users.createdAt)],
      });
      return res.json(allUsers);
    }
    const me = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    res.json(me ? [me] : []);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get user details — 2026-06-25: ownership check. Non-admin can only
// access their own row.
app.get('/api/users/:userId', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get progress stats
    const progress = await db.query.userVocabulary.findMany({
      where: eq(userVocabulary.userId, userId),
      with: { lexeme: true },
    });

    // Get active goals
    const goals = await db.query.activeGoals.findMany({
      where: eq(activeGoals.userId, userId),
      orderBy: [desc(activeGoals.createdAt)],
    });

    // Calculate stats using FSRS state distribution
    const stateDistribution = {
      new: 0,
      learning: 0,
      review: 0,
      relearning: 0,
    };

    for (const p of progress) {
      switch (p.state) {
        case 0:
          stateDistribution.new++;
          break;
        case 1:
          stateDistribution.learning++;
          break;
        case 2:
          stateDistribution.review++;
          break;
        case 3:
          stateDistribution.relearning++;
          break;
      }
    }

    // Strip sensitive columns — passwordHash and the encrypted Google key
    // were previously returned verbatim in `user`. Surface Google-key
    // status/usage as plain booleans/numbers instead of the raw column.
    const {
      passwordHash: _passwordHash,
      googleApiKeyEncrypted,
      googleUsageMicros,
      googleUsageLimitMicros,
      ...safeUser
    } = user;
    const googlePlan = await getGoogleKeyPlan(userId as string);

    res.json({
      user: {
        ...safeUser,
        hasGoogleApiKey: !!googleApiKeyEncrypted,
        googleUsageMicros: googlePlan.useShared ? googlePlan.spentMicros : 0,
        googleUsageLimitMicros: googlePlan.useShared ? googlePlan.limitMicros : null,
      },
      progress,
      goals,
      stats: {
        totalVocab: progress.length,
        stateDistribution,
        activeGoals: goals.filter((g) => g.status === 'active').length,
        completedGoals: goals.filter((g) => g.status === 'completed').length,
      },
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Save/clear a user's own Google API key (BYO — unlimited use of Cloud
// mode, no draw against the shared-key budget). Never echoed back; GET
// /api/users/:userId only exposes a hasGoogleApiKey boolean.
installProviderPolicyRoutes(app, requireAuth);

app.put('/api/users/:userId/google-key', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { apiKey } = req.body ?? {};
    if (typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'apiKey looks too short to be valid' });
    }
    await setGoogleApiKey(userId as string, apiKey.trim());
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.delete('/api/users/:userId/google-key', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await clearGoogleApiKey(userId as string);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// BYO SPEECH-STACK PROVIDERS (2026-09-02) — see lib/provider-config.ts
// Same auth shape as /google-key: own-user or admin. Config (baseURLs,
// model names, key *names*) is safe to GET; key material never leaves the
// server.
// ============================================================================

function ownsOrAdmin(req: any, userId: string): boolean {
  return req.user!.id === userId || req.user!.id === 'will';
}

app.get('/api/users/:userId/providers', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    if (!ownsOrAdmin(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    const providers = await getProviders(userId);
    const keyNames = await listProviderKeyNames(userId as string);
    res.json({ providers: providers ?? null, keyNames });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.put('/api/users/:userId/providers', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    if (!ownsOrAdmin(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    let sanitized;
    try {
      sanitized = sanitizeProviders(req.body?.providers);
    } catch (validationErr) {
      return res.status(400).json({ error: String((validationErr as Error).message) });
    }
    // Referential check: a keyRef pointing at a nonexistent vault key is
    // almost certainly a UI bug or a deleted key — refuse the save rather
    // than silently running keyless at session start.
    const keyNames = new Set(await listProviderKeyNames(userId as string));
    for (const comp of ['stt', 'llm', 'tts'] as const) {
      const ref = sanitized[comp]?.keyRef;
      if (ref && !keyNames.has(ref.toLowerCase())) {
        return res.status(400).json({ error: `${comp}.keyRef '${ref}' not found in your keys` });
      }
    }
    await setProviders(userId, sanitized);
    res.json({ success: true, providers: sanitized });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.put('/api/users/:userId/provider-keys/:keyName', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    const keyName = req.params.keyName as string;
    if (!ownsOrAdmin(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    const { apiKey } = req.body ?? {};
    if (typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'apiKey looks too short to be valid' });
    }
    await putProviderKey(userId, keyName, apiKey.trim());
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.delete('/api/users/:userId/provider-keys/:keyName', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    const keyName = req.params.keyName as string;
    if (!ownsOrAdmin(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    await deleteProviderKey(userId, keyName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Latency/streaming probe for BYO endpoints (lib/provider-probe.ts).
// Body: { providers?: <draft> } — probes the draft if given (test before
// you save), else the stored config. Keys resolve server-side from the
// vault by keyRef, so the client can never point this at an arbitrary
// URL with an arbitrary key. 20s per-user cooldown: the probe fetches
// user-supplied URLs from the server, and while that reach already
// exists via real sessions, a button people can hammer needs a brake.
const probeCooldown = new Map<string, number>();
app.post('/api/users/:userId/providers/probe', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    if (!ownsOrAdmin(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    const last = probeCooldown.get(userId) ?? 0;
    if (Date.now() - last < 20_000) {
      return res
        .status(429)
        .json({ error: `probe again in ${Math.ceil((20_000 - (Date.now() - last)) / 1000)}s` });
    }
    probeCooldown.set(userId, Date.now());

    let providersToProbe;
    if (req.body?.providers !== undefined) {
      try {
        providersToProbe = sanitizeProviders(req.body.providers);
      } catch (validationErr) {
        return res.status(400).json({ error: String((validationErr as Error).message) });
      }
    } else {
      providersToProbe = (await getProviders(userId)) ?? undefined;
    }
    if (
      !providersToProbe ||
      (!providersToProbe.stt && !providersToProbe.llm && !providersToProbe.tts)
    ) {
      return res.status(400).json({ error: 'nothing configured to probe' });
    }
    // Decrypt keyRefs for the draft exactly like dispatch does.
    const resolved = await resolveProviders(userId, providersToProbe);
    if (!resolved) return res.status(400).json({ error: 'nothing configured to probe' });
    const results = await probeAll(resolved);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Model auto-discovery for a BYO endpoint (2026-09-02): the UI asks
// "what models does this server actually have?" so the learner picks from
// a dropdown instead of typing a model name they got from a README.
// Body: { baseUrl, keyRef?, vendor? } — same SSRF posture as the probe
// (http(s) only, no embedded credentials; on a self-hosted box localhost
// is the point). Key resolves server-side from the vault; the client
// never sends one. OmniVoice has no /v1/models but does have /v1/voices,
// so vendor=omnivoice lists voices instead.
app.post('/api/users/:userId/providers/models', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    if (!ownsOrAdmin(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    const { baseUrl, keyRef, vendor } = req.body ?? {};
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      return res.status(400).json({ error: 'baseUrl required' });
    }
    let u: URL;
    try {
      u = new URL(baseUrl.trim());
    } catch {
      return res.status(400).json({ error: 'baseUrl is not a valid URL' });
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      return res.status(400).json({ error: 'baseUrl must be http(s) without credentials' });
    }
    let apiKey: string | undefined;
    if (typeof keyRef === 'string' && keyRef.trim()) {
      apiKey = (await getDecryptedKey(userId, keyRef.trim().toLowerCase())) ?? undefined;
    }
    const isOmni = vendor === 'omnivoice';
    const listUrl = isOmni
      ? new URL('/v1/voices', u).toString()
      : new URL(u.pathname.replace(/\/$/, '') + '/models', u).toString();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const r = await fetch(listUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      return res.status(502).json({ error: `${listUrl} -> HTTP ${r.status}` });
    }
    const body = await r.json().catch(() => null);
    let models: string[] = [];
    if (isOmni) {
      models = Array.isArray(body?.voices)
        ? body.voices
        : Array.isArray(body?.data)
          ? body.data.map((v: any) => (typeof v === 'string' ? v : v?.id)).filter(Boolean)
          : [];
    } else if (Array.isArray(body?.data)) {
      models = body.data.map((m: any) => m?.id).filter(Boolean);
    } else if (Array.isArray(body?.models)) {
      models = body.models
        .map((m: any) => (typeof m === 'string' ? m : (m?.id ?? m?.model)))
        .filter(Boolean);
    } else if (Array.isArray(body)) {
      models = body
        .map((m: any) => (typeof m === 'string' ? m : (m?.name ?? m?.model)))
        .filter(Boolean);
    }
    res.json({ models: [...new Set(models)].sort() });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get vocabulary with progress
app.get('/api/users/:userId/vocabulary', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { state, limit = '100' } = req.query;

    let progress = await db.query.userVocabulary.findMany({
      where: eq(userVocabulary.userId, userId),
      with: { lexeme: true },
      orderBy: [desc(userVocabulary.lastReview)],
      limit: parseInt(limit as string),
    });

    // Filter by FSRS state if specified
    if (state !== undefined) {
      progress = progress.filter((p) => p.state === parseInt(state as string));
    }

    res.json(progress);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get per-language proficiency levels
app.get('/api/users/:userId/language-levels', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const rows = await db.query.userLanguageLevels.findMany({
      where: eq(userLanguageLevels.userId, userId),
    });

    res.json(
      rows.map((r) => ({
        languageCode: r.languageCode,
        proficiencyLevel: r.proficiencyLevel,
        confidence: r.confidence,
        source: r.source,
      })),
    );
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Dashboard summary: streak, talk time, words due
app.get('/api/users/:userId/summary', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const reviewDateRows = await db
      .select({ reviewDate: reviewLogs.reviewDate })
      .from(reviewLogs)
      .where(eq(reviewLogs.userId, userId));
    const streak = computeStreak(reviewDateRows.map((r) => r.reviewDate));

    const talkTimeRows = await db
      .select({
        totalMinutes: sql<number>`coalesce(sum(${sessionSummaries.durationMinutes}), 0)`,
      })
      .from(sessionSummaries)
      .where(eq(sessionSummaries.userId, userId));
    const totalMinutes = Number(talkTimeRows[0]?.totalMinutes ?? 0);
    const talkTimeHours = Math.round((totalMinutes / 60) * 10) / 10;

    // Uses the user_vocabulary_due_idx (userId, due) composite index —
    // an equality match on userId plus a range match on due is exactly
    // what that index is built for.
    const wordsDueRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(userVocabulary)
      .where(and(eq(userVocabulary.userId, userId), lte(userVocabulary.due, new Date())));
    const wordsDue = Number(wordsDueRows[0]?.count ?? 0);

    res.json({ streak, talkTimeHours, wordsDue });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Weekly vocab-growth history for a stacked-area chart
app.get('/api/users/:userId/vocab-history', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const weeksParam = parseInt((req.query.weeks as string) || '12', 10);
    const weeks = Number.isFinite(weeksParam) && weeksParam > 0 ? weeksParam : 12;

    const logs = await db
      .select({
        userVocabularyId: reviewLogs.userVocabularyId,
        reviewDate: reviewLogs.reviewDate,
        state: reviewLogs.state,
      })
      .from(reviewLogs)
      .where(eq(reviewLogs.userId, userId));

    const result = bucketVocabHistory(logs, weeks);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// KNOWN WORDS — "what do I actually know?" view over the implicit SRS data.
// ============================================================================

// The proof that conversations are being indexed: every word the user has
// produced in a session lands in user_vocabulary (origin='conversation').
// Buckets map FSRS state -> learner-facing labels:
//   0 New        = heard/seen, never produced correctly yet
//   1 Learning   = starting to produce it, still effortful
//   2 Mastered   = FSRS review state, recall is stable
//   3 Relearning = was mastered, lapsed, being rebuilt
app.get('/api/users/:userId/known-words', requireAuth, async (req, res) => {
  try {
    const userId = req.params.userId as string;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const language = (req.query.language as string | undefined) || undefined;
    const search = ((req.query.search as string) || '').trim().toLowerCase();
    const limit = Math.min(
      500,
      Math.max(1, parseInt((req.query.limit as string) || '60', 10) || 60),
    );
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10) || 0);

    const vocabWhere = language
      ? and(eq(userVocabulary.userId, userId), eq(lexemes.language, language))
      : eq(userVocabulary.userId, userId);
    // Same predicate for queries that do NOT join lexemes (recency below):
    // constrain via a subquery instead of referencing lexemes.language.
    const vocabWhereNoJoin = language
      ? and(
          eq(userVocabulary.userId, userId),
          sql`${userVocabulary.lexemeId} in (select ${lexemes.id} from ${lexemes} where ${lexemes.language} = ${language})`,
        )
      : eq(userVocabulary.userId, userId);

    // Per-language state buckets in one grouped query.
    const bucketRows = await db
      .select({
        language: lexemes.language,
        state: userVocabulary.state,
        count: sql<number>`count(*)`,
      })
      .from(userVocabulary)
      .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
      .where(vocabWhere)
      .groupBy(lexemes.language, userVocabulary.state);

    // Recency: words first indexed in the last 7/30 days.
    // NOTE: postgres-js rejects Date objects inside raw `sql` fragments
    // ("string argument must be string|Buffer|ArrayBuffer") — pass ISO strings.
    const now = Date.now();
    const since7 = new Date(now - 7 * 86_400_000).toISOString();
    const since30 = new Date(now - 30 * 86_400_000).toISOString();
    const recentRows = await db
      .select({
        week: sql<number>`count(*) filter (where ${userVocabulary.createdAt} >= ${since7})`,
        month: sql<number>`count(*) filter (where ${userVocabulary.createdAt} >= ${since30})`,
      })
      .from(userVocabulary)
      .where(vocabWhereNoJoin);

    const buckets: Record<
      string,
      { new: number; learning: number; mastered: number; relearning: number; total: number }
    > = {};
    for (const r of bucketRows) {
      const b = (buckets[r.language] ??= {
        new: 0,
        learning: 0,
        mastered: 0,
        relearning: 0,
        total: 0,
      });
      const key = (['new', 'learning', 'mastered', 'relearning'] as const)[r.state] ?? 'new';
      b[key] += Number(r.count);
      b.total += Number(r.count);
    }

    // The word list itself. Sort modes:
    //   lastUsed (default): most-recently-touched first (that's what makes
    //     "this session's words showed up" obvious)
    //   due: next review first — the SRS queue view.
    const sort = (req.query.sort as string | undefined) === 'due' ? 'due' : 'lastUsed';
    let rows = await db
      .select({
        lemma: lexemes.lemma,
        translation: lexemes.translation,
        pos: lexemes.pos,
        language: lexemes.language,
        state: userVocabulary.state,
        reps: userVocabulary.reps,
        lapses: userVocabulary.lapses,
        stability: userVocabulary.stability,
        receptiveExposures: userVocabulary.receptiveExposures,
        origin: userVocabulary.origin,
        lastReview: userVocabulary.lastReview,
        createdAt: userVocabulary.createdAt,
        due: userVocabulary.due,
      })
      .from(userVocabulary)
      .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
      .where(vocabWhere)
      .orderBy(
        ...(sort === 'due'
          ? [asc(userVocabulary.due)]
          : [desc(userVocabulary.lastReview), desc(userVocabulary.createdAt)]),
      )
      .limit(limit)
      .offset(offset);

    if (search) {
      rows = rows.filter(
        (r) =>
          r.lemma.toLowerCase().includes(search) || r.translation.toLowerCase().includes(search),
      );
    }

    const totals = Object.values(buckets).reduce(
      (acc, b) => ({
        new: acc.new + b.new,
        learning: acc.learning + b.learning,
        mastered: acc.mastered + b.mastered,
        relearning: acc.relearning + b.relearning,
        total: acc.total + b.total,
      }),
      { new: 0, learning: 0, mastered: 0, relearning: 0, total: 0 },
    );

    res.json({
      buckets,
      totals,
      recent: { week: Number(recentRows[0]?.week ?? 0), month: Number(recentRows[0]?.month ?? 0) },
      words: rows,
      limit,
      offset,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// LIBRARY (content-source catalog: Spotify-style tiles the user picks from)
// ============================================================================

// List sources visible to this user (their own uploads + shared/global,
// ownerId === null), annotated with per-user progress so the frontend can
// show a progress ring and highlight the currently-active tile.
app.get('/api/content-sources', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const sources = await db.query.contentSources.findMany({
      where: or(eq(contentSources.ownerId, userId), isNull(contentSources.ownerId)),
      orderBy: [desc(contentSources.createdAt)],
    });
    if (sources.length === 0) return res.json([]);

    const sourceIds = sources.map((s) => s.id);
    const chunkRows = await db
      .select({ id: contentChunks.id, sourceId: contentChunks.sourceId })
      .from(contentChunks)
      .where(inArray(contentChunks.sourceId, sourceIds));

    const chunkIdsBySource = new Map<string, string[]>();
    for (const c of chunkRows) {
      chunkIdsBySource.set(c.sourceId, [...(chunkIdsBySource.get(c.sourceId) ?? []), c.id]);
    }

    const allChunkIds = chunkRows.map((c) => c.id);
    const progressRows = allChunkIds.length
      ? await db.query.userContentProgress.findMany({
          where: and(
            eq(userContentProgress.userId, userId),
            inArray(userContentProgress.chunkId, allChunkIds),
          ),
        })
      : [];
    const progressByChunk = new Map(progressRows.map((p) => [p.chunkId, p]));

    // Provenance is per (user, source): the same shared source is at a
    // different point for every learner. A source with no profile row, or
    // one still 'needed', is what the library greys out.
    const profileRows = await db.query.userSourceProfiles.findMany({
      where: and(
        eq(userSourceProfiles.userId, userId),
        inArray(userSourceProfiles.sourceId, sourceIds),
      ),
    });
    const profileBySource = new Map(profileRows.map((p) => [p.sourceId, p]));

    const result = sources.map((s) => {
      const chunkIds = chunkIdsBySource.get(s.id) ?? [];
      let done = 0;
      let isActive = false;
      let started = false;
      for (const id of chunkIds) {
        const p = progressByChunk.get(id);
        if (!p) continue;
        started = true;
        if (p.status === 'done') done++;
        if (p.status === 'active') isActive = true;
      }
      const profile = profileBySource.get(s.id);
      const evaluation = profile
        ? evaluateProfile(s.kind as ContentKind, (profile.answers ?? {}) as ProfileAnswers)
        : null;

      return {
        id: s.id,
        language: s.language,
        kind: s.kind,
        title: s.title,
        status: s.status,
        ingestError: s.status === 'failed' ? s.ingestError : undefined,
        chunkCount: chunkIds.length,
        progress: chunkIds.length > 0 ? done / chunkIds.length : 0,
        isActive,
        started,
        intent: profile?.intent ?? null,
        profileStatus: profile?.status ?? 'needed',
        // The frontend's one flag for "grey this tile out and prompt": no
        // profile row at all, or one with required questions outstanding.
        // A 'skipped' profile is NOT pending — the learner declined, and
        // re-nagging them is how a gentle prompt becomes an annoying one.
        needsProfile: !profile || profile.status === 'needed',
        pendingQuestionCount: evaluation
          ? evaluation.missing.length
          : questionsFor(s.kind as ContentKind, null).length,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Create a new content source and kick off ingestion in the background.
// Responds as soon as the row exists so the frontend can poll
// GET /api/content-sources for status transitions (uploaded -> ingesting ->
// ready|failed) instead of blocking the request on the multi-minute
// distillation pipeline.
const INGEST_KINDS: ContentKind[] = ['text', 'textbook', 'audio', 'youtube', 'movie'];

app.post('/api/content-sources', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { language, title, ref } = req.body ?? {};
    let { kind } = req.body ?? {};

    if (!LANGUAGES[language]) {
      return res.status(400).json({ error: `Unknown language "${language}"` });
    }
    if (!ref?.trim()) {
      return res.status(400).json({ error: 'ref is required' });
    }

    // `kind` is now optional: the simple "just paste it" path sends only a
    // ref and lets inference decide (rules first, model only for bare
    // titles -- see lib/content-profile.ts). An explicit kind from the
    // advanced form still wins, and is still validated.
    let inferredTitle: string | undefined;
    if (kind === undefined || kind === null || kind === '') {
      const inferred = await inferSource(ref.trim(), title);
      kind = inferred.kind;
      inferredTitle = inferred.title;
    } else if (!INGEST_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${INGEST_KINDS.join(', ')}` });
    }

    const finalTitle = (title?.trim() || inferredTitle || ref.trim()).slice(0, 200);
    const sourceId = `src-${crypto.randomUUID().slice(0, 8)}`;

    // The profile row is created UP FRONT, unanswered. That's what puts the
    // source in the library greyed out with questions outstanding, rather
    // than blocking the upload behind a questionnaire -- see the module
    // comment in lib/content-profile.ts for why that ordering matters.
    // Answers may also arrive in this same request (the upload form asks
    // inline if the learner wants to bother); reconciliation then happens
    // as soon as ingestion finishes.
    const answers = (req.body?.answers ?? {}) as ProfileAnswers;
    if (req.body?.intent) answers.intent = req.body.intent as ContentIntent;
    const evaluation = evaluateProfile(kind as ContentKind, answers);

    await db
      .insert(userSourceProfiles)
      .values({
        userId,
        sourceId,
        intent: (answers.intent as ContentIntent) ?? 'study',
        status: evaluation.status,
        answers,
        lastStudiedAt: resolveLastStudiedAt(answers.last_studied),
        intensity: (answers.intensity as StudyIntensity) ?? null,
        profiledAt: evaluation.status === 'complete' ? new Date() : null,
      })
      .onConflictDoNothing();

    // Fire-and-forget: ingestSource manages its own status transitions
    // (inserts as 'ingesting', flips to 'ready'/'failed' on completion) and
    // already logs + records ingestError on failure, so nothing further to
    // await or handle here. onSourceReady runs afterwards to apply any
    // profile that completed while ingestion was still going.
    void ingestSource({
      sourceId,
      ownerId: userId,
      language,
      kind: kind as ContentKind,
      title: finalTitle,
      ref: ref.trim(),
    }).then(
      () => onSourceReady(sourceId),
      (err) => {
        console.error(`[Ingest] Background ingestion failed for ${sourceId}:`, err);
      },
    );

    res.status(202).json({
      id: sourceId,
      status: 'ingesting',
      kind,
      title: finalTitle,
      profileStatus: evaluation.status,
      needsProfile: evaluation.status !== 'complete',
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// What is this thing? Powers the dirt-simple add box: the learner pastes a
// URL, a filename or a title, and the form fills itself in. Separate from
// the POST above so the UI can show (and let them correct) the guess
// BEFORE committing to an ingest that may take minutes.
app.post('/api/content-sources/infer', requireAuth, async (req, res) => {
  try {
    const { ref } = req.body ?? {};
    if (!ref?.trim()) return res.status(400).json({ error: 'ref is required' });
    res.json(await inferSource(ref.trim()));
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// The profile for one source: current answers plus the questions still
// outstanding, in asking order. Both the library sheet and the voice agent
// read this -- one question list, so the typed and spoken flows can't drift.
app.get('/api/content-sources/:sourceId/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { sourceId } = req.params as { sourceId: string };
    const source = await db.query.contentSources.findFirst({
      where: eq(contentSources.id, sourceId),
    });
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (source.ownerId && source.ownerId !== userId)
      return res.status(403).json({ error: 'Forbidden' });

    const profile = await db.query.userSourceProfiles.findFirst({
      where: and(eq(userSourceProfiles.userId, userId), eq(userSourceProfiles.sourceId, sourceId)),
    });
    const answers = (profile?.answers ?? {}) as ProfileAnswers;
    const evaluation = evaluateProfile(source.kind as ContentKind, answers);
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentChunks)
      .where(eq(contentChunks.sourceId, sourceId));
    const chunkCount = countRows[0]?.count ?? 0;

    res.json({
      sourceId,
      title: source.title,
      kind: source.kind,
      chunkCount,
      intent: profile?.intent ?? null,
      status: profile?.status ?? 'needed',
      answers,
      reconciledAt: profile?.reconciledAt ?? null,
      questions: questionsFor(
        source.kind as ContentKind,
        (answers.intent as ContentIntent) ?? null,
      ),
      missing: evaluation.missing,
      next: evaluation.next,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Answer some or all of the questions. Partial answers are the normal case
// -- the voice flow lands one or two per turn -- so this merges rather than
// replaces, and only reconciles once nothing required is outstanding.
app.put('/api/content-sources/:sourceId/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { sourceId } = req.params as { sourceId: string };
    const source = await db.query.contentSources.findFirst({
      where: eq(contentSources.id, sourceId),
    });
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (source.ownerId && source.ownerId !== userId)
      return res.status(403).json({ error: 'Forbidden' });

    const incoming = (req.body?.answers ?? {}) as ProfileAnswers;
    if (req.body?.intent) incoming.intent = req.body.intent as ContentIntent;

    // Shared with the voice tools (tools/content-tools.ts) so the spoken
    // and typed flows converge on identical state. `skip` is the explicit
    // "don't ask me": reconcile on conservative defaults rather than
    // leaving the source inert forever.
    const result = await applyProfileAnswers(userId, sourceId, incoming, {
      skip: req.body?.skip === true,
    });

    // result.reconcileStarted is false when ingestion is still running --
    // onSourceReady picks the profile up when chunks exist.
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Select a source as the user's active reading — wraps placeUserInSource,
// which is idempotent (onConflictDoNothing per chunk) and auto-places the
// learner at the right chunk based on vocab coverage.
app.post('/api/content-sources/:sourceId/select', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { sourceId } = req.params;
    const source = await db.query.contentSources.findFirst({
      where: eq(contentSources.id, sourceId),
    });
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (source.ownerId && source.ownerId !== userId)
      return res.status(403).json({ error: 'Forbidden' });
    if (source.status !== 'ready')
      return res.status(400).json({ error: `Source is ${source.status}, not ready` });

    await placeUserInSource(userId, sourceId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Every chunk in a source, ordered, each with the learner's live vocab
// coverage and progress status — powers the chunk-browser sheet's "jump to
// any part" list. Coverage is computed for every chunk regardless of
// whether it's been visited (see curriculum.ts's listSourceChunks), so a
// learner can tell which parts they likely already know before jumping.
app.get('/api/content-sources/:sourceId/chunks', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { sourceId } = req.params as { sourceId: string };
    const source = await db.query.contentSources.findFirst({
      where: eq(contentSources.id, sourceId),
    });
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (source.ownerId && source.ownerId !== userId)
      return res.status(403).json({ error: 'Forbidden' });

    const chunks = await listSourceChunks(userId, sourceId);
    res.json(chunks);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Explicit "go here" — jump straight to one chunk, bypassing coverage-based
// auto-placement and the one-step-at-a-time skipActiveChunk path. Same
// trust-the-user precedent as the voice "let's move on" trigger.
app.post(
  '/api/content-sources/:sourceId/chunks/:chunkId/activate',
  requireAuth,
  async (req, res) => {
    try {
      const userId = req.user!.id;
      const { sourceId, chunkId } = req.params as { sourceId: string; chunkId: string };
      const source = await db.query.contentSources.findFirst({
        where: eq(contentSources.id, sourceId),
      });
      if (!source) return res.status(404).json({ error: 'Not found' });
      if (source.ownerId && source.ownerId !== userId)
        return res.status(403).json({ error: 'Forbidden' });

      const chunk = await db.query.contentChunks.findFirst({
        where: eq(contentChunks.id, chunkId),
      });
      if (!chunk || chunk.sourceId !== sourceId)
        return res.status(404).json({ error: 'Chunk not found in this source' });

      const result = await activateChunk(userId, chunkId);
      if (!result) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true, coverage: result.coverage });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  },
);

// The learner's current active content_chunks row (or null), for the Voice
// tab's curriculum pill/sheet — same data readLearnerView already computes
// for the prompt builder, so the UI can never show something out of sync
// with what the planner is actually using this turn.
app.get('/api/users/:userId/active-content', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { language } = req.query;
    if (!language || typeof language !== 'string') {
      return res.status(400).json({ error: 'language is required' });
    }

    const view = await readLearnerView(userId as string, language);
    res.json(view.activeChunk);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get curriculum units
app.get('/api/curriculum', async (req, res) => {
  try {
    const { language } = req.query;

    let allUnits;
    if (language) {
      allUnits = await db.query.units.findMany({
        where: eq(units.language, language as string),
        with: { lexemes: true },
      });
    } else {
      allUnits = await db.query.units.findMany({
        with: { lexemes: true },
      });
    }

    res.json(allUnits);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Database stats
// Admin-gated: runtime_state.json is a single shared file written by
// whichever job process last touched it (not per-user), so it can leak
// another user's live session debug state (transcript trace, nudges,
// subagent chats) to anyone who happens to hit this while a session is
// active. Also unused by the current frontend.
app.get('/api/runtime', async (req, res) => {
  try {
    if (req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
    // runtime_state.json is written by the LiveKit agent at agents/runtime_state.json
    const runtimePath = path.join(__dirname, '..', '..', 'runtime_state.json');
    if (!fs.existsSync(runtimePath)) {
      return res.json({ ok: false, error: 'runtime_state.json not found yet' });
    }
    const raw = fs.readFileSync(runtimePath, 'utf-8');
    return res.json({ ok: true, state: JSON.parse(raw) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

// Processor capability benchmark — Debug-only, synthetic diagnostics. The
// report contains no learner data; it is an index over the checked-in,
// versioned evidence-v2 fixtures. Match the current user's configured LLM
// without exposing provider keys or endpoint credentials.
app.get('/api/processor-benchmark', requireAuth, async (req, res) => {
  try {
    if (req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
    const reportCandidates = [
      path.join(__dirname, 'data', 'processor-model-benchmark.json'),
      path.join(__dirname, '..', 'data', 'processor-model-benchmark.json'),
      path.join(__dirname, '..', '..', 'data', 'processor-model-benchmark.json'),
      path.join(process.cwd(), 'data', 'processor-model-benchmark.json'),
    ];
    const reportPath = reportCandidates.find((candidate) => fs.existsSync(candidate));
    if (!reportPath) return res.status(404).json({ error: 'Processor benchmark report not found' });

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      schemaVersion?: string;
      benchmarkId?: string;
      generatedAt?: string;
      purpose?: string;
      selectionPolicy?: unknown;
      models?: Array<{ model?: string }>;
    };
    const providers = await getProviders(req.user!.id);
    const realtimeEnabled = providers?.realtime?.enabled === true;
    const configuredModel = realtimeEnabled
      ? process.env.CLOUD_PROCESSOR_LLM_MODEL ||
        process.env.PROCESSOR_LLM_MODEL ||
        process.env.LOCAL_LLM_MODEL ||
        null
      : providers?.llm?.model ||
        process.env.PROCESSOR_LLM_MODEL ||
        process.env.CLOUD_PROCESSOR_LLM_MODEL ||
        process.env.LOCAL_LLM_MODEL ||
        null;
    const normalized = configuredModel?.toLowerCase().trim();
    const match =
      report.models?.find((entry) => {
        const candidate = entry.model?.toLowerCase().trim();
        return (
          candidate === normalized ||
          (!!candidate && !!normalized && candidate.endsWith(`/${normalized}`))
        );
      }) ?? null;
    return res.json({
      ok: true,
      report,
      configuredModel,
      configuredModelSource: realtimeEnabled
        ? 'realtime processor'
        : providers?.llm?.model
          ? 'user LLM provider'
          : 'processor environment',
      configuredModelBenchmarked: !!match,
      configuredModelResult: match,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

// Database stats
app.get('/api/stats', async (req, res) => {
  try {
    const userCount = await db.select({ count: sql<number>`count(*)` }).from(users);

    const lexemeCount = await db.select({ count: sql<number>`count(*)` }).from(lexemes);

    const progressCount = await db.select({ count: sql<number>`count(*)` }).from(userVocabulary);

    const unitCount = await db.select({ count: sql<number>`count(*)` }).from(units);

    // Get languages
    const languages = await db.selectDistinct({ language: units.language }).from(units);

    res.json({
      users: userCount[0]?.count ?? 0,
      lexemes: lexemeCount[0]?.count ?? 0,
      progressEntries: progressCount[0]?.count ?? 0,
      units: unitCount[0]?.count ?? 0,
      languages: languages.map((l) => l.language),
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// DATABASE EXPLORER
// ============================================================================

// Debug-only DB explorer — not used by the current frontend. Admin-gated:
// `table=users` returns every row including passwordHash, and the other
// tables return every user's data unfiltered, so this must never be
// reachable by a non-admin account.
app.get('/api/db/:table', async (req, res) => {
  try {
    if (req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
    const { table } = req.params;
    let data;
    if (table === 'users') data = await db.query.users.findMany({ limit: 100 });
    else if (table === 'lexemes') data = await db.query.lexemes.findMany({ limit: 100 });
    else if (table === 'progress') data = await db.query.userVocabulary.findMany({ limit: 100 });
    else if (table === 'goals') data = await db.query.activeGoals.findMany({ limit: 100 });
    else if (table === 'units') data = await db.query.units.findMany({ limit: 100 });
    else return res.status(404).json({ error: 'Table not found' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// VOCABULARY (learned words database)
// ============================================================================

app.get('/api/vocabulary', async (req, res) => {
  // 2026-07-03: was `(req as any).user?.userId` — that property never
  // existed (requireAuth sets `req.user = { id: session.userId }`), so
  // this always fell through to the 'will' fallback regardless of who was
  // logged in. Every user's vocabulary page silently showed Will's data.
  const userId = req.user?.id || 'will';
  const lang = req.query.lang as string | undefined;
  const sort = (req.query.sort as string) || 'due';

  try {
    let q = db
      .select({
        id: lexemes.id,
        lemma: lexemes.lemma,
        pos: lexemes.pos,
        language: lexemes.language,
        translation: lexemes.translation,
        frequencyRank: lexemes.frequencyRank,
        // SRS state
        state: userVocabulary.state,
        stability: userVocabulary.stability,
        difficulty: userVocabulary.difficulty,
        reps: userVocabulary.reps,
        lapses: userVocabulary.lapses,
        due: userVocabulary.due,
        lastReview: userVocabulary.lastReview,
        scaffoldedCount: userVocabulary.scaffoldedCount,
        nativeSubstitutionCount: userVocabulary.nativeSubstitutionCount,
      })
      .from(userVocabulary)
      .innerJoin(lexemes, eq(userVocabulary.lexemeId, lexemes.id))
      .where(eq(userVocabulary.userId, userId));

    if (lang) {
      q = q.where(and(eq(userVocabulary.userId, userId), eq(lexemes.language, lang))) as any;
    }

    const rows = await q;

    // Sort
    if (sort === 'stability') {
      rows.sort((a, b) => b.stability - a.stability);
    } else if (sort === 'reps') {
      rows.sort((a, b) => b.reps - a.reps);
    } else if (sort === 'lapses') {
      rows.sort((a, b) => b.lapses - a.lapses);
    } else {
      // 'due' — soonest due first
      rows.sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
    }

    res.json({
      total: rows.length,
      words: rows.map((r) => ({
        ...r,
        stateName: ['New', 'Learning', 'Review', 'Relearning'][r.state] || 'Unknown',
        isMastered: r.state === 2 && r.stability > 5 && r.reps > 5,
      })),
    });
  } catch (err: any) {
    console.error('[Dashboard] Vocabulary query failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Supported languages + their TTS voice — static config, no DB query.
// Gated behind requireAuth for consistency with the rest of /api/* even
// though the data isn't user-specific.
app.get('/api/languages/voices', requireAuth, async (_req, res) => {
  res.json(
    Object.values(LANGUAGES).map((lang) => ({
      code: lang.code,
      name: lang.name,
      voiceName: lang.tts.voice,
    })),
  );
});

// ============================================================================
// SERVICE HEALTH
// ============================================================================

app.get('/api/services', async (req, res) => {
  const checkService = async (name: string, url: string) => {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 3000);
      const response = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeoutId);
      return { name, status: 'up', latencyMs: Date.now() - start, httpCode: response.status };
    } catch (e: any) {
      return {
        name,
        status: 'down',
        latencyMs: Date.now() - start,
        error: e.name === 'AbortError' ? 'timeout' : e.message,
      };
    }
  };

  const [stt, tts, ollama] = await Promise.all([
    checkService('STT (Qwen3-ASR)', 'http://localhost:8002/health'),
    checkService('TTS (OmniVoice)', 'http://localhost:8882/health'),
    checkService('LLM (K2 vLLM)', 'http://localhost:8889/v1/models'),
  ]);

  // Ollama: which models are currently loaded in VRAM
  let ollamaModels: any[] = [];
  let ollamaLoaded = false;
  try {
    const r = await fetch('http://localhost:11434/api/ps');
    const d = (await r.json()) as any;
    ollamaModels = (d.models || []).map((m: any) => ({
      name: m.name,
      sizeVramMiB: Math.round((m.size_vram || 0) / 1024 / 1024),
    }));
    ollamaLoaded = ollamaModels.length > 0;
  } catch {}

  // Override Ollama status if no model loaded
  if (ollama.status === 'up' && !ollamaLoaded) {
    ollama.status = 'no_model_loaded';
  }

  // GPU memory
  let gpu: any = null;
  try {
    const gpuInfo = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.free,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const [used, free, total] = gpuInfo.split(',').map((s: string) => parseInt(s.trim()));
    const appsRaw = execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory,name', '--format=csv,noheader'],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    // Label processes by reading their cmdline
    const processes = appsRaw
      ? appsRaw
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const parts = line.split(',').map((s: string) => s.trim());
            const pid = parts[0];
            const memoryMiB = parseInt(parts[1]);
            let label = parts[2]?.split('/').pop() ?? parts[2] ?? 'unknown';
            try {
              const cmd = fs
                .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
                .replace(/\0/g, ' ')
                .trim();
              if (cmd.includes('server_stt')) label = 'STT (Faster Whisper)';
              else if (cmd.includes('openai_tts_server')) label = 'TTS (MossTTS)';
              else if (cmd.includes('node')) label = 'LiveKit Agent';
              else if (cmd.includes('ollama')) label = 'Ollama';
            } catch {}
            return { pid, memoryMiB, name: label };
          })
          .filter((p) => !isNaN(p.memoryMiB))
      : [];
    gpu = { usedMiB: used, freeMiB: free, totalMiB: total, processes };
  } catch {}

  res.json({ stt, tts, ollama, ollamaModels, gpu });
});

// Is the dashboard's "Local" mode option actually reachable right now?
// Used by the frontend to grey out Local and auto-switch to Cloud when the
// local GPU stack is stopped (e.g. for a heavy local job like the Audex
// requant, or `gpu-state enter exclusive`/`off`) — see ProfileTab.tsx and
// AppState.tsx's health poll.
//
// 2026-07-16: "Local" was pointed at the Audex-30B-A3B cascaded s2s server
// (see resolveServiceMode() in tutor-event-driven.ts) for an A/B test.
// Reverted 2026-07-21 back to local-gemma-audio — a live session produced
// 0-token LLM responses and empty STT transcripts despite Audex's
// /api/status reporting healthy (see project-linglang-audex-ab memory).
// This constant MUST be kept in sync with resolveServiceMode()'s mapping.
// Routed through a function (rather than a plain const) so TS's control-flow
// literal-narrowing doesn't flag the `=== 'audex'` check below as an
// always-false comparison every time this gets flipped by hand.
function currentLocalModeBackend(): 'audex' | 'local-gemma-audio' {
  return 'local-gemma-audio';
}
const LOCAL_MODE_BACKEND = currentLocalModeBackend();

async function probeUrl(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    // Reachable at all (even a 4xx/5xx from the right process) is enough
    // signal that the server is up — this is a liveness probe, not a full
    // capability check. Audex's /api/status specifically is known to stay
    // "healthy"-looking after an internal engine crash (see
    // project-linglang-audex-ab memory) — this only catches "the process
    // isn't listening at all," which is the common case (stopped for GPU
    // exclusivity), not every possible degraded state.
    return res.status < 500;
  } catch {
    return false;
  }
}

app.get('/api/local-health', requireAuth, async (req, res) => {
  const checkedAt = Date.now();
  // 2026-09-02: on shared deployments local mode is off entirely (it runs
  // on the operator's GPU). Report allowed=false and skip probing — the
  // answer is the flag, not the health of services nobody should reach.
  const allowed = process.env.ALLOW_LOCAL_MODE === 'true';
  if (!allowed) {
    return res.json({ online: false, allowed: false, checkedAt });
  }
  if (LOCAL_MODE_BACKEND === 'audex') {
    const audexUrl = process.env.AUDEX_URL || 'http://127.0.0.1:7860';
    const online = await probeUrl(`${audexUrl}/api/status`);
    return res.json({ online, allowed: true, backend: 'audex', checkedAt });
  }

  // local-gemma-audio: require the whole trio up, same ports /api/services checks.
  // 2026-09-06: STT probe moved 8001→8002 (Qwen3-ASR's real port; 8001 is
  // Moonshine CPU-fallback, intentionally stopped when the GPU stack is up),
  // LLM probe moved 8093→8889 (K2 replaced the dead Gemma QAT server).
  const [sttUp, ttsUp, llmUp] = await Promise.all([
    probeUrl('http://localhost:8002/health'),
    probeUrl('http://localhost:8882/health'),
    probeUrl('http://localhost:8889/v1/models'),
  ]);
  res.json({
    online: sttUp && ttsUp && llmUp,
    allowed: true,
    backend: 'local-gemma-audio',
    checkedAt,
  });
});

// ============================================================================
// AGENT ACTIVITY (Supervisor / Processor DB writes)
// ============================================================================

// Admin-gated: returns recent progress/goals across ALL users unfiltered
// (a system-wide activity feed for debugging the Supervisor/Processor, not
// a per-user feature) and is unused by the current frontend.
app.get('/api/activity', async (req, res) => {
  try {
    if (req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
    const since = new Date(Date.now() - 86400000); // last 24 hours

    const recentProgress = await db.query.userVocabulary.findMany({
      where: gte(userVocabulary.lastReview, since),
      with: { lexeme: true },
      orderBy: [desc(userVocabulary.lastReview)],
      limit: 40,
    });

    const recentGoals = await db.query.activeGoals.findMany({
      where: gte(activeGoals.updatedAt, since),
      orderBy: [desc(activeGoals.updatedAt)],
      limit: 15,
    });

    res.json({ recentProgress, recentGoals, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// LIVE LOG STREAM (SSE) — with secret redaction
// ============================================================================

// Patterns that should never appear in the log stream
const SECRET_PATTERNS: RegExp[] = [
  /sk[-_][a-zA-Z0-9]{20,}/g, // API keys (sk-..., sk_...)
  /API[a-zA-Z0-9]{12,}/g, // LiveKit API keys
  /Agym[a-zA-Z0-9]{30,}/g, // LiveKit API secrets
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g, // Auth tokens
  /apikey[=:]\s*\S{20,}/gi, // Key-value pairs
  /api[-_]?secret[=:]\s*\S{20,}/gi, // Secret values
  /password[=:]\s*\S{8,}/gi, // Passwords
];

function redactSecrets(line: string): string {
  let result = line;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

app.get('/api/logs', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  const logFile = process.env.TUTOR_LOG || '/tmp/tutor-live.log';
  let position = 0;

  // Start near end of file so we get recent context
  try {
    const stats = fs.statSync(logFile);
    position = Math.max(0, stats.size - 8192);
  } catch {}

  const sendLine = (line: string) => {
    const clean = redactSecrets(line.replace(/\x00/g, '')).trim();
    if (clean.length > 2) res.write(`data: ${JSON.stringify(clean)}\n\n`);
  };

  // Send initial tail
  try {
    const buf = Buffer.alloc(8192);
    const fd = fs.openSync(logFile, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 8192, position);
    fs.closeSync(fd);
    if (bytesRead > 0) {
      buf.subarray(0, bytesRead).toString('utf8').split('\n').forEach(sendLine);
      position += bytesRead;
    }
  } catch {}

  const interval = setInterval(() => {
    try {
      const stats = fs.statSync(logFile);
      if (stats.size > position) {
        const length = stats.size - position;
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(logFile, 'r');
        fs.readSync(fd, buf, 0, length, position);
        fs.closeSync(fd);
        buf.toString('utf8').split('\n').forEach(sendLine);
        position = stats.size;
      }
    } catch {}
  }, 500);

  req.on('close', () => clearInterval(interval));
});

// ============================================================================
// LIVE AGENT EVENTS (SSE) — structured events from the tutor agent
// ============================================================================

app.get('/api/events', requireAuth, (req, res) => {
  const requestedSessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!requestedSessionId) {
    return res.status(400).json({ error: 'sessionId query parameter is required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  // This endpoint used to be unauthenticated AND unfiltered: watchEvents()
  // always replays the last 32KB of the shared /tmp/tutor-events.jsonl file
  // to every new subscriber (see trace.ts), and that file is written to by
  // every user's job-proc. Before this fix, loading the dashboard replayed
  // whichever conversation turns — anyone's, from any recent session — last
  // landed in that 32KB window. That's both the "old chat history won't go
  // away" bug and a real cross-user data leak. `setSessionId` (called on
  // room join) stamps every event's sessionId as `room-${ctx.room.name}-
  // <userId>`, so we can filter to just this user's own room.
  // 2026-07-13: the 2026-07-12 mode-toggle change put `-local`/`-cloud` into
  // the room name (`linglang-<userId>-<mode>`), which shifted the actual
  // sessionId to `room-linglang-<userId>-<mode>-<userId>`. This filter still
  // matched the pre-toggle `room-linglang-<userId>-<userId>` shape, so it
  // never matched anything post-toggle and the chat log silently stayed
  // empty for every user. Match any mode segment now — 2026-07-16: hardcoding
  // `(local|cloud)` here meant adding the 'audex' mode would hit this exact
  // same silent-empty-chat-log bug again, so match a generic `[^-]+` mode
  // segment instead of enumerating modes twice (VALID_MODES above, and here).
  const userId = req.user!.id;
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownSessionPattern = new RegExp(`^room-linglang-${escapedUserId}-[^-]+-${escapedUserId}$`);
  if (!ownSessionPattern.test(requestedSessionId)) {
    return res.status(403).json({ error: 'sessionId does not belong to the authenticated user' });
  }

  const cleanup = watchEvents(
    (event: AgentEvent) => {
      if (event.sessionId !== requestedSessionId) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client disconnected */
      }
    },
    () => {
      /* ignore errors */
    },
  );

  // 2026-09-10: keep the stream alive through the reverse proxy. Nothing is
  // written while a session is quiet (a user sitting on the dashboard between
  // turns), so the proxy's read timeout fires and the browser gets a 504 —
  // confirmed live for a beta user at 23:30, whose chat log then stopped
  // updating until a manual reload. An SSE comment every 15s is invisible to
  // EventSource but resets every idle timer on the path.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      /* client disconnected */
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    cleanup();
  });
});

// ============================================================================
// LIVEKIT TOKEN
// ============================================================================

// 2026-07-12: local vs cloud is a per-session choice now, not a fixed
// deployment-wide env var — the demo site wants to offer both ("try the
// locally hosted tutor" / "try the cloud one when the local machine is
// busy") as two distinct connect options, not a single always-on mode.
// 'local' maps to the local-gemma-audio cascade (QAT + Qwen3-ASR + local
// LLM + OmniVoice); 'cloud' maps to Gemini Live (gemini mode). Client
// picks explicitly; SERVICE_MODE in .env.local is now only the fallback
// for dispatches that don't specify a mode (e.g. manual CLI testing).
// 2026-07-16: 'local' is currently pointed at the experimental Audex-30B-A3B
// cascaded s2s server for an A/B test (see resolveServiceMode in
// tutor-event-driven.ts) — no new mode value here, since there's only ever
// one "local" option in the UI.
type TutorMode = 'local' | 'cloud';
const VALID_MODES: TutorMode[] = ['local', 'cloud'];

app.post('/api/token', requireAuth, async (req, res) => {
  try {
    const requestedMode = req.body?.mode;
    // 2026-09-02: cloud is the default now. Local mode runs the tutor on
    // OUR GPU and is disabled by default on shared deployments — a
    // self-hoster on their own hardware opts back in with
    // ALLOW_LOCAL_MODE=true (their "local" is their own box, which is the
    // whole point). Without the flag, a local request is refused rather
    // than silently served.
    const allowLocal = process.env.ALLOW_LOCAL_MODE === 'true';
    if (requestedMode === 'local' && !allowLocal) {
      return res.status(400).json({
        error:
          'Local mode is not enabled on this deployment. Use Cloud mode, or (self-hosters) set ALLOW_LOCAL_MODE=true.',
      });
    }
    const mode: TutorMode = VALID_MODES.includes(requestedMode) ? requestedMode : 'cloud';

    // 2026-06-25: per-user deterministic room. Each user gets their own
    // room `linglang-<userId>`. The room name is NOT client-controlled
    // any more — that was the source of cross-user room collisions when
    // the dashboard generated random room names.
    // 2026-07-12: mode is now part of the room name (`-local`/`-cloud`
    // suffix) so switching modes doesn't fight over one shared room/job —
    // each mode gets its own independent session, job, and history. A
    // user can have both open in separate tabs without collision, and
    // switching modes never requires tearing down a live job first.
    const userId = req.user!.id;
    const roomName = `linglang-${userId}-${mode}`;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      return res.status(500).json({ error: 'LiveKit credentials not configured' });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    // Create agent dispatch so LiveKit Cloud assigns our worker to this room.
    // createDispatch() does NOT dedupe — calling it twice for the same room
    // (e.g. a double-tap on "Connect" before the button re-renders, or a
    // retried /api/token call) spins up a second, fully independent agent
    // job-proc in the same room: two STT/LLM/TTS pipelines both listening to
    // the same mic track and both talking back, which is what "multiple
    // audio files playing at once" and duplicated/diverging chat history
    // turned out to be (confirmed via job-proc logs: two "received job
    // request" events 3s apart, both processing identical VAD/transcript
    // events for room linglang-will). Check for an existing dispatch first.
    const livekitUrl = process.env.LIVEKIT_URL || '';
    const dispatchClient = new AgentDispatchClient(
      livekitUrl.replace('wss://', 'https://'),
      apiKey,
      apiSecret,
    );
    const agentName = process.env.LINGLANG_AGENT_NAME ?? 'linglang-tutor';

    // listDispatch() throws for a room that doesn't exist yet (the normal
    // case for a first-time connect — the room is only created once the
    // participant actually joins). That's not "an existing dispatch check
    // failed", it's "there's nothing to find yet" — treat it as such and
    // still proceed to createDispatch below. Regression note: an earlier
    // version of this fix put both calls in one try/catch, so a nonexistent
    // room's listDispatch error skipped createDispatch entirely and no
    // agent ever joined new rooms — confirmed live via zero "received job
    // request" log lines across multiple real connect attempts.
    let alreadyDispatched = false;
    try {
      const existing = await dispatchClient.listDispatch(roomName);
      // 2026-07-12: a dispatch record persists on the LiveKit server even
      // after its job proc has died (crashed, OOM-killed, manually killed
      // while debugging) — state.status goes to JS_FAILED but the dispatch
      // itself is never cleaned up. Matching on agentName alone treated a
      // dead dispatch as "an agent is already here" forever, permanently
      // blocking new dispatches for that room until someone manually
      // deleted the stale record via the API. Only count a dispatch as
      // live if it has no jobs yet (still pending assignment) or at least
      // one job that isn't JS_FAILED/JS_SUCCESS (i.e. actually running).
      alreadyDispatched = existing.some((d) => {
        if (d.agentName !== agentName) return false;
        const jobs = d.state?.jobs ?? [];
        if (jobs.length === 0) return true;
        return jobs.some(
          (j) =>
            j.state?.status !== JobStatus.JS_FAILED && j.state?.status !== JobStatus.JS_SUCCESS,
        );
      });
    } catch {
      // Room doesn't exist yet (or listDispatch failed for some other
      // reason) — fall through and dispatch as normal.
    }

    if (alreadyDispatched) {
      console.log(
        `[Dashboard] Agent already dispatched for user ${userId} in room ${roomName}, skipping`,
      );
    } else {
      // 2026-07-18: Local mode is capped to ONE concurrent session across
      // ALL users while Audex is still being fixed — the local server is
      // sized/tuned for a single user (see project-linglang-audex-ab
      // memory: max_num_seqs patched down to 8, "single-user smoke-test
      // box, not a multi-tenant server"), so a second concurrent Local
      // user wouldn't fail cleanly, just silently degrade both sessions.
      // Only checked for a NEW dispatch — reconnecting to your OWN
      // already-running local session is never blocked by this.
      if (mode === 'local') {
        const roomService = new RoomServiceClient(
          livekitUrl.replace('wss://', 'https://'),
          apiKey,
          apiSecret,
        );
        const activeRooms = await roomService.listRooms().catch(() => []);
        const otherLocalRoom = activeRooms.find(
          (r) => r.name.endsWith('-local') && r.name !== roomName,
        );
        if (otherLocalRoom) {
          return res.status(423).json({
            error:
              'Local mode is in use by another session right now (it only supports one at a time). Try Cloud mode, or wait a bit.',
          });
        }
      }

      // Only checked for NEW dispatches (a fresh Google API session about
      // to be spun up) — reconnecting to an already-running job never
      // incurs new cost here, so budget exhaustion mid-session doesn't cut
      // an existing conversation off.
      let googleApiKey: string | undefined;
      // 2026-09-02: BYO providers (see lib/provider-config.ts). Resolved
      // per dispatch so key edits take effect on the next session, and
      // passed down via job metadata like googleApiKey. A user who BYO'd
      // the whole cascaded stack never touches Google at all — skip the
      // shared-budget tripwire for them even in cloud mode (the factory
      // downgrades gemini->cloud when BYO components are present).
      const providers = await resolveProviders(userId).catch((err) => {
        console.warn(
          `[Dashboard] resolveProviders(${userId}) failed, using env defaults: ${String(err).slice(0, 120)}`,
        );
        return null;
      });
      const byoCoversGoogle =
        !!providers &&
        (providers.llm || providers.tts || providers.stt) &&
        !providers.realtimeEnabled;
      if (mode === 'cloud' && !byoCoversGoogle) {
        const plan = await getGoogleKeyPlan(userId);
        if (plan.useShared && plan.overBudget) {
          return res.status(402).json({
            error:
              'Shared Google API budget for this period is used up. Add your own free Gemini API key in Profile to keep using Cloud mode, or switch to Local mode.',
          });
        }
        googleApiKey = plan.apiKey ?? undefined;
      } else if (mode === 'cloud' && byoCoversGoogle) {
        // Still hand over the Google key if they have one — realtime
        // could be enabled later without re-dispatching anything else.
        googleApiKey = (await getGoogleKeyPlan(userId).catch(() => null))?.apiKey ?? undefined;
      }

      try {
        await dispatchClient.createDispatch(roomName, agentName, {
          metadata: JSON.stringify({
            mode,
            userId,
            googleApiKey,
            providers,
            billGoogleUsage: mode === 'cloud' && !googleApiKey && !byoCoversGoogle,
          }),
        });
        console.log(
          `[Dashboard] Agent dispatch for user ${userId} in room ${roomName} (mode=${mode})`,
        );
      } catch (dispatchErr: any) {
        console.warn(`[Dashboard] Agent dispatch warning: ${dispatchErr.message || dispatchErr}`);
      }
    }

    res.json({
      token,
      url: process.env.LIVEKIT_URL,
      roomName,
      mode,
      eventSessionId: `room-${roomName}-${userId}`,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// PAGES
// ============================================================================

// Root: redirect to login. We don't ship a public landing page —
// users always land on auth. Authenticated users go straight to /dashboard.
app.get('/', requireAuth, (_req, res) => {
  res.redirect('/dashboard');
});

// Dashboard — new React app (Vite build output in public/app/)
app.get('/dashboard', requireAuth, (_req, res) => {
  const appPath = path.join(__dirname, 'public', 'app', 'index.html');
  if (fs.existsSync(appPath)) {
    res.sendFile(appPath);
  } else {
    // Fallback to old dashboard if Vite build hasn't been run
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
});

// Debug page — standalone pipeline visualization for developer testing
app.get('/debug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'debug.html'));
});

// Serve Vite-built assets (JS, CSS, chunks) — public, no auth
// (the app itself does auth via API calls)
app.use('/assets', express.static(path.join(__dirname, 'public', 'app', 'assets')));

// Root-level PWA files (manifest.webmanifest, sw.js, icons) — vite-plugin-pwa
// emits these into the build outDir root (public/app/), but nothing served
// them at the root URL path they're referenced at (e.g. GET /sw.js) before
// this. Falls through (no matching file) for /login, /api/*, /dashboard —
// those stay handled by their own routes.
app.use(express.static(path.join(__dirname, 'public', 'app'), { index: false }));

// ============================================================================
// VOCABULARY BY LANGUAGE
// ============================================================================

app.get('/api/vocabulary/:language', async (req, res) => {
  try {
    const { language } = req.params;
    const { userId = req.user!.id, limit = '200' } = req.query;

    // Ownership check — same pattern as the /api/users/:userId/* routes:
    // only the account itself or admin ('will') may pass a different userId.
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId as string),
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Language is filtered in SQL. This used to take the `limit` most
    // recently reviewed rows and THEN drop the ones in other languages, so a
    // learner whose recent activity is in another language saw a short list
    // or an empty one — the route is "vocabulary by language" but the limit
    // was applied across all languages first.
    const progress = await db.query.userVocabulary.findMany({
      where: and(
        eq(userVocabulary.userId, userId as string),
        inArray(
          userVocabulary.lexemeId,
          db.select({ id: lexemes.id }).from(lexemes).where(eq(lexemes.language, language)),
        ),
      ),
      with: { lexeme: true },
      orderBy: [desc(userVocabulary.lastReview)],
      limit: parseInt(limit as string),
    });

    res.json(progress);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// USER SETTINGS
// ============================================================================

app.patch('/api/users/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { targetLanguage, nativeLanguage, proficiencyLevel } = req.body;

    if (targetLanguage !== undefined && !isSupportedTargetLanguage(targetLanguage)) {
      return res.status(400).json({ error: 'Unsupported target language' });
    }

    const updates: Record<string, string> = {};
    if (targetLanguage) updates.targetLanguage = targetLanguage;
    if (nativeLanguage) updates.nativeLanguage = nativeLanguage;
    if (proficiencyLevel) updates.proficiencyLevel = proficiencyLevel;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Check user exists first
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      // Create user
      await db.insert(users).values({
        id: userId,
        targetLanguage: targetLanguage || null,
        nativeLanguage: nativeLanguage || 'en',
        proficiencyLevel: proficiencyLevel || 'beginner',
      });
    } else {
      await db.update(users).set(updates).where(eq(users.id, userId));
    }

    const updated = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// PERSONA — adaptive conversation shell
// ============================================================================

/**
 * GET /api/users/:userId/persona?lang=pt
 * Returns the merged persona for a user+language.
 */
app.get('/api/users/:userId/persona', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const userId = String(req.params.userId || '');
  const lang = String(req.query.lang || 'all');
  if (req.user!.id !== userId && req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
  if (!/^(all|[a-z]{2,3})$/.test(lang)) return res.status(400).json({ error: 'Invalid language' });
  try {
    const rows = await db.select().from(userPersona).where(eq(userPersona.userId, userId));
    res.json({ userId, rows, effective: await readPersona(userId, lang), activation: 'next-session; live coaching is best-effort' });
  } catch { res.status(503).json({ error: 'Preferences temporarily unavailable' }); }
});

app.patch('/api/users/:userId/persona', requireAuth, async (req, res) => {
  const userId = String(req.params.userId || '');
  if (req.user!.id !== userId && req.user!.id !== 'will') return res.status(403).json({ error: 'Forbidden' });
  try {
    const languageCode = req.body.languageCode ?? 'all';
    const values = validatePersonaPatch(req.body);
    const inherit = req.body.inheritFields ?? [];
    if (!Array.isArray(inherit) || !inherit.every(key => PERSONA_FIELDS.includes(key))) return res.status(400).json({ error: 'Invalid preference fields' });
    if (!/^(all|[a-z]{2,3})$/.test(languageCode)) return res.status(400).json({ error: 'Invalid language' });
    if (inherit.length) await db.execute(sql`UPDATE user_persona SET explicit_preferences=explicit_preferences-${inherit}::text[],updated_at=now() WHERE user_id=${userId} AND language_code=${languageCode}`);
    if (Object.keys(values).length) await writePersona(userId, languageCode, {...values, source:'ui'});
    invalidateLearnerView(userId, languageCode);
    res.json({ ok:true, effective:await readPersona(userId,languageCode), activation:'next-session; live coaching is best-effort' });
  } catch { res.status(400).json({ error:'Invalid preferences (text fields are limited to 2000 characters)' }); }
});

// ============================================================================
// ONBOARDING API
// ============================================================================

/**
 * GET /api/users/:userId/onboarding/:lang
 * Returns the onboarding state for a user+language.
 * Returns { exists: false } if no row yet.
 */
app.get('/api/users/:userId/onboarding/:lang', requireAuth, async (req, res) => {
  try {
    const { userId, lang } = req.params;
    const { getOnboardingState } = await import('../lib/onboarding.js');
    const state = await getOnboardingState(userId, lang);
    if (!state) return res.json({ exists: false, isComplete: false });
    res.json({ exists: true, ...state });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * POST /api/users/:userId/onboarding/:lang
 * Submit onboarding data from the UI form.
 * Body: { priorStudy, studyDetails?, goals, goalDetails?, selfRatedLevel }
 * Commits the level anchor and marks ui_complete=true.
 */
app.post('/api/users/:userId/onboarding/:lang', requireAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || '');
    const lang = String(req.params.lang || '');
    const { priorStudy, studyDetails, goals, goalDetails, selfRatedLevel } = req.body;

    if (!userId || !lang || !selfRatedLevel) {
      return res.status(400).json({ error: 'userId, lang, and selfRatedLevel are required' });
    }

    const { saveOnboardingData, completeOnboarding, selfRatedLevelToAnchor } =
      await import('../lib/onboarding.js');
    const { setLevel } = await import('../lib/level-inference.js');

    // 2026-07-16: the multi-question form (prior study / goals) was cut —
    // the tutor already extracts these conversationally (onboarding_signal
    // supervisor triggers). priorStudy/goals are now optional inputs kept
    // only for the admin/API surface; left null when the UI doesn't send
    // them rather than a placeholder string (buildPromptLines only injects
    // a line when the field is truthy, so null just omits it cleanly).
    await saveOnboardingData(userId, lang, {
      priorStudy: priorStudy || null,
      studyDetails: studyDetails || null,
      goals: goals ? (Array.isArray(goals) ? goals : [goals]) : null,
      goalDetails: goalDetails || null,
      selfRatedLevel,
    });

    // A UI-form self-report is the user directly telling us their level —
    // philosophically the same as a manual dashboard pin (spec §6.5), not
    // the LLM's vibes-based guess from a 5-8 turn voice chat (which no
    // longer sets a level override at all — see completeOnboarding).
    const { level, confidence } = selfRatedLevelToAnchor(selfRatedLevel);
    await setLevel(userId, lang, level, 'manual', confidence);
    await completeOnboarding(userId, lang, 'ui');

    res.json({ ok: true, userId, lang, anchoredLevel: level, confidence });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// FRONTEND (careful ordering — auth-bypass prevention)
// ============================================================================

// Serve public assets if they exist. Each is registered explicitly so
// missing files return 404 (not 500 from a sendFile ENOENT). Files
// that don't exist are simply skipped at startup.
const publicFiles = ['css/design-tokens.css', 'css/landing.css', 'js/landing.js'];
for (const file of publicFiles) {
  const filePath = path.join(__dirname, 'public', file);
  if (!fs.existsSync(filePath)) {
    // Don't register the route — let it 404 normally.
    continue;
  }
  app.get(`/${file}`, (_req, res) => {
    res.sendFile(filePath);
  });
}

// Dashboard HTML served ONLY via the /dashboard route above (with requireAuth)
// Block direct access to dashboard.html, dashboard.css, dashboard.js via static serving
app.get('/dashboard.html', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/css/dashboard.css', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'css', 'dashboard.css'));
});
app.get('/js/dashboard.js', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'js', 'dashboard.js'));
});

// Generic static files — but block auth-protected pages from being served here
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      // Never serve dashboard or login HTML from static middleware
      if (
        filePath.includes('dashboard.html') ||
        filePath.includes('dashboard.css') ||
        filePath.includes('dashboard.js')
      ) {
        res.status(404).end();
      }
    },
  }),
);

// ============================================================================
// START SERVER
// ============================================================================

// 2026-06-25: removed initialiseAuth() — auth is now per-user via the DB.
// The server starts up clean; the first /api/login call hits the DB.
// Restart recovery never auto-resumes provider spending; partial reports remain reviewable.
void interruptAlignmentJobs().catch(() => console.error('[Alignment] Restart recovery failed'));
const conversationRecovery = createConversationArchive();
const replayConversations = () => conversationRecovery.drain().then(result => {
  if (result.pending) console.warn(`[Archive] ${result.pending} pending durable events`);
}).catch(() => console.error('[Archive] Recovery failed; files retained'));
void replayConversations();
setInterval(() => { void replayConversations(); }, 5000).unref();
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              LingLang Dashboard Server                     ║
╠════════════════════════════════════════════════════════════╣
║  URL:   http://localhost:${PORT}                             ║
║  Login: http://localhost:${PORT}/login                       ║
║  Auth:  session cookie (HttpOnly, SameSite=Strict)         ║
║  Rate:  10 login attempts / 15 min per IP                  ║
╚════════════════════════════════════════════════════════════╝
    `);
});
