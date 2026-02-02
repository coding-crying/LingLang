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
import { db } from '../db/index.js';
import { users, lexemes, learningProgress, activeGoals, units, duolingoMetadata } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

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
║  URL: http://localhost:${PORT}                                ║
║  API: http://localhost:${PORT}/api/stats                      ║
╚════════════════════════════════════════════════════════════╝
  `);
});
