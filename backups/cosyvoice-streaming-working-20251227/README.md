# CosyVoice Bidirectional Streaming - Working Setup
Date: 2025-12-27

## Files Backed Up
- `cosyvoice.ts` - LiveKit TTS plugin → `/home/will/Desktop/LingLang/agents/src/tts/cosyvoice.ts`
- `openai_server.py` - CosyVoice server → `/home/will/Desktop/cosyvoice-tts/openai_server.py`

---

## Quick Start (All 4 Services)

### Terminal 1: Ollama LLM
```bash
# Usually already running as systemd service
sudo systemctl status ollama

# If not running:
ollama serve

# Preload model (keep in VRAM for 30 min):
curl http://localhost:11434/api/generate -d '{"model": "ministral-3:14b", "keep_alive": "30m", "prompt": "hi"}'

# Verify GPU loading:
ollama ps
# Should show: ministral-3:14b ... 100% GPU
```

### Terminal 2: STT Server (Faster Whisper)
```bash
cd ~/Desktop/faster-whisper-stt
bash ./launch_stt.sh

# Logs at: ~/Desktop/faster-whisper-stt/stt_server.log
# Port: 8000
# Model: large-v3 (~4GB VRAM)
```

### Terminal 3: TTS Server (CosyVoice)
```bash
cd ~/Desktop/cosyvoice-tts
bash ./run_openai_server.sh

# Or manually:
source venv/bin/activate
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/usr/local/lib/python3.13/site-packages/nvidia/cudnn/lib
python openai_server.py --port 50000 --model_dir pretrained_models/Fun-CosyVoice3-0.5B

# Logs: visible in terminal
# Port: 50000
# WebSocket: ws://localhost:50000/v1/audio/speech/stream
# Model: Fun-CosyVoice3-0.5B (~5GB VRAM)
```

### Terminal 4: LiveKit Agent
```bash
cd ~/Desktop/LingLang/agents
pnpm dev:tutor

# Logs: visible in terminal
# Connects to LiveKit Cloud automatically
```

---

## Verify Services Running

```bash
# Check ports
ss -tlnp | grep -E "8000|11434|50000"

# Check GPU usage
nvidia-smi

# Check Ollama model in VRAM
ollama ps

# Test STT
curl http://localhost:8000/v1/audio/transcriptions -F "file=@test.wav"

# Test TTS (HTTP endpoint)
curl http://localhost:50000/v1/audio/speech -d '{"input":"Hello","voice":"Russian.wav"}' --output test.mp3
```

---

## Key Fixes Applied

### 1. cosyvoice.ts - Proper LiveKit Integration
The original implementation bypassed LiveKit's base class queue mechanism. Fixed by:
- `run()` method properly consumes from `this.input` (base class text queue)
- Forwards text chunks to CosyVoice via WebSocket
- Handles `FLUSH_SENTINEL` to send end event
- Waits for `audioComplete` promise before returning
- Puts `END_OF_STREAM` marker when done

### 2. openai_server.py - Explicit WebSocket Close
Added explicit close after audio completes:
```python
await inference_finished_event.wait()
await websocket.close()  # <-- This was missing!
logger.info("WebSocket closed after audio complete")
```
Without this, WebSocket didn't close reliably, causing the client to hang forever waiting.

---

## Architecture

```
User Speech → LiveKit → STT (port 8000) → Agent
                                            ↓
                                    LLM (port 11434)
                                            ↓
Agent → TTS WebSocket (port 50000) → LiveKit → User Hears Audio
```

WebSocket Protocol (TTS):
1. Connect: `ws://localhost:50000/v1/audio/speech/stream`
2. Send config: `{"voice": "Russian.wav", "speed": 1.0}`
3. Send text chunks: `{"text": "Привет"}`
4. Send end: `{"event": "end"}`
5. Receive: Binary PCM audio (int16, 24kHz, mono)
6. Server closes WebSocket when done

---

## VRAM Usage (RTX 3090 24GB)
- STT (Whisper large-v3): ~4GB
- TTS (CosyVoice 0.5B): ~5GB
- LLM (Ministral 14B): ~9GB
- Total: ~18GB

## Known Issues
- **RTF > 1.0**: CosyVoice generates audio slower than real-time, causing micro-stutters
- **mix_ratio [5,15]**: Model needs 5 text tokens before generating (architectural constraint)
- **GPU util 2%**: Bottleneck is model architecture (autoregressive), not GPU compute

## Troubleshooting

**Ollama loads to CPU instead of GPU:**
```bash
sudo systemctl restart ollama
curl http://localhost:11434/api/generate -d '{"model": "ministral-3:14b", "keep_alive": "30m"}'
ollama ps  # verify 100% GPU
```

**TTS WebSocket hangs:**
- Check openai_server.py has explicit `await websocket.close()` after inference
- Restart TTS server

**No audio playback:**
- Check agent logs for "playout completed"
- Verify TTS WebSocket closes (check TTS logs for "connection closed")
