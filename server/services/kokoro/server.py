"""Kokoro v1.0 TTS Server — CPU-only, OpenAI-compatible."""
import argparse
import io
import struct
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse, JSONResponse

app = FastAPI(title="Kokoro TTS")

# Lazy-loaded model
_model = None
_voicepack = None
_model_dir: Path = Path(".")


def load_model():
    global _model, _voicepack
    if _model is not None:
        return
    from kokoro import Kokoro
    _model = Kokoro(str(_model_dir / "kokoro-v1_0.pth"))
    # Default voice
    _voicepack = _model.get_voicepack("af_bella")


@app.get("/health")
async def health():
    return {"status": "ok", "model": "kokoro-v1.0"}


@app.post("/v1/audio/speech")
async def synthesize(request: dict):
    text = request.get("input", "")
    voice = request.get("voice", "af_bella")
    response_format = request.get("response_format", "pcm")

    load_model()

    voicepack = _model.get_voicepack(voice) if voice != "af_bella" else _voicepack

    # Generate audio chunks (streaming PCM s16le)
    def audio_stream():
        for chunk in _model.stream(text, voicepack):
            # Convert float32 → s16le PCM
            pcm = struct.pack(f"<{len(chunk)}h", *[int(max(-1, min(1, s)) * 32767) for s in chunk])
            yield pcm

    if response_format == "pcm":
        return StreamingResponse(
            audio_stream(),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": "24000", "X-Format": "s16le"},
        )
    else:
        # For non-streaming, collect all chunks
        buf = io.BytesIO()
        for chunk in _model.stream(text, voicepack):
            pcm = struct.pack(f"<{len(chunk)}h", *[int(max(-1, min(1, s)) * 32767) for s in chunk])
            buf.write(pcm)
        buf.seek(0)
        return StreamingResponse(buf, media_type="audio/pcm")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8880)
    args = parser.parse_args()
    _model_dir = args.model_dir
    uvicorn.run(app, host="0.0.0.0", port=args.port)
