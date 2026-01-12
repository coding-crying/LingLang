# LingLang: Local Multilingual Conversational Tutor

LingLang is a high-performance, memory-augmented conversational AI tutor designed for language learning. It uses a fully local AI stack integrated with **LiveKit Agents** to provide low-latency, natural voice interactions.

**Current Status (Jan 2026):** Multilingual support with **Russian** and **Portuguese** (European) fully implemented. Duolingo curriculum integration with 919+ lexemes and SRS tracking.

## 🚀 System Architecture

The project is split into two main parts: the **Local AI Stack** (backend models) and the **LiveKit Agent Worker** (the brain).

### 1. Local AI Stack (GPU Accelerated)
All models run locally on your hardware (optimized for NVIDIA RTX 3090):
*   **LLM (Brain):** `ministral-3:14b` (via Ollama) - Handles conversation and pedagogy.
*   **STT (Ears):** `Faster Whisper Large-v3` - High-accuracy transcription in 100+ languages.
*   **TTS (Voice):** `Fatterbox` (multilingual Chatterbox/Piper) - Low-latency speech synthesis with voice cloning.
*   **VAD (Mouth):** `Silero VAD` - Detects user speech segments.

### 2. Service Orchestration
*   **STT Server:** Port `8000` (OpenAI-compatible).
*   **TTS Server:** Port `8005` (Fatterbox Docker container).
*   **LLM Server:** Port `11434` (Ollama).

---

## 🛠️ Setup & Usage

### Prerequisites
*   **Hardware:** NVIDIA GPU (RTX 3090 recommended for full stack).
*   **Software:** Linux, Node.js 22+, Python 3.10+, Docker.
*   **Data:** Duolingo account (optional, for personalization).

### 1. Start Local Services
This script manages the STT and TTS servers.
```bash
python3 start_local_services.py
```
*Wait for "ALL SERVICES READY" in the logs.*

### 2. Start the Agent
In a new terminal:
```bash
./start_agent.sh
```
The agent will connect to LiveKit and wait for you to join the room.

---

## 📚 Features

*   **Duolingo Sync:** Import your actual vocabulary, skills, and grammar rules.
    ```bash
    # Sync command
    npx tsx agents/src/scripts/sync-duolingo.ts <your_user_id> --jwt <your_token> --username <duo_username> --lang ru
    ```
*   **Spaced Repetition (SRS):** The agent tracks every word you speak and schedules reviews based on a Leitner system (0-5 scale).
*   **Goal-Seeking:** Automatically detects if you need remediation (weak words) or new content (next unit) and adjusts the lesson plan dynamically.
*   **Event-Driven Architecture:** Uses a specialized "Processor" loop to analyze grammar in the background without slowing down the conversation.

---

## 📊 VRAM Management (RTX 3090)
*   **Ministral-3 14B:** ~11 GB
*   **Faster Whisper Large-v3:** ~3.4 GB
*   **Fatterbox TTS:** ~5-6 GB
*   **Total Usage:** ~19-20 GB (out of 24 GB)
*   **Note:** Services are loaded sequentially - TTS loads first, then LLM takes available memory.

---

## 📁 Repository Structure

- **`agents/`**: The LiveKit Agent implementation (Node.js/TypeScript).
- **`agents/src/tutor-event-driven.ts`**: Main entry point for the optimized agent.
- **`agents/src/db/`**: SQLite schema and migrations (`tutor.db`).
- **`local_services/`**: Python scripts and Docker configs for the backend.

---

## 🛠️ Troubleshooting

### STT fails to start
Ensure `nvidia-cudnn-cu12` libraries are in your path. The `launch_stt.sh` script handles this automatically for the virtual environment.

### TTS is silent
Check if the Docker container is running:
```bash
docker ps | grep fatterbox
```
If not, start it: `docker start fatterbox-tts`.

### Agent disconnects
Check `agents/.env.local` to ensure `LOCAL_STT_URL` and `LOCAL_TTS_URL` match the running services.
