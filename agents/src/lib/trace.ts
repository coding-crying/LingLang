/**
 * Structured Event Emitter for LingLang Agent
 *
 * Writes JSON lines to a shared file that the dashboard SSE endpoint tails.
 * Each event is a single JSON line: { ts, type, sessionId, data }
 * Also forwards to console.log for backward compatibility.
 *
 * Event types:
 *   user.transcript    — STT result (final or interim)
 *   agent.reply        — LLM/TTS response text
 *   agent.state_change  — idle → listening → thinking → speaking
 *   planner.start      — planner invocation begins
 *   planner.nudge      — planner output (the nudge text)
 *   planner.raw        — full planner prompt/response
 *   planner.skipped    — planner skipped (cooldown, no vocab, etc.)
 *   processor.analysis — processor output (errors, hints, SRS updates)
 *   processor.raw      — full processor prompt/response
 *   processor.error    — processor failure
 *   service.init       — STT/TTS/LLM service created
 *   services.health    — per-service health check result (startup)
 *   llm.routing        — LLM call routing decision (primary/fallback, latency, error)
 *   tts.synthesize     — TTS synthesis result (ttfb, total, cancelled)
 *   tts.error          — TTS synthesis error
 *   session.start      — session beginning
 *   session.end        — session ending
 *   session.error      — unrecoverable error
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type EventType =
  | 'user.transcript'
  | 'agent.reply'
  | 'agent.state_change'
  | 'planner.start'
  | 'planner.nudge'
  | 'planner.raw'
  | 'planner.skipped'
  | 'processor.analysis'
  | 'processor.raw'
  | 'processor.error'
  | 'service.init'
  | 'services.health'
  | 'llm.routing'
  | 'tts.synthesize'
  | 'tts.error'
  | 'session.start'
  | 'session.end'
  | 'session.error';

export interface AgentEvent {
  ts: number;
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
}

const EVENT_FILE = process.env.TUTOR_EVENTS_FILE || '/tmp/tutor-events.jsonl';
let writeStream: fs.WriteStream | null = null;
let sessionId = `sess-${randomUUID().slice(0, 8)}`;

/** Set the session ID (called when a LiveKit room is joined) */
export function setSessionId(id: string): void {
  sessionId = id;
}

/** Get the current session ID */
export function getSessionId(): string {
  return sessionId;
}

/** Ensure the write stream is open */
function getStream(): fs.WriteStream {
  if (writeStream && !writeStream.destroyed) return writeStream;

  // Ensure directory exists
  fs.mkdirSync(path.dirname(EVENT_FILE), { recursive: true });

  writeStream = fs.createWriteStream(EVENT_FILE, { flags: 'a' });
  writeStream.on('error', (err) => {
    console.error('[trace] Write stream error:', err);
    writeStream = null;
  });

  return writeStream;
}

/**
 * Emit a structured event.
 * Writes a JSON line to the events file and logs to console.
 */
export function emitEvent(type: EventType, data: Record<string, unknown>): void {
  const event: AgentEvent = {
    ts: Date.now(),
    type,
    sessionId,
    data,
  };

  // Write JSON line to shared file
  const line = JSON.stringify(event) + '\n';
  try {
    const stream = getStream();
    stream.write(line);
  } catch {
    // Fallback: just log
  }

  // Also log to console (backward compatible with /tmp/tutor-live.log)
  const detail = data.detail || data.text || data.nudge || data.reason || '';
  console.log(`[Trace] ${type}${detail ? ` ${detail}` : ''}`);
}

/**
 * Read recent events from the events file.
 * Used by the dashboard SSE endpoint.
 */
export function readRecentEvents(bytes: number = 32768): AgentEvent[] {
  try {
    const stats = fs.statSync(EVENT_FILE);
    const start = Math.max(0, stats.size - bytes);
    const buf = Buffer.alloc(stats.size - start);
    const fd = fs.openSync(EVENT_FILE, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').split('\n');
    const events: AgentEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Watch the events file for new lines (for SSE).
 * Calls callback with each parsed event, returns a cleanup function.
 */
export function watchEvents(
  onEvent: (event: AgentEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  let position = 0;

  // Start near end of file
  try {
    const stats = fs.statSync(EVENT_FILE);
    position = Math.max(0, stats.size - 32768);
  } catch {
    // File doesn't exist yet
  }

  // Send initial tail
  try {
    const events = readRecentEvents(32768);
    for (const ev of events) {
      onEvent(ev);
    }
    // Set position to end of file after sending initial events
    try {
      position = fs.statSync(EVENT_FILE).size;
    } catch { /* ignore */ }
  } catch { /* ignore */ }

  // Poll for new events (simple, works across processes)
  const interval = setInterval(() => {
    try {
      const stats = fs.statSync(EVENT_FILE);
      if (stats.size > position) {
        const length = stats.size - position;
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(EVENT_FILE, 'r');
        fs.readSync(fd, buf, 0, length, position);
        fs.closeSync(fd);

        const lines = buf.toString('utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as AgentEvent;
            onEvent(event);
          } catch {
            // skip malformed
          }
        }
        position = stats.size;
      }
    } catch (err) {
      // File might not exist yet, that's fine
    }
  }, 200);

  return () => clearInterval(interval);
}

/** Clear the events file (for fresh sessions) */
export function clearEvents(): void {
  try {
    fs.writeFileSync(EVENT_FILE, '');
  } catch { /* ignore */ }
}