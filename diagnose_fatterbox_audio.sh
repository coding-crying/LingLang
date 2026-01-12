#!/bin/bash
# diagnose_fatterbox_audio.sh - Quick audio quality check for Fatterbox TTS

echo "=== Fatterbox Audio Diagnosis ==="
echo ""

echo "1. Current Backend Configuration:"
docker inspect fatterbox-tts 2>/dev/null | jq -r '.[0].Config.Env[] | select(. | startswith("BACKEND"))' || echo "Container not found"

echo ""
echo "2. Generating test audio..."
curl -X POST http://localhost:8005/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"Привет! Как дела сегодня? Я тестирую аудио качество.","voice":"Russian","model":"tts-1","response_format":"wav"}' \
  --output /tmp/fatterbox_test.wav 2>/dev/null

if [ $? -eq 0 ]; then
  echo "✅ Test audio generated: /tmp/fatterbox_test.wav"
else
  echo "❌ Failed to generate test audio"
  exit 1
fi

echo ""
echo "3. Analyzing volume levels..."
ffmpeg -i /tmp/fatterbox_test.wav -af "volumedetect" -f null /dev/null 2>&1 | grep -E "(max_volume|mean_volume)" || echo "ffmpeg not found"

echo ""
echo "4. Checking for clipping..."
ASTATS=$(ffmpeg -i /tmp/fatterbox_test.wav -af "astats" -f null /dev/null 2>&1)
PEAK_COUNT=$(echo "$ASTATS" | grep "Peak count" | awk '{print $3}')
MAX_LEVEL=$(echo "$ASTATS" | grep "Peak level dB" | awk '{print $4}')

echo "Peak count: ${PEAK_COUNT:-unknown}"
echo "Max level: ${MAX_LEVEL:-unknown} dB"

if [ -n "$PEAK_COUNT" ] && [ "$PEAK_COUNT" -gt "10" ]; then
  echo "⚠️  WARNING: Significant clipping detected! ($PEAK_COUNT peaks)"
  echo "   Recommendation: Try changing CUDA backend or reducing volume"
else
  echo "✅ No major clipping detected"
fi

echo ""
echo "5. Duration and format:"
ffprobe /tmp/fatterbox_test.wav 2>&1 | grep Duration

echo ""
echo "=== Recommended Next Steps ==="
echo ""
echo "A) Listen to the test audio:"
echo "   ffplay /tmp/fatterbox_test.wav"
echo ""
echo "B) If you hear popping/peaking, try changing CUDA backend:"
echo "   docker stop fatterbox-tts"
echo "   docker run -d --name fatterbox-tts-cuda \\"
echo "     --gpus all -e BACKEND=cuda -e DEVICE=cuda \\"
echo "     -v ~/Desktop/Lingo/Chatterbox-TTS-Server/voices:/chatter/voices \\"
echo "     -p 8005:8004 whywillwizardry/fatterbox-multilingual:v1.0"
echo ""
echo "C) If still having issues, see: FATTERBOX_AUDIO_PEAKING_INVESTIGATION.md"
