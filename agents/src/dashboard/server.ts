/**
 * LingLang Dashboard Server
 *
 * Simple web dashboard to:
 * - View user progress (SRS levels)
 * - Monitor active goals
 * - View real-time session stats
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { watchEvents, type AgentEvent } from '../lib/trace.js';
import { db } from '../db/index.js';
import { users, lexemes, userVocabulary, activeGoals, units, userPersona, userLanguageLevels, reviewLogs, sessionSummaries } from '../db/schema.js';
import { eq, desc, sql, gte, lte, and } from 'drizzle-orm';
import { execFileSync } from 'child_process';
import { authenticateByUsername, createUser, hashPassword } from '../lib/user-auth.js';
import { writePersona } from '../lib/persona.js';
import { LANGUAGES } from '../config/languages.js';
import { computeStreak, bucketVocabHistory } from './stats.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');

app.use(express.json());

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ============================================================================
// AUTHENTICATION
// ============================================================================

// In-memory sessions (survives HMR, lost on server restart)
const sessions = new Map<string, { userId: string; createdAt: number }>();
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['ll_session'];
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session || (Date.now() - session.createdAt) > SESSION_MAX_AGE_MS) {
    // Expired or missing session
    if (sessionId) sessions.delete(sessionId);
    if (req.path.startsWith('/api/')) {
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

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  try {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

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
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    recordLoginAttempt(clientIp, true);

    // Create session
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { userId: user.id, createdAt: Date.now() });

    // Set cookie — always use Secure when behind nginx (x-forwarded-proto)
    const behindProxy = req.headers['x-forwarded-proto'] === 'https';
    const secureFlag = behindProxy || process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `ll_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureFlag}`
    ].join('; '));

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
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    if (typeof password !== 'string' || password.length < 4) {
      return res.status(400).json({ error: 'password must be at least 4 characters' });
    }

    // Derive a URL-safe id from the username. Falls back to a random suffix
    // if the result is empty (e.g. username is all non-alphanumerics).
    const idBase = String(username).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const id = idBase || `user_${Date.now().toString(36)}`;

    const existing = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (existing) {
      return res.status(409).json({ error: `User "${id}" already exists` });
    }

    await createUser({
      id,
      username: String(username),
      password: String(password),
      targetLanguage: targetLanguage || 'ru',
      nativeLanguage: nativeLanguage || 'en',
    });

    console.log(`[Auth] Admin ${req.user.id} created user ${id} (${username}) target=${targetLanguage || 'ru'}`);
    res.json({ success: true, user: { id, username } });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['ll_session'];
  if (sessionId) sessions.delete(sessionId);

  res.setHeader('Set-Cookie', 'll_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const userRow = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    res.json({
      user: {
        id: req.user!.id,
        targetLanguage: userRow?.targetLanguage ?? 'ru',
        nativeLanguage: userRow?.nativeLanguage ?? 'en',
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

// Get all users — 2026-06-25: per-user data isolation. Non-admin users
// only see their own row.
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    if (req.user!.id === 'will') {
      const allUsers = await db.query.users.findMany({
        orderBy: [desc(users.createdAt)]
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
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get progress stats
    const progress = await db.query.userVocabulary.findMany({
      where: eq(userVocabulary.userId, userId),
      with: { lexeme: true }
    });

    // Get active goals
    const goals = await db.query.activeGoals.findMany({
      where: eq(activeGoals.userId, userId),
      orderBy: [desc(activeGoals.createdAt)]
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
        case 0: stateDistribution.new++; break;
        case 1: stateDistribution.learning++; break;
        case 2: stateDistribution.review++; break;
        case 3: stateDistribution.relearning++; break;
      }
    }

    res.json({
      user,
      progress,
      goals,
      stats: {
        totalVocab: progress.length,
        stateDistribution,
        activeGoals: goals.filter(g => g.status === 'active').length,
        completedGoals: goals.filter(g => g.status === 'completed').length,
      }
    });
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
      progress = progress.filter(p => p.state === parseInt(state as string));
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

    res.json(rows.map(r => ({
      languageCode: r.languageCode,
      proficiencyLevel: r.proficiencyLevel,
      confidence: r.confidence,
      source: r.source,
    })));
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

    const reviewDateRows = await db.select({ reviewDate: reviewLogs.reviewDate })
      .from(reviewLogs)
      .where(eq(reviewLogs.userId, userId));
    const streak = computeStreak(reviewDateRows.map(r => r.reviewDate));

    const talkTimeRows = await db.select({
      totalMinutes: sql<number>`coalesce(sum(${sessionSummaries.durationMinutes}), 0)`,
    })
      .from(sessionSummaries)
      .where(eq(sessionSummaries.userId, userId));
    const totalMinutes = Number(talkTimeRows[0]?.totalMinutes ?? 0);
    const talkTimeHours = Math.round((totalMinutes / 60) * 10) / 10;

    // Uses the user_vocabulary_due_idx (userId, due) composite index —
    // an equality match on userId plus a range match on due is exactly
    // what that index is built for.
    const wordsDueRows = await db.select({ count: sql<number>`count(*)` })
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

    const logs = await db.select({
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

// Get curriculum units
app.get('/api/curriculum', async (req, res) => {
  try {
    const { language } = req.query;

    let allUnits;
    if (language) {
      allUnits = await db.query.units.findMany({
        where: eq(units.language, language as string),
        with: { lexemes: true }
      });
    } else {
      allUnits = await db.query.units.findMany({
        with: { lexemes: true }
      });
    }

    res.json(allUnits);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Database stats
app.get('/api/runtime', async (req, res) => {
  try {
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

// Database stats
app.get('/api/stats', async (req, res) => {
  try {
    const userCount = await db.select({ count: sql<number>`count(*)` })
      .from(users);

    const lexemeCount = await db.select({ count: sql<number>`count(*)` })
      .from(lexemes);

    const progressCount = await db.select({ count: sql<number>`count(*)` })
      .from(userVocabulary);

    const unitCount = await db.select({ count: sql<number>`count(*)` })
      .from(units);

    // Get languages
    const languages = await db.selectDistinct({ language: units.language })
      .from(units);

    res.json({
      users: userCount[0]?.count ?? 0,
      lexemes: lexemeCount[0]?.count ?? 0,
      progressEntries: progressCount[0]?.count ?? 0,
      units: unitCount[0]?.count ?? 0,
      languages: languages.map(l => l.language),
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// DATABASE EXPLORER
// ============================================================================

app.get('/api/db/:table', async (req, res) => {
  try {
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
  const sort = req.query.sort as string || 'due';

  try {
    let q = db.select({
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
      words: rows.map(r => ({
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
  res.json(Object.values(LANGUAGES).map(lang => ({
    code: lang.code,
    name: lang.name,
    voiceName: lang.tts.voice,
  })));
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
      return { name, status: 'down', latencyMs: Date.now() - start, error: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  };

  const [stt, tts, ollama] = await Promise.all([
    checkService('STT (Qwen3-ASR)', 'http://localhost:8001/health'),
    checkService('TTS (MossTTS)', 'http://localhost:8880/v1/models'),
    checkService('LLM (Ollama)', 'http://localhost:11434/api/tags'),
  ]);

  // Ollama: which models are currently loaded in VRAM
  let ollamaModels: any[] = [];
  let ollamaLoaded = false;
  try {
    const r = await fetch('http://localhost:11434/api/ps');
    const d = await r.json() as any;
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
    const gpuInfo = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.free,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf-8', timeout: 5000 }).trim();
    const [used, free, total] = gpuInfo.split(',').map((s: string) => parseInt(s.trim()));
    const appsRaw = execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_memory,name', '--format=csv,noheader'], { encoding: 'utf-8', timeout: 5000 }).trim();
    // Label processes by reading their cmdline
    const processes = appsRaw ? appsRaw.split('\n').filter(Boolean).map(line => {
      const parts = line.split(',').map((s: string) => s.trim());
      const pid = parts[0];
      const memoryMiB = parseInt(parts[1]);
      let label = parts[2]?.split('/').pop() ?? parts[2] ?? 'unknown';
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        if (cmd.includes('server_stt')) label = 'STT (Faster Whisper)';
        else if (cmd.includes('openai_tts_server')) label = 'TTS (MossTTS)';
        else if (cmd.includes('node')) label = 'LiveKit Agent';
        else if (cmd.includes('ollama')) label = 'Ollama';
      } catch {}
      return { pid, memoryMiB, name: label };
    }).filter(p => !isNaN(p.memoryMiB)) : [];
    gpu = { usedMiB: used, freeMiB: free, totalMiB: total, processes };
  } catch {}

  res.json({ stt, tts, ollama, ollamaModels, gpu });
});

// ============================================================================
// AGENT ACTIVITY (Supervisor / Processor DB writes)
// ============================================================================

app.get('/api/activity', async (req, res) => {
  try {
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
  /sk[-_][a-zA-Z0-9]{20,}/g,       // API keys (sk-..., sk_...)
  /API[a-zA-Z0-9]{12,}/g,           // LiveKit API keys
  /Agym[a-zA-Z0-9]{30,}/g,          // LiveKit API secrets
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g, // Auth tokens
  /apikey[=:]\s*\S{20,}/gi,        // Key-value pairs
  /api[-_]?secret[=:]\s*\S{20,}/gi, // Secret values
  /password[=:]\s*\S{8,}/gi,        // Passwords
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

app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
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

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  const cleanup = watchEvents(
    (event: AgentEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch { /* client disconnected */ }
    },
    () => { /* ignore errors */ }
  );

  req.on('close', () => {
    cleanup();
  });
});

