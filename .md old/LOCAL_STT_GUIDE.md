# Local STT Server (Faster Whisper)

This server provides an OpenAI-compatible API for high-performance local speech-to-text using Faster Whisper.

## 🚀 How to Start

Run the specialized launch script from the project root. This script automatically handles Python 3.13 NVIDIA library paths and the virtual environment.

```bash
python3 start_local_stt.py
```

- **Port:** `8000`
- **Model:** `large-v3` (Loaded from local HuggingFace cache)
- **Logs:** Check `stt_server.log` for status and errors.

## 🛠️ How to Call

The server follows the OpenAI Audio API schema.

### 1. Using Curl
```bash
curl http://localhost:8000/v1/audio/transcriptions \
  -F "file=@test_audio_check.wav" \
  -F "model=large-v3"
```

### 2. Using OpenAI Python SDK
```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="local")

audio_file = open("test_audio_check.wav", "rb")
transcript = client.audio.transcriptions.create(
  model="large-v3", 
  file=audio_file
)
print(transcript.text)
```

## 📝 Configuration
- To change the model size (e.g., to `medium`), set the environment variable:
  `export WHISPER_MODEL=medium` before running the start script.
- The server automatically falls back to CPU if CUDA initialization fails.

```