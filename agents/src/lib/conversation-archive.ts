// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface ConversationEvent {
  userId: string;
  sessionId: string;
  turnId: string;
  role: 'learner' | 'tutor';
  text: string;
  language: string;
  occurredAt: string;
  source: string;
  status: 'final' | 'corrected' | 'rejected';
  interrupted: boolean | null;
  reason?: string;
  revisionOf?: string;
  modelProfile?: string;
}
export type ArchivedEvent = ConversationEvent & { id: string; capturedAt: string; version: 1 };

/** Disk acknowledgement is independent of the DB/processor. Replay is at-least-once;
 * the sink MUST deduplicate by id. Files contain text, never audio or credentials. */
export class ConversationArchive {
  private draining: Promise<{ delivered: number; pending: number }> | null = null;
  constructor(
    readonly directory: string,
    private sink: (event: ArchivedEvent) => Promise<void>,
  ) {}

  async record(event: ConversationEvent): Promise<string> {
    if (
      !event.userId ||
      !event.sessionId ||
      !event.turnId ||
      !event.text.trim() ||
      event.text.length > 50000 ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      !['learner', 'tutor'].includes(event.role) ||
      !['final', 'corrected', 'rejected'].includes(event.status)
    )
      throw new Error('Invalid conversation event');
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          event.userId,
          event.sessionId,
          event.turnId,
          event.role,
          event.text,
          event.language,
          event.status,
          event.interrupted,
          event.reason ?? null,
          event.revisionOf ?? null,
        ]),
      )
      .digest('hex');
    const row: ArchivedEvent = { ...event, id, capturedAt: new Date().toISOString(), version: 1 };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(row));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(this.directory, `${id}.json`));
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return id;
  }

  drain(): Promise<{ delivered: number; pending: number }> {
    if (!this.draining)
      this.draining = this.deliver().finally(() => {
        this.draining = null;
      });
    return this.draining;
  }
  private async deliver() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter((file) =>
      /^[a-f0-9]{64}\.json$/.test(file),
    );
    const batch: Array<{ file: string; event: ArchivedEvent }> = [];
    for (const file of files.slice(0, 500)) {
      try {
        batch.push({ file, event: JSON.parse(await readFile(join(this.directory, file), 'utf8')) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    batch.sort((a, b) => a.event.capturedAt.localeCompare(b.event.capturedAt));
    let delivered = 0;
    for (const { file, event } of batch) {
      try {
        await this.sink(event);
      } catch {
        break;
      } // Retain the entire remainder in order; retry next drain/startup.
      await unlink(join(this.directory, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      delivered++;
    }
    const pending = (await readdir(this.directory)).filter((f) => f.endsWith('.json')).length;
    return { delivered, pending };
  }
}
