#!/bin/bash
# Stop all LingLang local services

echo "Stopping LingLang services..."

# Stop the launcher (sends SIGTERM → cleanup() runs)
pkill -TERM -f "start_local_services.py" 2>/dev/null

sleep 1

# Kill individual services if still running
pkill -f "qwen3-asr/server.py\|Qwen3-ASR" 2>/dev/null && echo "  Stopped STT (Qwen3-ASR)"
pkill -f "openai_tts_server.py" 2>/dev/null && echo "  Stopped TTS (MossTTS)"
pkill -f "tutor.ts" 2>/dev/null && echo "  Stopped Agent"
pkill -f "dashboard/server.ts" 2>/dev/null && echo "  Stopped Dashboard"

sleep 1

# Port status
for port in 8000 8880 3001; do
    if lsof -i :$port -t &>/dev/null; then
        echo "  WARNING: port $port still in use"
    else
        echo "  port $port free"
    fi
done

echo "Done."
