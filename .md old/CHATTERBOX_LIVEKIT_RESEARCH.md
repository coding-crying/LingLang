# Chatterbox Multilingual TTS - LiveKit Integration Research

## Model Information

**Model**: `onnx-community/chatterbox-multilingual-ONNX`
- **Base**: ResembleAI/chatterbox
- **Format**: ONNX (optimized for fast inference)
- **Languages**: 23 languages including Russian, English, etc.
- **Features**: Voice cloning, emotion control, multilingual

## Key Technical Details

### Inference
- Uses ONNX Runtime (fast, portable)
- Sample rate: 24kHz
- Supports voice cloning from reference audio
- Emotion/exaggeration control (0.0-1.0)

### Output Format
- Can output WAV or raw audio
- 24kHz sample rate
- Mono channel

## LiveKit Compatibility Analysis

### ✅ Advantages

1. **ONNX Runtime = Fast**
   - Optimized inference engine
   - Lower latency than PyTorch
   - Better for real-time applications

2. **Multilingual Support**
   - 23 languages including Russian
   - Automatic language detection
   - Better than Fish Speech for mixed languages

3. **Voice Cloning**
   - Supports reference audio
   - Good for consistent character voices

4. **Streaming Potential**
   - ONNX can generate chunks progressively
   - Can be adapted for streaming

### ⚠️ Challenges

1. **No Built-in API Server**
   - Need to create FastAPI server
   - Need to handle ONNX inference
   - Need to convert to PCM for LiveKit

2. **Streaming Support**
   - ONNX inference is typically batch-based
   - May need chunking strategy
   - Need to test if progressive generation works

3. **Sample Rate**
   - Chatterbox outputs 24kHz (matches LiveKit ✅)
   - But may need format conversion (WAV → PCM)

## Integration Options

### Option 1: Create Local Server (Recommended)
```python
# server_chatterbox.py
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import onnxruntime
# ... load ONNX model
# ... create OpenAI-compatible endpoint
# ... stream PCM output
```

**Pros:**
- Full control
- Can optimize for LiveKit
- Supports streaming

**Cons:**
- Need to build server
- Need to handle ONNX inference

### Option 2: Use Existing Resemble Plugin
- Current plugin uses cloud API
- Could adapt for local ONNX model
- But would need significant changes

## Performance Expectations

### Latency (Estimated)
- **ONNX Inference**: ~200-500ms (faster than PyTorch)
- **Total (with streaming)**: ~500-800ms first chunk
- **Much faster than Fish Speech!**

### Why It Should Be Fast
1. ONNX Runtime is optimized
2. Can generate chunks progressively
3. Lower memory overhead
4. Better for real-time

## Next Steps

1. **Check if ONNX model supports streaming**
2. **Create local server with OpenAI-compatible API**
3. **Test latency and streaming**
4. **Integrate with LiveKit agent**

Want me to create the server and test it?
