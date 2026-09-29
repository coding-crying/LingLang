import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const supervisor = readFileSync(resolve(here, '../tools/supervisor-functions.ts'), 'utf8');
const tutor = readFileSync(resolve(here, '../tutor-event-driven.ts'), 'utf8');

assert.match(supervisor, /targetLanguage\?: string/);
assert.match(supervisor, /nativeLanguage\?: string/);
assert.match(supervisor, /targetIso\?: string/);
assert.match(supervisor, /nativeIso\?: string/);
assert.match(
  supervisor,
  /let targetLanguage = options\.targetLanguage \?\? 'Russian'/,
  'Processor must prefer explicit session language identity over placeholder defaults',
);
assert.match(
  supervisor,
  /if \(\s*!options\.targetLanguage\s*\|\|\s*!options\.nativeLanguage\s*\|\|\s*!options\.targetIso\s*\|\|\s*!options\.nativeIso\s*\)/s,
  'DB lookup remains available for offline callers that omit identity',
);

const processorCall = tutor.slice(tutor.indexOf('return runProcessor(userId'));
assert.match(processorCall, /targetLanguage: langConfig\.name/);
assert.match(processorCall, /nativeLanguage: usersNativeLanguage/);
assert.match(processorCall, /targetIso: targetLang/);
assert.match(processorCall, /nativeIso: user\.nativeLanguage \|\| 'en'/);
console.log('processor language identity: 8 assertions passed');
