# LingLang voice service (Pipecat)

## Current direction and status

Follow the [Pipecat Product and Image Migration plan](../docs/plans/2026-09-25-pipecat-product-migration.md). The [historical brief](../PIPECAT_MIGRATION.md) preserves prior failures; it is not the current execution plan.

**Target:** one Pipecat pipeline with hosted LiveKit and default standalone SmallWebRTC adapters. Transport is selected at session creation, not seamlessly replaced during a live call. LiveKit mode needs a LiveKit server; SmallWebRTC does not, but still needs signaling, HTTPS and appropriate ICE/STUN/TURN networking.

**Present implementation:** separate development probes, not the full migrated tutor:

- `bot.py`: LiveKit audio probe with a minimal prompt and optional five-tool Node bridge.
- `smallwebrtc_bot.py`: minimal SmallWebRTC browser probe, without learner identity, tools or durable learning writes.
- `internal_api.py`: existing Node service client, not a complete authenticated session/lifecycle contract.
- `../Dockerfile.voice-py`: SmallWebRTC-only probe image. The proposed unified dual-transport product image and `VOICE_TRANSPORT` configuration are not implemented yet.

LAN browser/microphone testing has occurred, but recognition/turn-taking reliability and full agent parity remain unresolved. HTTP health or a successful image build does not establish voice acceptance or release readiness. The legacy Node voice path remains the production/rollback path.

## Preserving the agent engineering

Pipecat owns audio, provider streaming and transport orchestration. TypeScript remains authoritative for prompts, persona/preferences, learner context, curriculum, planner, processor, evidence/SRS, archive, summaries and usage/lifecycle.

The actual live planner and lifecycle still reside partly in `agents/src/tutor-event-driven.ts`. Calling the existing `/internal/supervisor` endpoint or enabling the vocabulary tools does **not** transfer that whole behavior. The current plan requires tested extraction and an authenticated, durable session/event boundary before enabling full product writes.

The intended release consists of matching app and voice images plus PostgreSQL and deployment networking. The current voice probe alone is not a self-contained LingLang installation. Both supported transports must pass agent-transfer and downstream dashboard-readback tests.

## Run development probes

From `voice-py/`:

```bash
uv venv --python 3.13
uv pip install --python .venv/bin/python -e .
cp .env.example .env.local
# Edit .env.local with the required runtime configuration; never commit it.
```

### LiveKit probe

Requires LiveKit connection credentials and a Gemini provider key:

```bash
.venv/bin/python bot.py --room my-room
# Optional: --server-vad to leave Gemini activity detection enabled.
# Optional: --user-id <fixture-user-id> to bind the read-only tool bridge.
```

Use only an authorized fixture account for this development CLI. `--user-id` is not the planned browser authentication mechanism.

### SmallWebRTC probe

Requires a Gemini provider key, but no LiveKit credentials:

```bash
.venv/bin/python smallwebrtc_bot.py --transport webrtc --host 0.0.0.0 --port 7860
# Open http://localhost:7860/client/ on the same machine.
```

The runner serves `/client/` and the offer endpoint. For LAN/remote browsers, use HTTPS and explicitly allow the exact browser origin with `--allowed-origins`. Plain HTTP on a LAN IP can suppress microphone/WebRTC support even when localhost works. Test NAT traversal and forced TURN separately from HTTP access.

SmallWebRTC uses a different A/B switch from `bot.py`:

```bash
PIPECAT_SERVER_VAD=1 .venv/bin/python smallwebrtc_bot.py --transport webrtc --host 0.0.0.0 --port 7860
```

The default is local Silero-driven activity boundaries with Gemini automatic detection disabled. `PIPECAT_SERVER_VAD=1` leaves Gemini automatic detection enabled; local Silero remains configured in the aggregator. This is not a pure removal of all local VAD behavior. The probe's current startup log still says server VAD is disabled regardless of the flag; do not use that line as proof of the effective mode.

## Container probe

From repository root:

```bash
docker build -f Dockerfile.voice-py -t linglang-voice:smallwebrtc .
# Runtime env file must supply the provider key; do not bake it into the image.
docker run --rm -p 127.0.0.1:7860:7860 \
  --env-file voice-py/.env.local linglang-voice:smallwebrtc
```

This is a local source-build probe, not a published pull-only product release. Its requirements intentionally omit the LiveKit runtime. Do not expect to select LiveKit merely by changing an environment variable in this image. The current healthcheck tests `/client/`, not Node lifecycle readiness or a successful conversation.

## Turn-control invariants

When `GeminiVADParams(disabled=True)` is used, retain a working local activity-start/end path. Removing the local analyzer without a replacement can make the model never reply; see the historical failure and revert (`3afd1a9`, `afb1ea6`).

Retain the initial `LLMRunFrame` context kickoff before accepting realtime input. Diagnose quiet input, audio capture, segmentation and ASR separately; changing transport or lowering VAD thresholds is not proof of better recognition.

## Tools and internal API

The LiveKit probe can enable five read-only vocabulary tools: `lookup_lexeme`, `get_due_reviews`, `get_vocab_overview`, `get_semantic_neighbors`, `get_active_goals`. Without a fixture user ID it runs toolless. These tools are not currently enabled in the SmallWebRTC probe.

Tool descriptions mirror the Node definitions. Run the parity check after editing them:

```bash
.venv/bin/python check_tool_parity.py
```

The Node `/internal` API requires a service token and defaults to loopback-only access. Separate containers require deliberately configured authenticated private access; never expose the service token to the browser or publish `/internal` through the public proxy. Follow the current migration plan for scoped sessions, durable event acceptance and safe retry behavior before adding learner writes.

Licensed **AGPL-3.0-or-later**, matching `../agents`.
