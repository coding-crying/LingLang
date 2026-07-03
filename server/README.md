# LingLang Server

Self-hosted model server for LingLang. Downloads model weights from HuggingFace at setup time, runs dedicated streaming servers per model.

## Structure

```
server/
├── packages/           # YAML package definitions (download specs + server config)
│   ├── tts/            # TTS packages (kokoro, voxcpm2, moss-tts, qwen3-tts)
│   ├── stt/            # STT packages (qwen3-asr, moonshine)
│   ├── llm/            # LLM packages (gemma3-27b, gemma4-26b-moe)
│   └── embed/          # Embedding packages (bge-m3)
├── services/           # One dir per model server (code + start script)
│   ├── kokoro/         # CPU English TTS
│   ├── voxcpm2/        # GPU Chinese/English TTS
│   ├── moss-tts/       # GPU multilingual TTS
│   ├── qwen3-asr/      # GPU multilingual ASR
│   └── llama-swap/     # Shared LLM/embedding server
├── models/             # Downloaded weights (gitignored, populated at runtime)
├── scripts/
│   └── pkg_manager.py  # Download + lifecycle manager
├── Dockerfile
└── docker-compose.yml
```

## Quick Start

```bash
# List available packages
python -m server.scripts.pkg_manager list

# Download a package (weights from HuggingFace)
python -m server.scripts.pkg_manager download kokoro-v1.0

# Start a service
python -m server.scripts.pkg_manager start kokoro-v1.0

# Stop a service
python -m server.scripts.pkg_manager stop kokoro-v1.0
```

## Wan2GP Pattern

Like Wan2GP, each model "family" has:
- **Package YAML** declaring `download.repo_id` + `download.files` → what to fetch from HuggingFace
- **Service dir** with server code + `start.sh` → how to serve it
- **models/ dir** (gitignored) → where `huggingface_hub.snapshot_download()` puts weights

The package manager (`pkg_manager`) is the equivalent of Wan2GP's `process_files_def()` — it reads the YAML specs, calls `huggingface_hub` to download, then manages service lifecycle.

## Docker

```bash
# Build
docker build -t linglang-server -f server/Dockerfile .

# Run with GPU
docker run --gpus all -v ~/.linglang/models:/app/server/models linglang-server download kokoro-v1.0
docker run --gpus all -v ~/.linglang/models:/app/server/models -p 8880:8880 linglang-server start kokoro-v1.0
```
