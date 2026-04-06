#!/usr/bin/env python3
"""
LingLang Local Stack Launcher
Services: STT (Qwen3-ASR) + TTS (MossTTS) + LiveKit Agent + Dashboard
"""
import subprocess
import time
import requests
import os
import sys
import signal
import argparse
from pathlib import Path

# --- Paths ---
HOME = Path.home()
STT_DIR = HOME / "Desktop/ASR/qwen3-asr"
STT_VENV = HOME / "Desktop/TTS/MOSS-TTS/.venv/bin/python"   # shared venv
TTS_DIR = HOME / "Desktop/TTS/MOSS-TTS/moss_tts_realtime"
TTS_VENV = HOME / "Desktop/TTS/MOSS-TTS/.venv/bin/python"
AGENT_DIR = HOME / "Desktop/LingLang/agents"

# --- Ports ---
STT_PORT = 8001
TTS_PORT = 8880
LLM_PORT = 11434
DASHBOARD_PORT = 3001

# --- Process registry ---
processes: list[tuple[str, subprocess.Popen]] = []

def cleanup(signum=None, frame=None):
    print("\nStopping services...")
    for name, proc in reversed(processes):
        if proc.poll() is None:
            print(f"  Stopping {name} (PID {proc.pid})...")
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    print("Done.")
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

def check(url, timeout=2):
    try:
        r = requests.get(url, timeout=timeout)
        return r.status_code < 500
    except:
        return False

def wait_for(name, url, max_wait=90, interval=2):
    print(f"  Waiting for {name} on {url}...", end="", flush=True)
    for i in range(0, max_wait, interval):
        if check(url):
            print(f" ready ({i}s)")
            return True
        if i > 0 and i % 20 == 0:
            print(f"\n    ... still waiting ({i}s)", end="", flush=True)
        time.sleep(interval)
    print(f" TIMEOUT after {max_wait}s")
    return False

def launch(name, cmd, log_file, cwd=None, env=None):
    log = Path(log_file)
    log.parent.mkdir(parents=True, exist_ok=True)
    merged_env = {**os.environ, **(env or {})}
    with open(log, 'w') as f:
        proc = subprocess.Popen(
            cmd,
            stdout=f,
            stderr=subprocess.STDOUT,
            cwd=str(cwd) if cwd else None,
            env=merged_env,
            preexec_fn=os.setsid,
        )
    processes.append((name, proc))
    print(f"  {name} started (PID {proc.pid}) -> {log}")
    return proc

def start_stt():
    print("\n[STT] Qwen3-ASR (port 8001)")
    # Language is passed per-request by the agent from LiveKit room metadata — no lock needed here
    launch(
        "STT",
        [str(STT_VENV), "server.py", "--model", "Qwen/Qwen3-ASR-1.7B", "--port", "8001"],
        "/tmp/stt.log",
        cwd=STT_DIR,
    )

def start_tts():
    print("\n[TTS] MossTTS (port 8880) — ~30s to load")
    launch(
        "TTS",
        [str(TTS_VENV), "openai_tts_server.py", "--port", "8880", "--device", "cuda:0"],
        "/tmp/moss.log",
        cwd=TTS_DIR,
    )

def start_agent():
    print("\n[Agent] LiveKit tutor.ts")
    launch(
        "Agent",
        ["pnpm", "dev:tutor"],
        "/tmp/tutor-live.log",
        cwd=AGENT_DIR,
    )

def start_dashboard():
    print("\n[Dashboard] port 3001")
    launch(
        "Dashboard",
        ["npx", "tsx", "src/dashboard/server.ts"],
        "/tmp/dashboard.log",
        cwd=AGENT_DIR,
    )

def main():
    parser = argparse.ArgumentParser(description="LingLang local stack")
    parser.add_argument("--no-agent", action="store_true", help="Skip starting the LiveKit agent")
    parser.add_argument("--no-dashboard", action="store_true", help="Skip starting the dashboard")
    parser.add_argument("--stt-only", action="store_true", help="Start STT only")
    parser.add_argument("--tts-only", action="store_true", help="Start TTS only")
    args = parser.parse_args()

    print("=" * 55)
    print("  LingLang Local Stack")
    print("  STT: Qwen3-ASR  |  TTS: MossTTS")
    print("  LLM: remote (NanoGPT/OpenRouter)")
    print("=" * 55)

    if args.tts_only:
        start_tts()
    elif args.stt_only:
        start_stt()
    else:
        start_stt()
        start_tts()
        if not args.no_agent:
            start_agent()
        if not args.no_dashboard:
            start_dashboard()

    # Health checks
    print("\n--- Health Checks ---")
    stt_ok = True
    tts_ok = True

    if not args.tts_only:
        stt_ok = wait_for("STT", f"http://localhost:{STT_PORT}/health", max_wait=60)
    if not args.stt_only:
        tts_ok = wait_for("TTS", f"http://localhost:{TTS_PORT}/v1/models", max_wait=90)

    # Summary
    print()
    print("=" * 55)
    status = "READY" if (stt_ok and tts_ok) else "PARTIAL (check logs)"
    print(f"  {status}")
    print()
    print(f"  STT:       http://localhost:{STT_PORT}  (Qwen3-ASR)")
    print(f"  TTS:       http://localhost:{TTS_PORT}  (MossTTS)")
    print(f"  Dashboard: http://localhost:{DASHBOARD_PORT}")
    print()
    print("  Logs:")
    print("    STT:       tail -f /tmp/stt.log")
    print("    TTS:       tail -f /tmp/moss.log")
    print("    Agent:     tail -f /tmp/tutor-live.log")
    print("    Dashboard: tail -f /tmp/dashboard.log")
    print()
    print("  Ctrl+C to stop all")
    print("=" * 55)

    # Keep alive + watch for crashes
    try:
        while True:
            time.sleep(5)
            for name, proc in processes:
                if proc.poll() is not None:
                    print(f"\n  {name} exited (code {proc.returncode}) — check logs")
    except KeyboardInterrupt:
        cleanup()

if __name__ == "__main__":
    main()
