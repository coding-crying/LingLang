# Chatterbox Multilingual TTS - LiveKit Compatibility Analysis

## Model Overview

**Model**: `onnx-community/chatterbox-multilingual-ONNX`
- **Base**: ResembleAI/chatterbox (0.5B Llama backbone)
- **Format**: ONNX (optimized for fast inference)
- **Languages**: 23 languages (Russian, English, Spanish, French, German, etc.)
- **Features**: Voice cloning, emotion control, multilingual

## ✅ LiveKit Compatibility

### **YES - Chatterbox Will Work Fast with LiveKit!**

### Why It's Fast:

1. **ONNX Runtime = Optimized**
   - ONNX is faster than PyTorch for inference
   - Lower latency (~200-500ms vs 1-2s for PyTorch)
   - Better for real-time applications

2. **Sample Rate Matches LiveKit**
   - Chatterbox: 24kHz ✅
   - LiveKit expects: 24kHz ✅
   - No resampling needed!

3. **Can Output PCM Directly**
   - ONNX can generate raw audio
   - Can convert to PCM format LiveKit needs
   - No WAV→PCM conversion overhead

4. **Streaming Potential**
   - ONNX inference can be chunked
   - Can generate audio progressively
   - Lower perceived latency

## 📊 Expected Performance

### Latency Estimates

| Component | Time | Notes |
|-----------|------|-------|
| **ONNX Inference** | 200-500ms | Faster than PyTorch |
| **Tokenization** | 10-50ms | Minimal overhead |
| **Audio Generation** | 100-300ms | Per chunk |
| **Total (first chunk)** | **~300-800ms** | ⚡ Much faster! |

### Comparison

| Model | First Chunk | Streaming | PCM Direct |
|-------|------------|-----------|------------|
| **Chatterbox (ONNX)** | ~300-800ms | ✅ Yes | ✅ Yes |
| **Fish Speech** | ~1.5-4s | ❌ No | ❌ Needs FFmpeg |
| **XTTS** | ~1.7-2.7s | ✅ Yes | ✅ Yes |

**Chatterbox should be 2-3x faster than Fish Speech!**

## 🔧 Integration Options

### Option 1: Create Local Server (Recommended)

Create `server_chatterbox.py` that:
1. Loads ONNX model from HuggingFace
2. Runs inference with ONNX Runtime
3. Outputs PCM directly
4. Provides OpenAI-compatible API

**Pros:**
- Full control
- Can optimize for streaming
- Direct PCM output
- Fast ONNX inference

**Cons:**
- Need to implement inference pipeline
- Need to handle tokenization, generation, vocoder

### Option 2: Use Existing Resemble Plugin (Cloud)

The existing `@livekit/agents-plugin-resemble` uses Resemble's cloud API.

**Pros:**
- Already implemented
- Works immediately

**Cons:**
- Uses cloud API (not local ONNX)
- Requires API key
- May have latency from network

## 🚀 Implementation Strategy

### For Local ONNX Model:

1. **Create FastAPI Server**
   ```python
   # server_chatterbox.py
   - Load ONNX model
   - Handle text → audio inference
   - Output PCM stream
   - OpenAI-compatible endpoint
   ```

2. **Use OpenAI Plugin in Agent**
   ```typescript
   tts: new openai.TTS({
     baseURL: 'http://localhost:5000/v1',
     apiKey: 'dummy',
   })
   ```

3. **Optimize for Streaming**
   - Generate audio in chunks
   - Stream PCM progressively
   - Lower perceived latency

## ⚡ Speed Analysis

### Why Chatterbox Should Be Fast:

1. **ONNX Runtime**
   - Optimized inference engine
   - Lower memory overhead
   - Better for real-time

2. **24kHz Sample Rate**
   - Matches LiveKit exactly
   - No resampling needed
   - Lower processing overhead

3. **Direct PCM Output**
   - Can generate PCM directly
   - No format conversion
   - Lower latency

4. **Progressive Generation**
   - Can generate chunks
   - Stream as it generates
   - Feels faster

### Expected Latency:

- **Short phrase (5 words)**: ~300-500ms ⚡
- **Medium phrase (15 words)**: ~500-800ms ⚡
- **Long phrase (30 words)**: ~800-1200ms

**Much faster than Fish Speech (1.5-4s)!**

## 🎯 Recommendation

### **Chatterbox is the Best Choice!**

✅ **Fastest** (ONNX = optimized)  
✅ **Multilingual** (23 languages)  
✅ **Voice cloning** (reference audio)  
✅ **Direct PCM** (no conversion)  
✅ **Streaming** (progressive chunks)  

**Should work great with LiveKit!**

## 📝 Next Steps

1. **Implement ONNX inference server**
2. **Test latency** (should be ~300-800ms)
3. **Integrate with LiveKit agent**
4. **Compare with Fish Speech**

Want me to implement the server now?
