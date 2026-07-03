# llama-swap Service
Shared LLM/embedding server via llama-swap + llama.cpp.

All GGUF LLM and embedding packages route through this single service.
llama-swap handles model loading/unloading based on VRAM availability.

## Run
```bash
bash start.sh
```

## Environment
- `MODEL_DIR` — base path for GGUF models
- `SERVER_PORT` — port to bind (default: 8083)
