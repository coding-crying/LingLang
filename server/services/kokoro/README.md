# Kokoro TTS Server
CPU-only English TTS. OpenAI-compatible /v1/audio/speech endpoint.

## Run
```bash
bash start.sh
```

## Environment
- `MODEL_DIR` — path to downloaded weights (set by pkg_manager)
- `SERVER_PORT` — port to bind (default: 8880)
