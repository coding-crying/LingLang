#!/bin/bash
echo "Starting LiveKit Tutor Agent..."
cd agents
# Ensure dependencies are installed if needed, but for now just run
# pnpm install # Optional: uncomment if needed
pnpm dev:tutor
