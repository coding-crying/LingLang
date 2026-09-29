import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appShell = readFileSync(resolve(here, '../components/AppShell.tsx'), 'utf8');

assert.match(
  appShell,
  /<LibraryTab\s+userId=\{onboarding\.userId\}\s+targetLang=\{onboarding\.targetLang\}/s,
  'Library must receive the active onboarding target language',
);

console.log('library language wiring: 1 assertion passed');
