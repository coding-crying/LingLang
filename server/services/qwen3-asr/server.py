"""Qwen3-ASR Server — GPU, OpenAI-compatible /v1/audio/transcriptions."""
import argparse
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse

app = FastAPI(title="Qwen3-ASR")

_model = None
_processor = None
_model_dir: Path = Path(".")


def load_model():
    global _model, _processor
    if _model is not None:
        return
    from transformers import AutoModelForCausalLM, AutoProcessor
    _processor = AutoProcessor.from_pretrained(str(_model_dir))
    _model = AutoModelForCausalLM.from_pretrained(str(_model_dir), device_map="auto")


@app.get("/health")
async def health():
    return {"status": "ok", "model": "qwen3-asr"}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    load_model()
    # Save uploaded audio to temp file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    # TODO: implement actual Qwen3-ASR transcription
    # The real implementation needs the qwen3-asr inference pipeline
    return JSONResponse({"text": "", "language": "unknown"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    _model_dir = args.model_dir
    uvicorn.run(app, host="0.0.0.0", port=args.port)
