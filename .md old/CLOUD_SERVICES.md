# Cloud Services Configuration

LingLang supports switching between **local** and **cloud** AI services using environment variables.

---

## 🌐 Cloud Services

### ElevenLabs (STT + TTS)
- **STT**: `scribe-multilingual-v2` - Latest multilingual speech recognition
- **TTS**: `eleven_turbo_v2_5` - Fast multilingual text-to-speech
- **Languages**: Automatic voice selection per language
- **Docs**: https://elevenlabs.io/docs/api-reference

**Voice Mappings**:
- Russian (`ru`): Adam (multilingual)
- Spanish (`es`): Bella (multilingual)
- French (`fr`): Dorothy (multilingual)
- Portuguese (`pt`): Jessica (multilingual)
- Arabic (`ar`): Adam (supports Arabic)
- English (`en`): Adam (default)

### MiniMax 2.1 (LLM)
- **Model**: `MiniMax-Text-01` - Advanced language understanding
- **Features**: Multilingual, low-latency, streaming responses
- **Docs**: https://www.minimaxi.com/document/api/chat-completion

---

## 🏠 Local Services

### Faster Whisper (STT)
- **Model**: `large-v3`
- **Port**: 8000
- **VRAM**: ~3-4GB

### Ministral-3 14B (LLM)
- **Via**: Ollama
- **Port**: 11434
- **VRAM**: ~9-11GB

### CosyVoice v3 (TTS)
- **Port**: 50000
- **VRAM**: ~5-6GB
- **RTF**: 0.4-0.5 (excellent)

---

## 🔧 Configuration

### Environment Variables

Add to `agents/.env.local`:

```bash
# API Keys
ELEVENLABS_API_KEY=sk_your_elevenlabs_key
MINIMAX_API_KEY=sk-cp-your_minimax_key

# Service Mode: 'local' or 'cloud'
SERVICE_MODE=local  # Change to 'cloud' for cloud services

# Local service URLs (used when SERVICE_MODE=local)
LOCAL_STT_URL=http://localhost:8000/v1
LOCAL_LLM_URL=http://localhost:11434/v1
LOCAL_LLM_MODEL=ministral-3:14b
LOCAL_TTS_URL=http://localhost:50000
```

### Switching Modes

**Use Local Services** (default):
```bash
SERVICE_MODE=local
```

**Use Cloud Services**:
```bash
SERVICE_MODE=cloud
```

No code changes needed - just update the env var and restart the agent!

---

## 🚀 Usage

### Start with Local Services

**Terminal 1** - Start local stack:
```bash
python3 start_local_services.py
```

**Terminal 2** - Start agent:
```bash
cd agents
SERVICE_MODE=local pnpm dev:tutor-ed
```

### Start with Cloud Services

**Terminal 1** - Agent only (no local services needed):
```bash
cd agents
SERVICE_MODE=cloud pnpm dev:tutor-ed
```

That's it! No local services required when using cloud mode.

---

## 💰 Cost Comparison

### Local (One-time Hardware Cost)
- **Hardware**: NVIDIA RTX 3090 (~$1000-1500)
- **Running Cost**: Electricity only (~$5-10/month)
- **Latency**: Low (local inference)
- **Privacy**: Complete (all data stays local)

### Cloud (Pay-per-use)
- **ElevenLabs**: ~$0.30 per 1000 characters (TTS) + $0.10 per minute (STT)
- **MiniMax**: ~$0.0001 per 1000 tokens
- **Estimated**: ~$0.05-0.10 per conversation
- **Latency**: Depends on internet/API
- **Privacy**: Data sent to APIs

**Use Cases**:
- **Local**: Development, privacy-sensitive, high-volume
- **Cloud**: Demos, testing, low-volume production

---

## 📊 Service Comparison

