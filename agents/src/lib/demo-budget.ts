/**
 * Global spending cap for anonymous public-demo traffic. Unlike the
 * dashboard flow, the demo has no auth and no meaningful per-user budget —
 * every visitor is a throwaway users row (createDemoUser() in demo.ts, or
 * an auto-created row for the anonymous tutor-event-driven.ts demo worker),
 * so a per-user budget like lib/google-budget.ts resets to a fresh
 * allowance for every new visitor and caps nothing in aggregate. Covers
 * two real costs: demo.ts's ElevenLabs TTS/STT fallback (used whenever
 * local OmniVoice/Qwen aren't reachable — the default for cloud-mode
 * self-hosts), and the live anonymous demo's forced Gemini-realtime mode
 * against the shared production key. Single global row, an estimate, same
 * spirit as lib/google-budget.ts: a tripwire against a runaway bill, not
 * exact reconciliation with either provider's invoice.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { demoBudget } from '../db/schema.js';

const RESET_INTERVAL_MS = parseInt(process.env.DEMO_USAGE_RESET_DAYS || '1', 10) * 86400000;
const ENV_LIMIT_MICROS = process.env.DEMO_BUDGET_LIMIT_MICROS
  ? parseInt(process.env.DEMO_BUDGET_LIMIT_MICROS, 10)
  : null;
const GLOBAL_ID = 'global';

async function ensureRow(): Promise<typeof demoBudget.$inferSelect> {
  const existing = await db.query.demoBudget.findFirst({ where: eq(demoBudget.id, GLOBAL_ID) });
  if (existing) return existing;
  const [row] = await db.insert(demoBudget).values({ id: GLOBAL_ID }).onConflictDoNothing().returning();
  return row ?? (await db.query.demoBudget.findFirst({ where: eq(demoBudget.id, GLOBAL_ID) }))!;
}

export interface DemoBudgetStatus {
  spentMicros: number;
  limitMicros: number;
  overBudget: boolean;
}

export async function getDemoBudgetStatus(): Promise<DemoBudgetStatus> {
  let row = await ensureRow();

  if (Date.now() - row.periodStart.getTime() >= RESET_INTERVAL_MS) {
    const now = new Date();
    await db.update(demoBudget).set({ spentMicros: 0, periodStart: now }).where(eq(demoBudget.id, GLOBAL_ID));
    row = { ...row, spentMicros: 0, periodStart: now };
  }

  const limitMicros = ENV_LIMIT_MICROS ?? row.limitMicros;
  return {
    spentMicros: row.spentMicros,
    limitMicros,
    overBudget: row.spentMicros >= limitMicros,
  };
}

/** Atomic increment — safe to call concurrently from multiple demo job processes. */
export async function recordDemoUsage(micros: number): Promise<void> {
  if (micros <= 0) return;
  await ensureRow();
  await db.update(demoBudget)
    .set({ spentMicros: sql`${demoBudget.spentMicros} + ${Math.round(micros)}` })
    .where(eq(demoBudget.id, GLOBAL_ID));
}
