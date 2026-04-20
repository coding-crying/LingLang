/**
 * LingLang Dashboard Server
 *
 * Simple web dashboard to:
 * - View user progress (SRS levels)
 * - Monitor active goals
 * - Import Duolingo data
 * - View real-time session stats
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { users, lexemes, userVocabulary, activeGoals, units, duolingoMetadata } from '../db/schema.js';
import { eq, desc, sql, gte, and } from 'drizzle-orm';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { AccessToken } from 'livekit-server-sdk';

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

// Scrypt-based password hashing (Node built-in, no deps)
const HASH_KEYLEN = 64;
const HASH_SALT = process.env.DASHBOARD_PASSWORD_SALT || 'linglang-dashboard-2026';

async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, HASH_SALT, HASH_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey.toString('hex'));
    });
  });
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const hash = await hashPassword(password);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// Generate or load stored password hash
let storedPasswordHash: string | null = null;

async function initialiseAuth(): Promise<void> {
  const envHash = process.env.DASHBOARD_PASSWORD_HASH;
  const envPassword = process.env.DASHBOARD_PASSWORD;

  if (envHash) {
    storedPasswordHash = envHash;
    console.log('[Auth] Using DASHBOARD_PASSWORD_HASH from env');
  } else if (envPassword) {
    storedPasswordHash = await hashPassword(envPassword);
    console.log('[Auth] Generated hash from DASHBOARD_PASSWORD');
  } else {
    // Default password: admin (change immediately!)
    storedPasswordHash = await hashPassword('admin');
    console.log('[Auth] ⚠️  No DASHBOARD_PASSWORD_HASH or DASHBOARD_PASSWORD set. Using default password: admin');
    console.log('[Auth] ⚠️  Set DASHBOARD_PASSWORD in .env.local to secure the dashboard');
  }
}

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

    // For now, single admin user; username is informational
    if (!storedPasswordHash) {
      return res.status(503).json({ error: 'Auth not initialised' });
    }

    const valid = await verifyPassword(password, storedPasswordHash);
    if (!valid) {
      recordLoginAttempt(clientIp, false);
      // Constant-time delay to slow down brute force
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    recordLoginAttempt(clientIp, true);

    // Create session
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { userId: username, createdAt: Date.now() });

    // Set cookie — always use Secure when behind nginx (x-forwarded-proto)
    const behindProxy = req.headers['x-forwarded-proto'] === 'https';
    const secureFlag = behindProxy || process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `ll_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureFlag}`
    ].join('; '));

    console.log(`[Auth] User "${username}" logged in from ${clientIp}`);
    res.json({ success: true, user: { id: username } });
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

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
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

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const allUsers = await db.query.users.findMany({
      orderBy: [desc(users.createdAt)]
    });
    res.json(allUsers);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get user details
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

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

    // Get Duolingo metadata if exists
    const duoData = await db.query.duolingoMetadata.findFirst({
      where: eq(duolingoMetadata.userId, userId)
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
      duolingoData: duoData,
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
app.get('/api/users/:userId/vocabulary', async (req, res) => {
  try {
    const { userId } = req.params;
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

// Import Duolingo data
app.post('/api/users/:userId/import-duolingo', async (req, res) => {
  try {
    const { userId } = req.params;
    const { jwt, username, language } = req.body;

    if (!jwt || !username || !language) {
      return res.status(400).json({
        error: 'Missing required fields: jwt, username, language'
      });
    }

    // Run the sync script — execFileSync prevents shell injection
    const scriptPath = path.join(__dirname, '../scripts/sync-duolingo.ts');

    console.log('[Dashboard] Running Duolingo import...');

    const output = execFileSync('npx', ['tsx', scriptPath, userId, '--jwt', jwt, '--username', username, '--lang', language], {
      encoding: 'utf-8',
      cwd: path.join(__dirname, '../../'),
      timeout: 60000,
    });

    console.log('[Dashboard] Import complete');

    res.json({
      success: true,
      output: output.split('\n').filter(line => line.trim()),
    });

  } catch (error: any) {
    console.error('[Dashboard] Import failed:', error);
    res.status(500).json({
      error: error.message,
      output: error.stdout ? error.stdout.toString() : undefined,
    });
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
// LIVEKIT TOKEN
// ============================================================================

app.post('/api/token', async (req, res) => {
  try {
    const { userId, roomName } = req.body;
    if (!userId || !roomName) {
      return res.status(400).json({ error: 'userId and roomName required' });
    }

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
    res.json({ token, url: process.env.LIVEKIT_URL });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============================================================================
// PAGES
// ============================================================================

// Landing page — public, no auth required
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dashboard — requires auth
app.get('/dashboard', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

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

app.patch('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
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
// FRONTEND (careful ordering — auth-bypass prevention)
// ============================================================================

// Serve landing page assets publicly
const publicFiles = ['index.html', 'css/design-tokens.css', 'css/landing.css', 'js/landing.js'];
for (const file of publicFiles) {
  app.get(`/${file}`, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
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

initialiseAuth().then(() => {
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
});
