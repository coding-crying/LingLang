# MossTTS Realtime Server
GPU multilingual TTS (zh/en/multi). OpenAI-compatible /v1/audio/speech endpoint.

## Run
```bash
bash start.sh
```

## Environment
- `MODEL_DIR` — path to downloaded weights (contains MOSS-TTS-Realtime + MOSS-Audio-Tokenizer)
- `SERVER_PORT` — port to bind (default: 8880)
