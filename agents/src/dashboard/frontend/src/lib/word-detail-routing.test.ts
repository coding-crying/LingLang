import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appShell = readFileSync(resolve(here, '../components/AppShell.tsx'), 'utf8');
const sheet = readFileSync(resolve(here, '../sheets/WordDetailSheet.tsx'), 'utf8');

assert.match(appShell, /import WordDetailSheet from '\.\.\/sheets\/WordDetailSheet';/);
assert.match(appShell, /activeSheet\?\.kind === 'wordDetail'/);
assert.match(appShell, /<WordDetailSheet[\s\S]*wordId=\{activeSheet\.wordId\}/);
assert.match(sheet, /apiFetch\(`\/api\/vocabulary\?/);
assert.match(sheet, /candidate\.id === wordId/);

console.log('word detail routing: 5 assertions passed');
