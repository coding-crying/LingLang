/**
 * Weekly readout on the core learning loop.
 *
 * Run:  npx tsx src/scripts/learning-loop-report.ts
 *
 * Answers the question nobody was asking: are learners actually receiving
 * new material? A learner whose frontier has latched into 'consolidate' gets
 * no new vocabulary, and that state produces no error, no failed request and
 * no log line — it is only visible by counting.
 *
 * The inputs are gathered the way learner-view.ts gathers them, and the
 * classification is done by the production frontier function, so this report
 * describes the running system rather than a model of it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { summarizeLearningLoop, type LoopSample } from '../lib/learning-loop-readout.js';

/** learner-view.ts: fewer than this many logs means "not enough to judge". */
const MIN_LOGS_FOR_SUCCESS_RATE = 5;

async function main(): Promise<void> {
  // One row per user+language. Backlog is language-scoped (a Russian learner
  // should not be throttled by their Portuguese queue); recentSuccess is
  // per-user, matching learner-view's own reviewLogs query, which does not
  // filter by language either.
  const backlogRows = await db.execute(sql`
    SELECT uv.user_id, l.language,
           COUNT(*) FILTER (WHERE uv.due <= NOW())::int AS due_backlog
    FROM user_vocabulary uv
    JOIN lexemes l ON l.id = uv.lexeme_id
    GROUP BY 1, 2
  `);

  const successRows = await db.execute(sql`
    SELECT user_id,
           COUNT(*)::int AS logs,
           AVG(CASE WHEN grade >= 3 THEN 1.0 ELSE 0.0 END) AS success
    FROM (
      SELECT user_id, grade,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY review_date DESC) AS rn
      FROM review_logs
    ) recent
    WHERE rn <= 20
    GROUP BY user_id
  `);

  const successByUser = new Map<string, number | null>();
  for (const r of successRows as unknown as { user_id: string; logs: number; success: string }[]) {
    successByUser.set(r.user_id, r.logs >= MIN_LOGS_FOR_SUCCESS_RATE ? Number(r.success) : null);
  }

  const samples: LoopSample[] = (
    backlogRows as unknown as { user_id: string; language: string; due_backlog: number }[]
  ).map((r) => ({
    userId: r.user_id,
    language: r.language,
    dueBacklog: r.due_backlog,
    recentSuccess: successByUser.get(r.user_id) ?? null,
  }));

  const readout = summarizeLearningLoop(samples);

  const [curriculum] = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int  AS active_chunks,
      COUNT(*) FILTER (WHERE status = 'done')::int    AS done_chunks,
      COUNT(*) FILTER (WHERE completed_at > NOW() - INTERVAL '7 days')::int AS advanced_this_week,
      COALESCE(ROUND(AVG(coverage) FILTER (WHERE status = 'active')::numeric, 3), 0) AS avg_active_coverage
    FROM user_content_progress
  `)) as unknown as {
    active_chunks: number;
    done_chunks: number;
    advanced_this_week: number;
    avg_active_coverage: string;
  }[];

  const [seeded] = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE origin = 'seeded')::int              AS seeded_rows,
      COUNT(*) FILTER (WHERE origin = 'seeded' AND reps = 0)::int AS unverified_claims
    FROM user_vocabulary
  `)) as unknown as { seeded_rows: number; unverified_claims: number }[];

  const pct = (n: number) => (readout.pairs === 0 ? '0.0' : ((n / readout.pairs) * 100).toFixed(1));

  console.log('\n=== Learning loop readout ===\n');
  console.log(`user+language pairs      ${readout.pairs}`);
  console.log(`  consolidate (no new)   ${readout.byState.consolidate}  (${pct(readout.byState.consolidate)}%)  <- receiving zero new vocabulary`);
  console.log(`  balance                ${readout.byState.balance}  (${pct(readout.byState.balance)}%)`);
  console.log(`  expand                 ${readout.byState.expand}  (${pct(readout.byState.expand)}%)`);
  console.log(`\ndue backlog  median ${readout.medianBacklog}   p90 ${readout.p90Backlog}   (consolidate threshold is 15)`);
  console.log('\n--- curriculum ---');
  console.log(`active chunks            ${curriculum?.active_chunks ?? 0}`);
  console.log(`done chunks              ${curriculum?.done_chunks ?? 0}`);
  console.log(`advanced in last 7 days  ${curriculum?.advanced_this_week ?? 0}`);
  console.log(`avg coverage (active)    ${curriculum?.avg_active_coverage ?? 0}`);
  console.log('\n--- provenance ---');
  console.log(`seeded vocab rows        ${seeded?.seeded_rows ?? 0}`);
  console.log(`unverified claims        ${seeded?.unverified_claims ?? 0}  (reps = 0)`);

  if (readout.throttledPct >= 25) {
    console.log(
      `\n!! ${readout.throttledPct}% of pairs are throttled. Above ~25% this is systemic, not a few keen learners with big queues.`,
    );
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
