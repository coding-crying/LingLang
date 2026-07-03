"""VoxCPM2 TTS Server — GPU, nano-vllm backend, OpenAI-compatible."""
import argparse
import struct
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI(title="VoxCPM2 TTS")

_engine = None
_model_dir: Path = Path(".")


def load_engine(gpu_util: float = 0.90, max_seqs: int = 8):
    global _engine
    if _engine is not None:
        return
    from nanovllm import LLM
    _engine = LLM(
        str(_model_dir),
        gpu_memory_utilization=gpu_util,
        max_num_seqs=max_seqs,
        enforce_eager=True,
    )


@app.get("/health")
async def health():
    return {"status": "ok", "model": "voxcpm2"}


@app.post("/v1/audio/speech")
async def synthesize(request: dict):
    text = request.get("input", "")
    # VoxCPM2 generates audio tokens via nano-vllm, then decodes to PCM
    load_engine()

    # TODO: implement actual VoxCPM2 inference pipeline
    # This is a scaffold — the real implementation needs:
    # 1. Tokenize text
    # 2. Generate audio tokens via _engine.generate()
    # 3. Decode tokens → PCM via the codec model
    # 4. Stream s16le PCM at 48kHz

    def audio_stream():
        # Placeholder — replace with actual streaming
        yield b""

    return StreamingResponse(
        audio_stream(),
        media_type="audio/pcm",
        headers={"X-Sample-Rate": "48000", "X-Format": "s16le"},
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8881)
    parser.add_argument("--gpu-memory-utilization", type=float, default=0.90)
    parser.add_argument("--max-num-seqs", type=int, default=8)
    args = parser.parse_args()
    _model_dir = args.model_dir
    load_engine(args.gpu_memory_utilization, args.max_num_seqs)
    uvicorn.run(app, host="0.0.0.0", port=args.port)
