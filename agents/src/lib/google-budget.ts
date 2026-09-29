/**
 * Per-user Google API key resolution + a soft spending cap for anyone
 * riding on the shared/admin key instead of their own.
 *
 * There's no real-time Google billing API wired in here — "usage" is an
 * ESTIMATE, accrued by the caller (agent worker, for cloud-mode session
 * duration; supervisor-functions, for utterance-grading calls) via
 * recordGoogleUsage(). The point is a cheap tripwire against a runaway
 * tester bill, not exact reconciliation with Google's invoice. Tune the
 * per-unit rates (GOOGLE_REALTIME_MICROS_PER_SECOND,
 * GOOGLE_GRADE_MICROS_PER_CALL) against actual Gemini pricing as needed.
 */
import { assertProvidersEditable, providerPolicy } from './provider-policy.js';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { encryptSecret, decryptSecret } from './crypto.js';

const DEFAULT_LIMIT_MICROS = parseInt(process.env.GOOGLE_SHARED_KEY_LIMIT_MICROS || '1000000', 10); // $1.00/period
const RESET_INTERVAL_MS = parseInt(process.env.GOOGLE_USAGE_RESET_DAYS || '30', 10) * 86400000;

export interface GoogleKeyPlan {
  /** Decrypted key to use, or null to fall back to the shared env key. */
  apiKey: string | null;
  /** True if this user has no key of their own (billing against the shared key). */
  useShared: boolean;
  limitMicros: number;
  spentMicros: number;
  remainingMicros: number;
  overBudget: boolean;
}

async function resetIfStale(userId: string, periodStart: Date): Promise<Date> {
  if (Date.now() - periodStart.getTime() < RESET_INTERVAL_MS) return periodStart;
  const now = new Date();
  await db.update(users).set({ googleUsageMicros: 0, googleUsagePeriodStart: now }).where(eq(users.id, userId));
  return now;
}

export async function getGoogleKeyPlan(userId: string): Promise<GoogleKeyPlan> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error(`getGoogleKeyPlan: user ${userId} not found`);

  if (providerPolicy() === 'user' && user.googleApiKeyEncrypted) {
    return {
      apiKey: decryptSecret(user.googleApiKeyEncrypted),
      useShared: false,
      limitMicros: Infinity,
      spentMicros: 0,
      remainingMicros: Infinity,
      overBudget: false,
    };
  }

  await resetIfStale(userId, user.googleUsagePeriodStart);
  // Re-read after a possible reset rather than threading the reset result
  // through — this path is only hit at session-start/grade-call cadence,
  // not hot enough to matter.
  const fresh = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const spentMicros = fresh?.googleUsageMicros ?? 0;
  const limitMicros = fresh?.googleUsageLimitMicros ?? DEFAULT_LIMIT_MICROS;
  const remainingMicros = Math.max(0, limitMicros - spentMicros);

  return {
    apiKey: null,
    useShared: true,
    limitMicros,
    spentMicros,
    remainingMicros,
    overBudget: spentMicros >= limitMicros,
  };
}

/** Atomic increment — safe to call concurrently from multiple agent job processes. */
export async function recordGoogleUsage(userId: string, micros: number): Promise<void> {
  if (micros <= 0) return;
  await db.update(users)
    .set({ googleUsageMicros: sql`${users.googleUsageMicros} + ${Math.round(micros)}` })
    .where(eq(users.id, userId));
}

export async function setGoogleApiKey(userId: string, apiKey: string): Promise<void> {
  assertProvidersEditable();
  await db.update(users).set({ googleApiKeyEncrypted: encryptSecret(apiKey) }).where(eq(users.id, userId));
}

export async function clearGoogleApiKey(userId: string): Promise<void> {
  assertProvidersEditable();
  await db.update(users).set({ googleApiKeyEncrypted: null }).where(eq(users.id, userId));
}
