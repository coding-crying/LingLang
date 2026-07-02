# Fatterbox Multilingual TTS Guide

This document explains how to run and maintain the optimized **Fatterbox Multilingual** TTS service used by LingLang.

## 🚀 Overview
The current setup uses a patched version of `justinlime/fatterbox` that supports the **Chatterbox Multilingual (23 languages)** model. It includes optimizations for ultra-low latency (`cudagraphs`) and better prosody for Russian (stress markers).

- **Docker Image:** `whywillwizardry/fatterbox-multilingual:v1.0`
- **Host Port:** `8005`
- **Model:** Chatterbox Multilingual (0.5B)

---

## 🛠️ How to Start the Service

### 1. Simple Startup (Recommended)
Use the included launcher script from the `LingLang` root:
```bash
python3 start_local_services.py
```
This script automatically handles starting the container, checking its health, and following its logs.

### 2. Manual Container Recreation
If you need to recreate the container from scratch (e.g., on a new machine), use this command:

```bash
docker run -d \
  --name fatterbox-tts \
  --gpus all \
  -p 8005:8000 \
  -v lingo_fatterbox_cache:/root/.cache/huggingface \
  -v /home/will/Desktop/Lingo/Chatterbox-TTS-Server/voices:/chatter/voices \
  whywillwizardry/fatterbox-multilingual:v1.0
```

---

## 🎙️ Voice Management
Voices are mapped from your desktop directory:
`/home/will/Desktop/Lingo/Chatterbox-TTS-Server/voices`

- **To add a new voice:** Drop a `.wav` file (5-10 seconds of clear speech) into that folder.
- **To use it:** Reference the filename (without extension) in the API call or agent config.
- **Russian Note:** We are currently using a trimmed 6-second version of `Russian.wav` for better stability.

---

## 📡 API Usage
The server provides an OpenAI-compatible endpoint at `http://localhost:8005/v1/audio/speech`.

### Multilingual Features
Unlike the original Fatterbox, this version supports an explicit `language_id` to enable specialized processing:

| Language | `language_id` | Optimization |
| :--- | :--- | :--- |
| **Russian** | `ru` | Adds pitch and stress markers for natural prosody. |
| **Japanese** | `ja` | Converts Kanji to phonetic Hiragana. |
| **Chinese** | `zh` | Word segmentation and Cangjie phonetic coding. |
| **French** | `fr` | Decomposes accented characters. |

**Example Curl:**
```bash
curl -X POST http://localhost:8005/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Привет! Как дела?",
    "voice": "Russian",
    "language_id": "ru"
  }' \
  --output test.wav
```

---

## 🔄 Rebuilding/Updating
If you make further code changes inside the container:
1. Commit the changes: `docker commit fatterbox-tts whywillwizardry/fatterbox-multilingual:v1.x`
2. Push to Hub: `docker push whywillwizardry/fatterbox-multilingual:v1.x`
3. Update `FATTERBOX_IMAGE` in `start_local_services.py`.

