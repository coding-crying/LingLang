// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Router } from 'express';
import { evidenceMode } from './runtime.js';
import { getEvidenceStore } from './service.js';

export function createEvidenceRouter(
  readRecent: (userId: string, language?: string) => Promise<readonly unknown[]> = (u, l) =>
    getEvidenceStore().recent(u, l),
  mode: () => 'off' | 'shadow' = evidenceMode,
): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const userId = (req as typeof req & { user?: { id: string } }).user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const language = req.query.language;
    if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language)))
      return res.status(400).json({ error: 'Invalid language' });
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const currentMode = mode();
      const events =
        currentMode === 'shadow' ? await readRecent(userId, language as string | undefined) : [];
      return res.json({
        ownerId: userId,
        mode: currentMode,
        appliedToScheduling: false,
        notice:
          'Experimental observations, not certified mastery. Legacy scheduling remains unchanged.',
        events,
      });
    } catch {
      return res.status(503).json({ error: 'Learning evidence is temporarily unavailable' });
    }
  });
  return router;
}
