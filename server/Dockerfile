# LingLang Server — Dockerfile
# Multi-stage: base CUDA image + Python deps + server code
# Model weights downloaded at runtime via pkg_manager (NOT baked into image)

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip \
    ffmpeg git curl \
    && rm -rf /var/lib/apt/lists/*

# Python venv
RUN python3.11 -m venv /opt/linglang
ENV PATH="/opt/linglang/bin:${PATH}"

# Install Python deps
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

# Copy server code (NOT model weights)
COPY server/ /app/server/

# Models directory — populated at runtime
RUN mkdir -p /app/server/models
VOLUME /app/server/models

WORKDIR /app/server

# Default: list available packages
ENTRYPOINT ["python", "-m", "scripts.pkg_manager"]
CMD ["list"]
