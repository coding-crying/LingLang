# AGENTS.md — LiveKit Agents JS

## Build / Lint / Test Commands

### Root commands (run from repo root)
```bash
pnpm build              # Build all packages (turbo)
pnpm build:agents       # Build agents + dependencies only
pnpm build:plugins      # Build all plugins + dependencies only
pnpm lint               # Lint all packages via turbo
pnpm lint:fix           # Lint with auto-fix
pnpm format:check       # Prettier check
pnpm format:write       # Prettier write
pnpm test               # Run all vitest tests
pnpm test:watch         # Vitest in watch mode
```

### Running a single test
```bash
# Run a specific test file
pnpm vitest run path/to/file.test.ts

# Run tests matching a pattern
pnpm vitest run -t "pattern"

# Run tests in a specific package
pnpm vitest run --project nodejs plugins/cartesia/src/tts.test.ts
```

### Per-package commands
```bash
cd agents && pnpm build          # Build agents package only
cd plugins/cartesia && pnpm lint # Lint a single plugin
```

### Build after changes
Always run `pnpm build` before testing — tsup compiles TypeScript to dist/.

## Code Style

### Formatting (Prettier)
- Single quotes, semicolons required
- Trailing commas: all
- Tab width: 2, print width: 100
- Import order: third-party modules first, then relative imports (sorted)

### TypeScript
- Strict mode enabled, `verbatimModuleSyntax: true`
- `noUncheckedIndexedAccess: true` — always handle `undefined` on indexed access
- Module system: Node16/NodeNext (ESM with CJS output via tsup)
- Use `@ts-expect-error` over `@ts-ignore` with explanation
- Avoid `any` — use `unknown` or proper types

### Imports
- Use consistent type imports: `import type { Foo } from '...'`
- Third-party imports before relative/local imports
- Use workspace refs: `@livekit/agents`, `@livekit/agents-plugin-*`
- Node builtins: `import { X } from 'node:module'`

### Naming conventions
- Classes: PascalCase (`Agent`, `STT`, `TTS`)
- Functions/variables: camelCase
- Constants: UPPER_SNAKE_CASE
- Private fields: `#private` or `_private` prefix
- Test files: `*.test.ts` alongside source

### Error handling
- Use typed errors; throw with descriptive messages
- Log errors via the project's pino logger (`import { log } from '@livekit/agents'`)
- Never swallow errors silently — at minimum log them

### License header
Every new file must start with:
```
// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
```

### ESLint rules
- `@typescript-eslint/no-unused-vars`: prefix unused with `_`
- `tsdoc/syntax`: warn on invalid TSDoc
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/consistent-type-imports`: warn

## Project Structure
- `agents/` — Core framework package (`@livekit/agents`)
- `plugins/` — Provider plugins (cartesia, deepgram, openai, etc.)
- `examples/` — Example agent implementations
- Each package has its own `tsconfig.json` extending root, `tsup.config.ts`, and `package.json`

## Development Notes
- Package manager: pnpm 9.7.0 (workspace monorepo)
- Bundler: tsup (outputs ESM + CJS)
- Test runner: vitest (node environment, 60s timeout)
- API compatibility: checked via `@microsoft/api-extractor`
- Env vars: many provider keys in `turbo.json` globalEnv — set in `.env`