// ============================================================================
// LIVEKIT TOKEN
// ============================================================================

app.post('/api/token', requireAuth, async (req, res) => {
  try {
    // 2026-06-25: per-user deterministic room. Each user gets their own
    // room `linglang-<userId>`. The room name is NOT client-controlled
    // any more — that was the source of cross-user room collisions when
    // the dashboard generated random room names.
    const userId = req.user!.id;
    const roomName = `linglang-${userId}`;

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

    // Create agent dispatch so LiveKit Cloud assigns our worker to this room
    const livekitUrl = process.env.LIVEKIT_URL || '';
    const dispatchClient = new AgentDispatchClient(livekitUrl.replace('wss://', 'https://'), apiKey, apiSecret);
    try {
      const agentName = process.env.LINGLANG_AGENT_NAME ?? 'linglang-tutor';
      await dispatchClient.createDispatch(roomName, agentName);
      console.log(`[Dashboard] Agent dispatch for user ${userId} in room ${roomName}`);
    } catch (dispatchErr: any) {
      // Non-fatal — room may already have a dispatch, or agent is auto-dispatched
      console.warn(`[Dashboard] Agent dispatch warning: ${dispatchErr.message || dispatchErr}`);
    }

    res.json({ token, url: process.env.LIVEKIT_URL, roomName });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// PAGES
// ============================================================================

// Root: redirect to login. We don't ship a public landing page —
// users always land on auth. Authenticated users go straight to /dashboard.
app.get('/', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies['ll_session'];
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (session && (Date.now() - session.createdAt) <= SESSION_MAX_AGE_MS) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
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

// ============================================================================
// VOCABULARY BY LANGUAGE
// ============================================================================

app.get('/api/vocabulary/:language', async (req, res) => {
  try {
    const { language } = req.params;
    const { userId = 'test-user', limit = '200' } = req.query;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId as string)
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const progress = await db.query.userVocabulary.findMany({
      where: eq(userVocabulary.userId, userId as string),
      with: { lexeme: true },
      orderBy: [desc(userVocabulary.lastReview)],
      limit: parseInt(limit as string),
    });

    const filtered = progress.filter(p => p.lexeme.language === language);
    res.json(filtered);
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

    const updates: Record<string, string> = {};
    if (targetLanguage) updates.targetLanguage = targetLanguage;
    if (nativeLanguage) updates.nativeLanguage = nativeLanguage;
    if (proficiencyLevel) updates.proficiencyLevel = proficiencyLevel;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Check user exists first
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!user) {
      // Create user
      await db.insert(users).values({
        id: userId,
        targetLanguage: targetLanguage || 'ru',
        nativeLanguage: nativeLanguage || 'en',
        proficiencyLevel: proficiencyLevel || 'beginner',
      });
    } else {
      await db.update(users).set(updates).where(eq(users.id, userId));
    }

    const updated = await db.query.users.findFirst({
      where: eq(users.id, userId)
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
  try {
    const { userId } = req.params;
    const lang = (req.query.lang as string) || 'all';
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const rows = await db.select().from(userPersona)
      .where(eq(userPersona.userId, userId));
    res.json({ userId, rows });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * PATCH /api/users/:userId/persona
 * Body: { languageCode, personaOverride?, tone?, correctionStyle?, teachingMode?, extraInstructions? }
 * Upserts the persona for the given user+language. Source = 'ui'.
 */
app.patch('/api/users/:userId/persona', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user!.id !== userId && req.user!.id !== 'will') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const {
      languageCode = 'all',
      personaOverride,
      tone,
      correctionStyle,
      teachingMode,
      extraInstructions,
    } = req.body;

    const validTones = ['roast', 'warm', 'neutral', 'formal', 'drill-sergeant', null, ''];
    const validCorrections = ['immediate', 'gentle', 'ignore', 'end-of-turn', null, ''];
    const validModes = ['conversational', 'drill', 'roleplay', 'storytelling', null, ''];

    if (tone !== undefined && !validTones.includes(tone)) {
      return res.status(400).json({ error: `Invalid tone: ${tone}` });
    }
    if (correctionStyle !== undefined && !validCorrections.includes(correctionStyle)) {
      return res.status(400).json({ error: `Invalid correctionStyle: ${correctionStyle}` });
    }
    if (teachingMode !== undefined && !validModes.includes(teachingMode)) {
      return res.status(400).json({ error: `Invalid teachingMode: ${teachingMode}` });
    }

    const patch: Record<string, string | null> = { source: 'ui' };
    if (personaOverride !== undefined) patch.personaOverride = personaOverride || null;
    if (tone !== undefined) patch.tone = tone || null;
    if (correctionStyle !== undefined) patch.correctionStyle = correctionStyle || null;
    if (teachingMode !== undefined) patch.teachingMode = teachingMode || null;
    if (extraInstructions !== undefined) patch.extraInstructions = extraInstructions || null;

    if (Object.keys(patch).length <= 1) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await writePersona(userId, languageCode, patch as any);
    res.json({ ok: true, userId, languageCode, patch });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
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
    const { userId, lang } = req.params;
    const { priorStudy, studyDetails, goals, goalDetails, selfRatedLevel } = req.body;

    if (!priorStudy || !goals || !selfRatedLevel) {
      return res.status(400).json({ error: 'priorStudy, goals, and selfRatedLevel are required' });
    }

    const { saveOnboardingData, commitOnboardingLevel, selfRatedLevelToAnchor } = await import('../lib/onboarding.js');

    await saveOnboardingData(userId, lang, {
      priorStudy,
      studyDetails: studyDetails || null,
      goals: Array.isArray(goals) ? goals : [goals],
      goalDetails: goalDetails || null,
      selfRatedLevel,
    });

    const { level, confidence } = selfRatedLevelToAnchor(selfRatedLevel);
    const evidence = `UI onboarding: ${priorStudy}${studyDetails ? ` (${studyDetails})` : ''}, self-rated ${selfRatedLevel}`;
    await commitOnboardingLevel(userId, lang, level, confidence, evidence, 'ui');

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
const publicFiles = [
  'css/design-tokens.css',
  'css/landing.css',
  'js/landing.js',
];
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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Never serve dashboard or login HTML from static middleware
    if (filePath.includes('dashboard.html') || filePath.includes('dashboard.css') || filePath.includes('dashboard.js')) {
      res.status(404).end();
    }
  }
}));

// ============================================================================
// START SERVER
// ============================================================================

// 2026-06-25: removed initialiseAuth() — auth is now per-user via the DB.
// The server starts up clean; the first /api/login call hits the DB.
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
