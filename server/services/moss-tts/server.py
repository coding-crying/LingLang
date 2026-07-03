"""MossTTS Realtime Server — GPU, streaming PCM, OpenAI-compatible."""
import argparse
import struct
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI(title="MossTTS Realtime")

_model = None
_tokenizer = None
_model_dir: Path = Path(".")


def load_model():
    global _model, _tokenizer
    if _model is not None:
        return
    # MossTTS has two repos: the TTS model and the audio tokenizer
    tts_dir = _model_dir / "OpenMOSS-Team_MOSS-TTS-Realtime"
    tok_dir = _model_dir / "OpenMOSS-Team_MOSS-Audio-Tokenizer"

    # TODO: implement actual MOSS-TTS-Realtime loading
    # The real implementation needs:
    # 1. Load the audio tokenizer from tok_dir
    # 2. Load the TTS model from tts_dir
    # 3. Set up streaming inference pipeline
    print(f"Loading MossTTS from {tts_dir} + {tok_dir}")


@app.get("/health")
async def health():
    return {"status": "ok", "model": "moss-tts-realtime"}


@app.post("/v1/audio/speech")
async def synthesize(request: dict):
    text = request.get("input", "")
    load_model()

    # TODO: implement actual MossTTS streaming inference
    def audio_stream():
        yield b""

    return StreamingResponse(
        audio_stream(),
        media_type="audio/pcm",
        headers={"X-Sample-Rate": "24000", "X-Format": "s16le"},
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8880)
    args = parser.parse_args()
    _model_dir = args.model_dir
    uvicorn.run(app, host="0.0.0.0", port=args.port)