| Feature | Local | Cloud |
|---------|-------|-------|
| **STT Quality** | Excellent (large-v3) | Excellent (ElevenLabs) |
| **TTS Quality** | Good (CosyVoice) | Excellent (ElevenLabs) |
| **TTS Latency** | Low (~1s) | Medium (~2-3s) |
| **LLM Quality** | Good (Ministral-3 14B) | Excellent (MiniMax 2.1) |
| **LLM Speed** | Fast (local) | Medium (API) |
| **Languages** | All (Whisper supports 100+) | All (ElevenLabs multilingual) |
| **Setup** | Complex (GPU required) | Simple (API keys only) |
| **Cost** | Hardware + electricity | Per-usage |
| **Privacy** | Complete | API providers |

---

## 🔍 How It Works

### Service Factory Pattern

The `ServiceFactory` class (in `agents/src/services/factory.ts`) provides a unified interface for creating services:

```typescript
const factory = new ServiceFactory({
  mode: 'cloud', // or 'local'
  targetLanguage: 'ru',
});

const stt = factory.createSTT();    // ElevenLabs or Faster Whisper
const llm = factory.createLLM();    // MiniMax or Ollama
const tts = factory.createTTS();    // ElevenLabs or CosyVoice
```

The factory automatically:
1. Reads `SERVICE_MODE` from environment
2. Creates appropriate service instances
3. Configures language-specific settings
4. Handles API keys and URLs

### Implementation Files

**Cloud Services**:
- `agents/src/stt/elevenlabs.ts` - ElevenLabs STT
- `agents/src/tts/elevenlabs.ts` - ElevenLabs TTS
- `agents/src/llm/minimax.ts` - MiniMax LLM

**Local Services**:
- `agents/src/tts/cosyvoice.ts` - CosyVoice TTS
- `agents/src/tts/chatterbox.ts` - Chatterbox TTS (alternative)
- Built-in OpenAI plugin for STT/LLM (Ollama-compatible)

**Factory**:
- `agents/src/services/factory.ts` - Service creation logic

---

## 🧪 Testing

### Test Cloud Services

```bash
cd agents
SERVICE_MODE=cloud pnpm dev:tutor-ed
```

Check the logs:
```
[ServiceFactory] Mode: cloud, Language: ru
[ServiceFactory] Using ElevenLabs STT
[ServiceFactory] Using MiniMax LLM
[ServiceFactory] Using ElevenLabs TTS
```

### Test Local Services

```bash
# Start local stack first
python3 start_local_services.py

# Then start agent
cd agents
SERVICE_MODE=local pnpm dev:tutor-ed
```

Check the logs:
```
[ServiceFactory] Mode: local, Language: ru
[ServiceFactory] Using Local STT (Faster Whisper)
[ServiceFactory] Using Local LLM (Ollama)
[ServiceFactory] Using Local TTS (CosyVoice)
```

---

## ⚠️ Troubleshooting

### Cloud Services

**ElevenLabs "Invalid API Key"**:
- Check `ELEVENLABS_API_KEY` in `.env.local`
- Verify key is active at https://elevenlabs.io/app/settings

**MiniMax "Unauthorized"**:
- Check `MINIMAX_API_KEY` in `.env.local`
- Ensure account has credits

**"Model not found"**:
- ElevenLabs: Check voice IDs are correct
- MiniMax: Verify model name is `MiniMax-Text-01`

### Local Services

**"Connection refused"**:
- Ensure `start_local_services.py` is running
- Check ports: `lsof -i :8000` (STT), `:11434` (LLM), `:50000` (TTS)

**VRAM errors**:
- Close other GPU applications
- Use smaller models (gemma3:4b instead of ministral-3:14b)

---

## 📝 Current Configuration

**Your Setup** (from `.env.local`):
- ✅ ElevenLabs API key configured
- ✅ MiniMax API key configured
- 🔧 Service mode: `local` (change to `cloud` to switch)

**To Use Cloud Services**:
1. Change `SERVICE_MODE=cloud` in `.env.local`
2. Restart agent: `pnpm dev:tutor-ed`
3. No local services needed!

**To Use Local Services**:
1. Change `SERVICE_MODE=local` in `.env.local`
2. Start: `python3 start_local_services.py`
3. Start agent: `pnpm dev:tutor-ed`
