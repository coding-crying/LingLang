"""Generate llama-swap config from installed GGUF packages."""
import argparse
import yaml
from pathlib import Path


def generate_config(model_dir: Path, output: Path):
    """Scan MODEL_DIR for GGUF files and generate llama-swap config."""
    models = {}

    for gguf in model_dir.rglob("*.gguf"):
        # Determine model name from parent dir or filename
        pkg_id = gguf.parent.name
        rel_path = gguf.relative_to(model_dir)

        # Heuristic: estimate n_gpu_layers based on VRAM
        # Full offload for models that fit, partial for large ones
        size_gb = gguf.stat().st_size / (1024 ** 3)

        if size_gb > 14:
            n_gpu = 25  # Partial offload for 27B+ models
        elif size_gb > 8:
            n_gpu = 33
        else:
            n_gpu = 99  # Full offload for smaller models

        models[pkg_id] = {
            "cmd": f"llama-server -m {rel_path} --port ${PORT} -ngl {n_gpu} --host 0.0.0.0",
        }

    config = {
        "models": models,
        "default_model": list(models.keys())[0] if models else None,
    }

    with open(output, "w") as f:
        yaml.dump(config, f, default_flow_style=False)

    print(f"Generated llama-swap config with {len(models)} models → {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("config.yaml"))
    args = parser.parse_args()
    generate_config(args.model_dir, args.output)
