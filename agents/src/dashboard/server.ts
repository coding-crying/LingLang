/**
 * LingLang Dashboard Server
 *
 * Simple web dashboard to:
 * - View user progress (SRS levels)
 * - Monitor active goals
 * - Import Duolingo data
 * - View real-time session stats
 */

import express from 'express';
import fs from 'node:fs';
import { db } from '../db/index.js';
import { users, lexemes, learningProgress, activeGoals, units, duolingoMetadata } from '../db/schema.js';
import { eq, desc, sql, gte } from 'drizzle-orm';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');

app.use(express.json());

// Serve static files LAST so API routes take precedence
// app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// API ENDPOINTS
// ============================================================================

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
    const progress = await db.query.learningProgress.findMany({
      where: eq(learningProgress.userId, userId),
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

    // Calculate stats
    const srsDistribution = {
      level0: 0,
      level1: 0,
      level2: 0,
      level3: 0,
      level4: 0,
      level5: 0,
    };

    for (const p of progress) {
      const level = p.srsLevel;
      if (level >= 0 && level <= 5) {
        srsDistribution[`level${level}` as keyof typeof srsDistribution]++;
      }
    }

    res.json({
      user,
      progress,
      goals,
      duolingoData: duoData,
      stats: {
        totalVocab: progress.length,
        srsDistribution,
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
    const { srsLevel, limit = '100' } = req.query;

    let progress = await db.query.learningProgress.findMany({
      where: eq(learningProgress.userId, userId),
      with: { lexeme: true },
      orderBy: [desc(learningProgress.lastSeen)],
      limit: parseInt(limit as string),
    });

    // Filter by SRS level if specified
    if (srsLevel !== undefined) {
      progress = progress.filter(p => p.srsLevel === parseInt(srsLevel as string));
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

    // Run the sync script
    const scriptPath = path.join(__dirname, '../scripts/sync-duolingo.ts');
    const command = `npx tsx ${scriptPath} ${userId} --jwt "${jwt}" --username "${username}" --lang ${language}`;

    console.log('[Dashboard] Running Duolingo import...');

    const output = execSync(command, {
      encoding: 'utf-8',
      cwd: path.join(__dirname, '../../'),
      timeout: 60000, // 60 second timeout
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
      .from(learningProgress);

    const unitCount = await db.select({ count: sql<number>`count(*)` })
      .from(units);

    // Get languages
    const languages = await db.selectDistinct({ language: units.language })
      .from(units);

    res.json({
      users: userCount[0].count,
      lexemes: lexemeCount[0].count,
      progressEntries: progressCount[0].count,
      units: unitCount[0].count,
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
    else if (table === 'progress') data = await db.query.learningProgress.findMany({ limit: 100 });
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
    const gpuInfo = execSync('nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv,noheader,nounits 2>/dev/null').toString().trim();
    const [used, free, total] = gpuInfo.split(',').map((s: string) => parseInt(s.trim()));
    const appsRaw = execSync('nvidia-smi --query-compute-apps=pid,used_memory,name --format=csv,noheader 2>/dev/null').toString().trim();
    // Label processes by reading their cmdline
    const processes = appsRaw ? appsRaw.split('\n').filter(Boolean).map(line => {
      const parts = line.split(',').map((s: string) => s.trim());
      const pid = parts[0];
      const memoryMiB = parseInt(parts[1]);
      let label = parts[2]?.split('/').pop() ?? parts[2];
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
    const since = Date.now() - 86400000; // last 24 hours

    const recentProgress = await db.query.learningProgress.findMany({
      where: gte(learningProgress.lastSeen, since),
      with: { lexeme: true },
      orderBy: [desc(learningProgress.lastSeen)],
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
// LIVE LOG STREAM (SSE)
// ============================================================================

app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const logFile = process.env.TUTOR_LOG || '/tmp/tutor-live.log';
  let position = 0;

  // Start near end of file so we get recent context
  try {
    const stats = fs.statSync(logFile);
    position = Math.max(0, stats.size - 8192);
  } catch {}

  const sendLine = (line: string) => {
    const clean = line.replace(/\x00/g, '').trim();
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
// FRONTEND
// ============================================================================

// Serve static files AFTER API routes
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              LingLang Dashboard Server                     ║
╠════════════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}                               ║
║  API: http://localhost:${PORT}/api/services                  ║
╚════════════════════════════════════════════════════════════╝
  `);
});
