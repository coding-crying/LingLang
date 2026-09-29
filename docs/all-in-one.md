# Experimental all-in-one packaging

Not a release. Do not replace the live installation with this image yet.

Files: `Dockerfile.all-in-one`, its build-context allowlist,
`compose.all-in-one.yml`, and `deploy/all-in-one/runtime.py`.

The image combines Node/dashboard, Python/Pipecat, PostgreSQL 17 and pgvector.
The supervisor is intended to stop the container when a required child exits.
It persists generated encryption/service/ticket secrets and embedded database
files under `/data`; keep this volume and back it up. Do not rotate secrets by
changing environment values: the supervisor deliberately rejects mismatches.

Provider configuration:
- `LINGLANG_PROVIDER_POLICY=user`: learners may configure their Google key or
  individual providers through the existing profile UI.
- `LINGLANG_PROVIDER_POLICY=deployment`: provider changes are locked; use
  `SERVICE_MODE=gemini` and `GEMINI_API_KEY`, or a non-Gemini service mode with
  explicit `LINGLANG_{LLM,STT,TTS}_{URL,MODEL,API_KEY}` and `LINGLANG_TTS_VOICE`.
- Empty `DATABASE_URL` selects the owned embedded database. A nonempty value
  selects an external database, which must already have the product and voice
  schemas installed; no automatic external migration is attempted.

Validation so far:
- Compose configuration parses.
- Persistent-secret unit tests pass.
- Corrected image build completed successfully after disk space was recovered.
- Fresh unmodified image bootstrapped an isolated PostgreSQL volume; dashboard
  `/login` and Pipecat `/client/` both returned HTTP 200.
- After container restart, dashboard returned HTTP 200, persistent secrets had
  the same SHA-256, and PostgreSQL retained its cluster system identifier.
- `users`, `pipecat_sessions` and `pipecat_events` exist. This is startup/schema
  evidence, not authenticated user or learning-state persistence verification.
- Tested image: `sha256:f8cf1d26ca4a64f06bb6742a56aaded154a2464b9369aad2cbe4f14500947b0e`.
- Runtime must set `DASHBOARD_PORT`; the dashboard does not read `PORT`.

Release gates:
- Add fresh-install first-user setup and auxiliary alignment tables (startup
  currently reports missing `model_alignment_jobs`).
- Verify actual learner-data persistence, external DB mode and both provider
  policies in isolated containers.
- Resolve browser WebRTC networking: the current Compose HTTP-only port mapping
  does NOT establish a working cross-container UDP/media path. This requires
  explicit ICE/TURN/network configuration and real browser testing.
- Complete learning-event processing and a real tutor conversation test.
- Verify image contents contain no private data; publish a versioned image only
  after the release checks pass.

The frontend currently needs `npm ci --legacy-peer-deps`: its locked optional
Krisp dependency conflicts with the LiveKit React package's peer range. This
preserves the existing lockfile, but is not proof of LiveKit runtime compatibility.
