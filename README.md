# LingLang: Local Multilingual Conversational Tutor

LingLang is a high-performance, memory-augmented conversational AI tutor designed for language learning. It uses a fully local AI stack integrated with **LiveKit Agents** to provide low-latency, natural voice interactions in multiple languages (currently optimized for Russian and English).

## 🚀 System Architecture

The project is split into two main parts: the **Local AI Stack** (backend models) and the **LiveKit Agent Worker** (the brain).

### 1. Local AI Stack (GPU Accelerated)
All models run locally on your hardware (optimized for NVIDIA RTX 3090/4090):
*   **LLM (Brain):** `Ministral 3 14B` (via Ollama) - Handles pedagogical reasoning and conversation.
*   **STT (Ears):** `Faster Whisper Large-v3` - Provides high-accuracy transcription of non-native speech.
*   **TTS (Voice):** `Fish Speech S1 Mini` - Generates natural, human-like speech.
*   **VAD (Mouth):** `Silero VAD` - Detects when the user starts and stops speaking.

### 2. Service Orchestration
*   **STT Server (Port 8000):** OpenAI-compatible wrapper for Faster Whisper.
*   **TTS Native (Port 7860):** The native Fish Speech API.
*   **TTS Proxy (Port 5000):** A critical low-latency proxy that converts Fish Speech output into the Raw PCM format required by LiveKit.
*   **Ollama (Port 11434):** Serves the LLM.

---

## 🛠️ Setup Instructions

### Prerequisites
*   **Hardware:** NVIDIA GPU with 24GB VRAM (for the full stack).
*   **Software:** Linux, Node.js 22+, Python 3.10+, FFmpeg.
*   **LiveKit:** A LiveKit Cloud project or a local LiveKit server.

### 1. Backend Installation
Navigate to the backend directory (`Lingo`) and install Python dependencies:
```bash
cd /home/will/Desktop/Lingo
pip install -r requirements.txt
```

### 2. Frontend/Agent Installation
Navigate to the agent directory (`LingLang/agents`) and install Node dependencies:
```bash
cd /home/will/Desktop/LingLang/agents
pnpm install
```

---

## 📦 Model Preparation

Before running the services, you must ensure the model weights are downloaded and placed in the correct directories.

### 1. LLM (Ministral 3)
Ensure Ollama is installed and updated to v0.13.1+, then pull the model:
```bash
ollama pull ministral-3:14b
```

### 2. STT (Faster Whisper)
The STT server expects the `large-v3` weights. By default, it looks in:
`/home/will/Desktop/new server/models/faster-whisper-large-v3`
If not found, it will attempt to download them to the standard cache directory.

### 3. TTS (Fish Speech)
The Fish Speech server requires the `S1-Mini` checkpoints. These should be placed in:
`/home/will/Desktop/Lingo/fish-speech/checkpoints/openaudio-s1-mini`
Ensure `model.pth`, `config.json`, and the tokenizer files are present in that folder.

---

## 🏃 Running the Project (Current Setup)

The system requires two components to be running simultaneously. Use these exact commands for your current directory structure.

### Step 1: Start Local AI Services (STT, TTS, Proxy)
This script manages the three backend Python servers and configures the required CUDA environment variables.
```bash
cd /home/will/Desktop/Lingo
python3 start_local_services.py
```
*This starts:*
- **STT:** `server_stt.py` on Port 8000
- **TTS Native:** `fish-speech/tools/api_server.py` on Port 7860
- **TTS Proxy:** `server_tts_proxy.py` on Port 5000

### Step 2: Start the LiveKit Agent (Resilient Loop)
This starts the Node.js worker in a background loop. It will automatically restart if it hits a timeout or network error.
```bash
cd /home/will/Desktop/LingLang/agents
nohup bash -c "while true; do pnpm dev:tutor >> agent_live.log 2>&1; sleep 1; done" &
```

### Step 3: Monitor the Agent
To see real-time transcriptions, agent responses, and VAD (Voice Activity Detection) events:
```bash
tail -f /home/will/Desktop/LingLang/agents/agent_live.log
```

---

## 🎓 Tutoring Features

*   **Bilingual Support:** The tutor is configured to explain complex concepts in English while conducting practice and greetings in Russian.
*   **STT Auto-Detection:** The system automatically detects the language you are speaking (Russian or English) without manual switching.
*   **Low Latency:** Uses PCM streaming and a custom proxy to minimize the "time-to-first-word" for the agent.
*   **Memory-Augmented:** Uses a local SQLite database (`tutor.db`) via Drizzle ORM to track your progress and manage curriculum goals.

## 📊 VRAM Management (RTX 3090)
*   **Ministral 3 14B:** ~10.4 GB
*   **Faster Whisper Large-v3:** ~3.4 GB
*   **Fish Speech:** ~4.8 GB
*   **Total Usage:** ~19.5 GB
*   **Headroom:** ~4.5 GB (Safe for long sessions)

---

## 🛠️ Troubleshooting

### Audio is static or noise
Ensure that the sample rate in `server_tts_proxy.py` matches the settings in `tutor.ts`. The current default is **24000Hz**.

### Identity doesn't resolve
This usually means the agent worker process died before the WebRTC connection was established. Check `agents/agent_live.log` for errors.

### LLM Tool Error
If using a smaller model (like Gemma 3 4B), ensure it supports function calling. If it doesn't, the agent will crash when trying to use the `analyzeConversationTurn` tool. `Ministral 3 14B` is the recommended model for full tool support.
