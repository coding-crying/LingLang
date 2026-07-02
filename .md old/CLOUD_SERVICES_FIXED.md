# Cloud Services Integration - Fixed Implementation

> **Note**: This document has been superseded by `CLOUD_SERVICES_COMPLETE.md` which includes the correct ElevenLabs STT implementation.

## Summary of Changes

### 1. Installed Official LiveKit ElevenLabs Plugin

```bash
pnpm add @livekit/agents-plugin-elevenlabs@1.x
```

Updated all LiveKit dependencies to version 1.0.40 for compatibility.

### 2. Implemented ElevenLabs Scribe v2 Realtime STT

**NEW FILE**: `agents/src/stt/elevenlabs-realtime.ts`
- WebSocket-based real-time transcription
- ~150ms latency
- Support for 90+ languages
- Voice Activity Detection (VAD)

### 3. Updated ServiceFactory

**File**: `agents/src/services/factory.ts`

#### Cloud Mode Services:
- **STT**: OpenAI Whisper API (official API, not local)
  - ElevenLabs doesn't have an official STT plugin yet
  - Using OpenAI's `whisper-1` model
  - Requires `OPENAI_API_KEY` environment variable

- **TTS**: ElevenLabs TTS (official LiveKit plugin)
  - Using `@livekit/agents-plugin-elevenlabs`
  - Model: `eleven_turbo_v2_5`
  - Streaming latency: 3 seconds
  - Language-specific voices configured

- **LLM**: MiniMax 2.1 (custom implementation)
  - Using existing custom MiniMax integration
  - Requires `MINIMAX_API_KEY` environment variable

#### Local Mode Services:
- **STT**: Faster Whisper (port 8000)
- **TTS**: CosyVoice (port 50000)
- **LLM**: Ollama Ministral 3 14B (port 11434)

### 3. Configuration Required

**For Cloud Mode** (`.env.local`):
```env
SERVICE_MODE=cloud

# ElevenLabs (TTS)
ELEVENLABS_API_KEY=sk_8eb631ff800d51c275a9655b9069d87e2018bd597b6ff55c

# OpenAI (STT - Whisper API)
OPENAI_API_KEY=<your-openai-api-key>

# MiniMax (LLM)
MINIMAX_API_KEY=sk-cp-AQ2aioZqzO18wV5bmZoXViOY3d4UqDyfmH4K9F_zW1yVKfnb7BSckOXksd1b6RTxBaFS9y8rAHqUmx9xogdW2Zb6rp8HjZaVilBrmbKrw0egIlMukHDBlTs
```

**For Local Mode** (`.env.local`):
```env
SERVICE_MODE=local

# Local endpoints
LOCAL_STT_URL=http://localhost:8000/v1
LOCAL_LLM_URL=http://localhost:11434/v1
LOCAL_LLM_MODEL=ministral-3:14b
LOCAL_TTS_URL=http://localhost:50000
```

## Language-Specific Voices (ElevenLabs)

The ServiceFactory automatically selects appropriate voices based on the target language:

| Language | Voice ID | Voice Name | Description |
|----------|----------|------------|-------------|
| Russian (ru) | `pNInz6obpgDQGcFmaJgB` | Adam | Multilingual voice |
| Spanish (es) | `EXAVITQu4vr4xnSDxMaL` | Bella | Multilingual voice |
| French (fr) | `ThT5KcBeYPX3keUQqHPh` | Dorothy | Multilingual voice |
| Portuguese (pt) | `cgSgspJ2msm6clMCkdW9` | Jessica | Multilingual voice |
| Arabic (ar) | `pNInz6obpgDQGcFmaJgB` | Adam | Supports Arabic |
| English (en) | `pNInz6obpgDQGcFmaJgB` | Adam | Default |

## Testing

### Test Local Mode

1. Start local services:
```bash
python3 start_local_services.py
```

2. Verify all services are running:
```bash
netstat -tlnp | grep -E ":(8000|11434|50000)"
```

3. Set environment variable:
```bash
# In agents/.env.local
SERVICE_MODE=local
```

4. Run the agent:
```bash
cd agents
pnpm dev:tutor-ed
```

### Test Cloud Mode

1. Ensure you have valid API keys in `.env.local`:
   - `ELEVENLABS_API_KEY` (for TTS)
   - `OPENAI_API_KEY` (for STT)
   - `MINIMAX_API_KEY` (for LLM)

2. Set environment variable:
```bash
# In agents/.env.local
SERVICE_MODE=cloud
```

3. Stop local services (optional, to save resources):
```bash
pkill -f "start_local_services.py"
```

4. Run the agent:
```bash
cd agents
pnpm dev:tutor-ed
```

## Key Differences from Previous Implementation

### Before:
- Custom ElevenLabs TTS implementation (`agents/src/tts/elevenlabs.ts`)
- Custom ElevenLabs STT implementation (`agents/src/stt/elevenlabs.ts`)
- Manual WebSocket/streaming management
- Potential protocol mismatches with LiveKit

### After:
- Official `@livekit/agents-plugin-elevenlabs` for TTS
- Standard OpenAI STT for cloud mode (more reliable)
- LiveKit handles all protocol details automatically
- Better compatibility and future-proofing

## Next Steps

1. **Add OpenAI API Key**: You need to provide a valid `OPENAI_API_KEY` for cloud mode STT
2. **Test Both Modes**: Verify local and cloud modes work correctly
3. **Optional**: If you prefer ElevenLabs STT, we can explore their HTTP API (non-streaming)

## Sources

- [LiveKit ElevenLabs Integration](https://docs.livekit.io/agents/integrations/elevenlabs/)
- [ElevenLabs TTS Plugin Guide](https://docs.livekit.io/agents/models/tts/plugins/elevenlabs/)
- [@livekit/agents-plugin-elevenlabs on npm](https://www.npmjs.com/package/@livekit/agents-plugin-elevenlabs)
