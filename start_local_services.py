#!/usr/bin/env python3
"""
Local AI Services Launcher
Starts STT (Faster Whisper) and TTS (Chatterbox) servers for LiveKit agent
"""
import subprocess
import time
import requests
import os
import sys
import signal
from pathlib import Path

# --- Configuration ---
HOME = Path.home()
STT_DIR = HOME / "Desktop/faster-whisper-stt"
TTS_DIR = HOME / "Desktop/Lingo/Chatterbox-TTS-Server"

STT_LAUNCH = STT_DIR / "launch_stt.sh"
TTS_LAUNCH = TTS_DIR / "launch_tts.sh"

STT_PORT = 8000
TTS_PORT = 8004
LLM_PORT = 11434

STT_HEALTH = f"http://localhost:{STT_PORT}/docs"
TTS_HEALTH = f"http://localhost:{TTS_PORT}/docs"
LLM_HEALTH = f"http://localhost:{LLM_PORT}"

# --- Process Management ---
processes = []

def cleanup(signum=None, frame=None):
    """Clean shutdown of all services"""
    print("\n🛑 Stopping services...")
    for name, proc in processes:
        if proc.poll() is None:
            print(f"   Terminating {name}...")
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    print("✅ All services stopped")
    sys.exit(0)

signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

# --- Health Checks ---
def check_service(url, timeout=2):
    """Check if service responds"""
    try:
        response = requests.get(url, timeout=timeout)
        return response.status_code < 500
    except:
        return False

def wait_for_service(name, url, max_wait=60):
    """Wait for service to become healthy"""
    print(f"   ⏳ Waiting for {name}...")
    for i in range(max_wait):
        if check_service(url):
            print(f"   ✅ {name} is ready!")
            return True
        if i > 0 and i % 10 == 0:
            print(f"      ... still waiting ({i}s)")
        time.sleep(1)
    print(f"   ❌ {name} failed to start (timeout)")
    return False

# --- Service Startup ---
def start_service(name, launch_script, log_file):
    """Start a service using its launch script"""
    print(f"\n🚀 Starting {name}...")

    if not launch_script.exists():
        print(f"   ❌ Launch script not found: {launch_script}")
        return None

    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with open(log_path, 'w') as log:
        proc = subprocess.Popen(
            [str(launch_script)],
            stdout=log,
            stderr=subprocess.STDOUT,
            cwd=launch_script.parent,
            preexec_fn=os.setsid  # New process group for clean shutdown
        )

    print(f"   Started {name} (PID: {proc.pid})")
    print(f"   Logs: {log_file}")
    return proc

def main():
    """Main orchestration"""
    print("=" * 60)
    print("🎯 Local AI Services - Startup")
    print("=" * 60)

    # Check Ollama
    print("\n🔍 Checking Ollama...")
    if check_service(LLM_HEALTH):
        print(f"   ✅ Ollama running on port {LLM_PORT}")
    else:
        print(f"   ⚠️  Ollama not detected on port {LLM_PORT}")
        print("      Start it with: ollama serve")

    # Start STT
    stt_proc = start_service(
        "STT (Faster Whisper)",
        STT_LAUNCH,
        "stt_service.log"
    )
    if stt_proc:
        processes.append(("STT", stt_proc))

    # Start TTS
    tts_proc = start_service(
        "TTS (Chatterbox)",
        TTS_LAUNCH,
        "tts_service.log"
    )
    if tts_proc:
        processes.append(("TTS", tts_proc))

    # Wait for health checks
    print("\n🏥 Running health checks...")
    stt_ok = wait_for_service("STT", STT_HEALTH, max_wait=30)
    tts_ok = wait_for_service("TTS", TTS_HEALTH, max_wait=30)

    # Summary
    print("\n" + "=" * 60)
    if stt_ok and tts_ok:
        print("✨ ALL SERVICES READY ✨")
        print("\nService URLs:")
        print(f"   STT:  http://localhost:{STT_PORT}")
        print(f"   TTS:  http://localhost:{TTS_PORT}")
        print(f"   LLM:  http://localhost:{LLM_PORT}")
        print("\nLogs:")
        print(f"   STT: {Path('stt_service.log').absolute()}")
        print(f"   TTS: {Path('tts_service.log').absolute()}")
        print("\nPress Ctrl+C to stop all services")
        print("=" * 60)

        # Keep running
        try:
            while True:
                time.sleep(1)
                # Check if processes died
                for name, proc in processes:
                    if proc.poll() is not None:
                        print(f"\n⚠️  {name} exited unexpectedly!")
                        cleanup()
        except KeyboardInterrupt:
            cleanup()
    else:
        print("❌ STARTUP FAILED")
        print("\nCheck logs:")
        print(f"   STT: {Path('stt_service.log').absolute()}")
        print(f"   TTS: {Path('tts_service.log').absolute()}")
        print("=" * 60)
        cleanup()
        sys.exit(1)

if __name__ == "__main__":
    main()
