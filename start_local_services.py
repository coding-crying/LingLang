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

# Load environment from .env.local if it exists
ENV_FILE = Path(__file__).parent / "agents" / ".env.local"
if ENV_FILE.exists():
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())

# --- Configuration ---
HOME = Path.home()
STT_DIR = HOME / "Desktop/faster-whisper-stt"
TTS_DIR = HOME / "Desktop/Lingo/Chatterbox-TTS-Server"

STT_LAUNCH = STT_DIR / "launch_stt.sh"

STT_PORT = 8000
TTS_PORT = 8005
LLM_PORT = 11434

STT_HEALTH = f"http://localhost:{STT_PORT}/docs"
TTS_HEALTH = f"http://localhost:{TTS_PORT}/docs"
LLM_HEALTH = f"http://localhost:{LLM_PORT}"

FATTERBOX_CONTAINER = "fatterbox-tts"
FATTERBOX_IMAGE = "whywillwizardry/fatterbox-multilingual:v1.0"

# --- Process Management ---
processes = []

def cleanup(signum=None, frame=None):
    """Clean shutdown of all services"""
    print("\n🛑 Stopping services...")
    
    # Stop Docker container
    print(f"   Stopping {FATTERBOX_CONTAINER}...")
    subprocess.run(["docker", "stop", FATTERBOX_CONTAINER], stderr=subprocess.DEVNULL)

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

    # Wait a bit to see if it immediately fails
    time.sleep(2)
    # Note: We don't check poll() here because some scripts (like STT) might spawn and exit.
    # The health check later will confirm if it worked.

    print(f"   Started {name} (PID: {proc.pid})")
    print(f"   Logs: {log_file}")
    return proc

def start_fatterbox(log_file):
    """Start Fatterbox Docker container and stream logs"""
    print(f"\n🚀 Starting Fatterbox (Image: {FATTERBOX_IMAGE})...")

    # Check if container exists, if not, we would need a 'docker run' command.
    # For now, we assume the container exists but use the image name in logs for clarity.
    try:
        # Check if container exists
        result = subprocess.run(["docker", "ps", "-a", "--filter", f"name={FATTERBOX_CONTAINER}", "--format", "{{.Names}}"], capture_output=True, text=True)
        
        if FATTERBOX_CONTAINER not in result.stdout:
            print(f"   ⚠️  Container {FATTERBOX_CONTAINER} not found. You may need to run it first with your specific mounts.")
            return None

        subprocess.run(["docker", "start", FATTERBOX_CONTAINER], check=True, stdout=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        print(f"   ❌ Failed to start docker container: {FATTERBOX_CONTAINER}")
        return None

    # Follow logs
    log_path = Path(log_file)
    with open(log_path, 'w') as log:
        proc = subprocess.Popen(
            ["docker", "logs", "-f", FATTERBOX_CONTAINER],
            stdout=log,
            stderr=subprocess.STDOUT,
            preexec_fn=os.setsid
        )
    
    print(f"   Started Fatterbox (Container Running)")
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

    # Start TTS (Fatterbox)
    tts_proc = start_fatterbox("tts_service.log")
    if tts_proc:
        processes.append(("TTS (Log Stream)", tts_proc))

    # Wait for health checks
    print("\n🏥 Running health checks...")
    stt_ok = wait_for_service("STT", STT_HEALTH, max_wait=30)
    tts_ok = wait_for_service("TTS", TTS_HEALTH, max_wait=30)

    # Pre-warm LLM model
    llm_ok = True
    if check_service(LLM_HEALTH):
        llm_model = os.getenv("LOCAL_LLM_MODEL", "ministral-3:14b")
        print(f"\n🔥 Pre-warming LLM model: {llm_model}...")
        try:
            response = requests.post(
                f"http://localhost:{LLM_PORT}/api/generate",
                json={
                    "model": llm_model,
                    "prompt": "Ready",
                    "stream": False,
                    "keep_alive": "60m"  # Keep model loaded for 60 minutes
                },
                timeout=60
            )
            if response.status_code == 200:
                print(f"   ✅ {llm_model} loaded and warmed!")
            else:
                print(f"   ⚠️  LLM pre-warm returned status {response.status_code}")
                llm_ok = False
        except requests.exceptions.Timeout:
            print(f"   ⚠️  LLM pre-warm timed out (model may be large)")
            llm_ok = False
        except Exception as e:
            print(f"   ⚠️  LLM pre-warm failed: {e}")
            llm_ok = False

    # Summary
    print("\n" + "=" * 60)
    if stt_ok and tts_ok:
        print("✨ ALL SERVICES READY ✨")
        print("\nService URLs:")
        print(f"   STT:  http://localhost:{STT_PORT}")
        print(f"   TTS:  http://localhost:{TTS_PORT}")
        print(f"   LLM:  http://localhost:{LLM_PORT}")
        if llm_ok:
            print(f"        Model: {os.getenv('LOCAL_LLM_MODEL', 'ministral-3:14b')} (preloaded)")
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
                        # Process exited. Check if service is still running (daemonized?)
                        url = STT_HEALTH if "STT" in name else TTS_HEALTH
                        if not check_service(url):
                            print(f"\n⚠️  {name} exited unexpectedly and service is down!")
                            cleanup()
                        # If service is still up, just ignore the process exit (it likely forked)
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
