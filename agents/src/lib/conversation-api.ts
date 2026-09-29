// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Router } from 'express';
import { conversationReads } from './conversation-store.js';

export function createConversationRouter(
  reads: {
    sessions: (user: string, before: string) => Promise<unknown[]>;
    events: (user: string, session: string, after: string) => Promise<unknown[]>;
    remove?: (user: string, session: string) => Promise<void>;
  } = conversationReads,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    next();
  });
  router.get('/', async (req, res) => {
    const before = req.query.before ?? '9223372036854775807';
    if (
      typeof before !== 'string' ||
      !/^\d{1,19}$/.test(before) ||
      BigInt(before) > 9223372036854775807n
    )
      return res.status(400).json({ error: 'Invalid cursor' });
    try {
      const rows = await reads.sessions(req.user!.id, before);
      const sessions = rows.slice(0, 50);
      res.json({
        sessions,
        hasMore: rows.length > 50,
        next: rows.length > 50 ? (sessions.at(-1) as { cursor: string }).cursor : null,
        notice:
          'Source transcripts, not verified mastery. Capture starts with the archive release; earlier sessions may be absent. Revisions and rejected input remain marked. No raw audio is stored here.',
      });
    } catch {
      res.status(503).json({ error: 'Conversation archive temporarily unavailable' });
    }
  });
  router.get('/:sessionId', async (req, res) => {
    const after = req.query.after ?? '0';
    if (typeof after !== 'string' || !/^\d{1,18}$/.test(after) || req.params.sessionId.length > 200)
      return res.status(400).json({ error: 'Invalid cursor or session' });
    try {
      const rows = await reads.events(req.user!.id, req.params.sessionId, after);
      const events = rows.slice(0, 500);
      res.json({
        events,
        hasMore: rows.length > 500,
        next: rows.length > 500 ? (events.at(-1) as { cursor: string }).cursor : null,
      });
    } catch {
      res.status(503).json({ error: 'Conversation archive temporarily unavailable' });
    }
  });
  router.delete('/:sessionId', async (req, res) => {
    if (req.body?.confirm !== true || req.params.sessionId.length > 200)
      return res.status(400).json({ error: 'Explicit deletion confirmation required' });
    try {
      if (!reads.remove) return res.sendStatus(503);
      await reads.remove(req.user!.id, req.params.sessionId);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: 'Deletion failed; no success acknowledged' });
    }
  });
  return router;
}
