# Fatterbox Audio Peaking Investigation

## Problem
Audio output from Fatterbox has peaking/popping sounds during TTS generation.

## Findings

### Current Configuration
```bash
BACKEND=cudagraphs-manual
DEVICE=cuda
```

**Fatterbox is using CUDA graphs** - this is likely the source of audio artifacts.

### CUDA Graphs and TTS
CUDA graphs are a performance optimization that can cause audio glitches:
- Pre-compiles GPU operations for faster execution
- Can introduce timing issues with audio streaming
- Known to cause "popping" or "peaking" artifacts in TTS systems
- Trade-off: Speed vs Audio Quality

## Root Cause Analysis

### Likely Causes (in order of probability):

1. **CUDA Graphs Artifacts** (Most Likely)
   - `cudagraphs-manual` backend can cause audio discontinuities
   - Large models (like Fatterbox multilingual) more susceptible
   - Happens at chunk boundaries during streaming

2. **No Audio Normalization**
   - Raw PCM data passed through without volume control
   - Voice cloning samples might have varying loudness
   - No dynamic range compression applied

3. **Speed Parameter Interaction**
   - Speed=1.0 with CUDA graphs can cause timing issues
   - Interpolation artifacts when speeding up large models

4. **Voice Sample Quality**
   - Original Russian.wav and Portuguese.wav quality matters
   - If source has peaks, they get amplified

## Solutions (Try in Order)

### Solution 1: Change CUDA Backend (Recommended First Try)
**Try:** Switch from `cudagraphs-manual` to `cudagraphs` or `cuda`

**How to test:**
```bash
# Stop current container
docker stop fatterbox-tts

# Start with different backend
docker run -d --name fatterbox-tts-test \
  --gpus all \
  -e BACKEND=cuda \
  -e DEVICE=cuda \
  -v ~/Desktop/Lingo/Chatterbox-TTS-Server/voices:/chatter/voices \
  -p 8005:8004 \
  whywillwizardry/fatterbox-multilingual:v1.0

# Test with agent
# If works: remove old container, rename new one
```

**Backends to try (in order):**
1. `cuda` - Standard CUDA without graphs
2. `cudagraphs` - Auto CUDA graphs (might be better than manual)
3. `eager` - No optimization (slowest but cleanest audio)

### Solution 2: Add Volume/Gain Control
**Modify:** `agents/src/tts/chatterbox.ts`

Add volume parameter to API request:
```typescript
body: JSON.stringify({
  input: this.#text,
  voice: this.#opts.voice,
  model: 'tts-1',
  response_format: 'pcm',
  speed: this.#opts.speed,
  stream: true,
  chunk_size: this.#opts.chunkSize,
  language_id: this.#opts.language_id,
  // Add volume control if Fatterbox supports it
  volume: 0.8,  // 80% volume to prevent clipping
}),
```

### Solution 3: Reduce Speed
**Test:** Lower speed to reduce interpolation artifacts

In `agents/src/config/languages.ts`:
```typescript
tts: {
  voice: 'Russian',
  speed: 0.9,  // Reduce from 1.0 to 0.9
},
```

### Solution 4: Post-Process Audio
**Add normalization in ChatterboxTTS:**

```typescript
// After receiving buffer
const buffer = Buffer.from(value);

// Normalize audio to prevent peaks
const normalized = this.normalizeAudio(buffer);

for (const frame of bstream.write(normalized)) {
  // ...
}

private normalizeAudio(buffer: Buffer): Buffer {
  // Convert to 16-bit PCM samples
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);

  // Find peak
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }

  // Normalize if above threshold (e.g., 80% of max)
  const threshold = 32767 * 0.8;
  if (peak > threshold) {
    const scale = threshold / peak;
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(samples[i] * scale);
    }
  }

  return buffer;
}
```

### Solution 5: Improve Voice Samples
**Re-record voice samples with:**
- Lower input gain
- Noise gate to remove background
- Compression to even out peaks
- -3dB headroom for safety

## Testing Protocol

1. **Quick Test (2 minutes)**
   ```bash
   # Generate single phrase
   curl -X POST http://localhost:8005/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"input":"Привет! Как дела?","voice":"Russian","model":"tts-1","response_format":"wav"}' \
     --output test.wav

   # Play and listen for peaks
   ffplay test.wav

   # Check for clipping
   ffmpeg -i test.wav -af "volumedetect" -f null /dev/null 2>&1 | grep max_volume
   ```

2. **Agent Test (5 minutes)**
   - Start agent with test configuration
   - Have 5-turn conversation
   - Listen for peaks during natural speech

3. **Long Test (30 minutes)**
   - Full conversation session
   - Various sentence lengths
   - Different voices (Russian, Portuguese)

## Quick Diagnosis Script

```bash
#!/bin/bash
# diagnose_fatterbox_audio.sh

echo "=== Fatterbox Audio Diagnosis ==="
echo ""

echo "1. Current Backend:"
docker inspect fatterbox-tts | jq -r '.[0].Config.Env[] | select(. | startswith("BACKEND"))'

echo ""
echo "2. Generate test audio..."
curl -X POST http://localhost:8005/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"Testing audio quality","voice":"Russian","model":"tts-1","response_format":"wav"}' \
  --output /tmp/fatterbox_test.wav 2>/dev/null

echo "3. Analyze peaks..."
ffmpeg -i /tmp/fatterbox_test.wav -af "volumedetect" -f null /dev/null 2>&1 | grep -E "(max_volume|mean_volume)"

echo ""
echo "4. Check for clipping..."
CLIP_COUNT=$(ffmpeg -i /tmp/fatterbox_test.wav -af "astats" -f null /dev/null 2>&1 | grep "Peak count" | awk '{print $3}')
echo "Peak count: $CLIP_COUNT"

if [ "$CLIP_COUNT" -gt "10" ]; then
  echo "⚠️  WARNING: Significant clipping detected!"
else
  echo "✅ No major clipping detected"
fi

echo ""
echo "5. Play test audio to check manually:"
echo "   ffplay /tmp/fatterbox_test.wav"
```

## Recommended Action Plan

1. **Try CUDA backend change first** (5 minutes)
   - Easiest solution
   - No code changes
   - Test immediately

2. **If still peaking, reduce speed to 0.9** (2 minutes)
   - Simple config change
   - Minimal impact on UX

3. **If still peaking, add audio normalization** (30 minutes)
   - Requires code changes
   - Most robust solution

4. **Document findings and solution** (10 minutes)
   - Update SESSION_2026-01-12.md
   - Note which solution worked

## Related Issues

- **Issue:** Some users report Fatterbox "sounds robotic"
  - **Cause:** CUDA graphs can affect prosody
  - **Solution:** Same as above (change backend)

- **Issue:** First chunk sometimes pops
  - **Cause:** CUDA graph warmup
  - **Solution:** Pre-warm model or use non-graph backend

## References

- CUDA Graphs: https://developer.nvidia.com/blog/cuda-graphs/
- Audio clipping prevention: https://en.wikipedia.org/wiki/Clipping_(audio)
- Fatterbox repo: https://github.com/whywillwizardry/fatterbox-multilingual
