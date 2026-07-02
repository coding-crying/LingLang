# LingLang Project Memory

## Dashboard Web App (linglang.senilelines.com)

Express server at `agents/src/dashboard/server.ts`, served on port 8392 (nginx reverse proxy → linglang.senilelines.com).

**Pages:**
- `/` — Public landing page (marketing: "Voice-First AI Tutor", waitlist signup, 6 languages, privacy-first)
- `/login` — Cookie-based auth (scrypt hash, rate limit 10/15min/IP, 24h sessions, `ll_session` cookie HttpOnly+SameSite=Strict)
- `/dashboard` — Authenticated admin dashboard (LiveKit voice connect, SRS progress, vocabulary explorer, live logs)

**API Endpoints (public):**
- `POST /api/waitlist` — Saves email to `data/waitlist.txt`
- `POST /api/login` — Session cookie auth
- `POST /api/logout`

**API Endpoints (auth-protected):**
- `GET /api/me` — Current user
- `GET /api/users` — All users
- `GET /api/users/:id` — User + FSRS progress stats + goals (state distribution: new/learning/relearning/review)
- `GET /api/users/:id/vocabulary` — Vocabulary progress by FSRS state
- `GET /api/vocabulary/:language` — Vocabulary by language
- `PATCH /api/users/:id` — Update targetLanguage, nativeLanguage, proficiencyLevel (creates user if missing)
- `GET /api/curriculum` — Units with lexemes, filterable by language
- `GET /api/runtime` — `runtime_state.json` from LiveKit agent
- `GET /api/stats` — DB stats (user/lexeme/progress/unit counts, languages)
- `GET /api/db/:table` — Raw DB explorer (users, lexemes, progress, goals, units)
- `GET /api/services` — Health check for STT (Qwen3-ASR 8001), TTS (MossTTS 8880), LLM (Ollama 11434) + GPU VRAM + process labels
- `GET /api/activity` — Last 24h progress + goals
- `GET /api/logs` — SSE stream of tutor-live.log with secret redaction (API keys, tokens, passwords)
- `GET /api/events` — SSE stream of structured AgentEvents from `lib/trace.js`
- `POST /api/token` — LiveKit AccessToken + AgentDispatch for room join

**Frontend files:** `public/` — index.html (landing), dashboard.html, login.html, css/ (design-tokens, landing, dashboard), js/ (landing.js, dashboard.js)

**Auth:** `DASHBOARD_PASSWORD_HASH` or `DASHBOARD_PASSWORD` in `.env.local`; defaults to "admin" if unset.