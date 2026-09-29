// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export interface ContentSource {
  id: string;
  language: string;
  kind: string;
  title: string;
  status: string;
  ingestError?: string;
  reconciling?: boolean;
  reconcileError?: string | null;
  chunkCount: number;
  progress: number;
  isActive: boolean;
  started: boolean;
  intent: 'study' | 'known' | 'aspire' | null;
  profileStatus: 'needed' | 'complete' | 'skipped';
  needsProfile: boolean;
  pendingQuestionCount: number;
}

export const MATERIAL_KINDS: Record<string, string> = {
  textbook: 'Textbook',
  audio: 'Audio',
  youtube: 'YouTube',
  movie: 'Movie',
  text: 'Text',
};
export const PENDING_STATUSES = new Set(['uploaded', 'ingesting']);
export const MAX_MATERIAL_BYTES = 6 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;
export const MATERIAL_FILE_ACCEPT =
  '.pdf,.txt,.md,.srt,.vtt,application/pdf,text/plain,text/markdown,text/vtt';

export type UploadMaterialKind = 'textbook' | 'movie' | 'text';

export function materialFileKind(filename: string): UploadMaterialKind {
  if (/\.pdf$/i.test(filename)) return 'textbook';
  if (/\.(srt|vtt)$/i.test(filename)) return 'movie';
  return 'text';
}

export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    const path = url.pathname.split('/').filter(Boolean);
    const id =
      hostname === 'youtu.be'
        ? path[0]
        : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(
              hostname,
            )
          ? url.pathname === '/watch'
            ? url.searchParams.get('v')
            : ['shorts', 'embed'].includes(path[0])
              ? path[1]
              : null
          : null;
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
  } catch {
    return false;
  }
}

export function materialPayload(payload: {
  kind: string;
  language: string;
  ref: string;
  title?: string;
  inputType?: 'text';
}): string {
  const body = JSON.stringify(payload);
  const encoder = new TextEncoder();
  if (encoder.encode(payload.ref).byteLength > MAX_TEXT_FILE_BYTES) {
    throw new Error('This material is too large. Paste up to 5 MB of text.');
  }
  if (encoder.encode(body).byteLength > MAX_MATERIAL_BYTES) {
    throw new Error(
      'This text is too large to paste. Save it as a TXT file and upload it instead.',
    );
  }
  return body;
}

export async function readTextMaterial(file: File): Promise<string> {
  if (!/\.(txt|md|srt|vtt)$/i.test(file.name))
    throw new Error('Choose a TXT, Markdown, SRT, or VTT text file.');
  if (file.size > MAX_TEXT_FILE_BYTES)
    throw new Error('This file is too large. Choose a text or subtitle file up to 5 MB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  if (!text.trim()) throw new Error('This file is empty. Choose a file with some text.');
  if (text.includes('\0'))
    throw new Error('This file does not contain readable text. Choose a UTF-8 text file.');
  return text;
}

/** Keep the original file bytes for the upload endpoint, especially PDF and timed subtitles. */
export async function validateMaterialFile(file: File): Promise<void> {
  if (/\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF_FILE_BYTES)
      throw new Error('This PDF is too large. Choose a PDF up to 50 MB.');
    const header = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
    if (!header.includes('%PDF-'))
      throw new Error('This file is not a readable PDF. Export it as a PDF and try again.');
    return;
  }
  if (!/\.(txt|md|srt|vtt)$/i.test(file.name))
    throw new Error('Choose a PDF, TXT, Markdown, SRT, or VTT file.');
  await readTextMaterial(file);
}

export interface ContentPositionChunk {
  id: string;
  ord: number;
  parentTitle: string | null;
  title: string;
  startSec: number | null;
  endSec: number | null;
}

export function formatContentTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = String(value % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

/** Accept a clock position without silently treating 1:90 as 2:30. */
export function parseContentTime(input: string): number | null {
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(input.trim())) return null;
  const parts = input.trim().split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function contentPositionLabel(chunk: ContentPositionChunk): string {
  const title = chunk.title || `Section ${chunk.ord + 1}`;
  return chunk.startSec === null
    ? title
    : `${formatContentTime(chunk.startSec)}${chunk.endSec === null ? '' : `–${formatContentTime(chunk.endSec)}`} · ${title}`;
}
