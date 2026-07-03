"""
LingLang Server — Model Package Manager

Downloads model weights from HuggingFace and manages service lifecycle.
Inspired by Wan2GP's process_files_def + family_handler pattern.

Usage:
    python -m server.scripts.pkg_manager download <package_id>
    python -m server.scripts.pkg_manager download --tier english-24g
    python -m server.scripts.pkg_manager list
    python -m server.scripts.pkg_manager start <package_id>
    python -m server.scripts.pkg_manager stop <package_id>
"""

import argparse
import os
import subprocess
import sys
import yaml
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

# Base directory for downloaded model weights
MODELS_DIR = Path(__file__).parent.parent / "models"
PACKAGES_DIR = Path(__file__).parent.parent / "packages"
SERVICES_DIR = Path(__file__).parent.parent / "services"


@dataclass
class PackageSpec:
    id: str
    type: str  # tts, stt, llm, embed
    name: str
    languages: list[str]
    gpu: bool
    vram_mb: int
    disk_mb: int
    download: dict  # repo_id / repo_ids + optional file filters
    server: dict    # port, endpoint, format, health, etc.
    service_dir: str  # subdirectory in services/

    @property
    def model_dir(self) -> Path:
        """Where this package's weights live (gitignored)."""
        return MODELS_DIR / self.id


def load_package(spec_path: Path) -> PackageSpec:
    with open(spec_path) as f:
        data = yaml.safe_load(f)
    return PackageSpec(
        id=data["id"],
        type=data["type"],
        name=data["name"],
        languages=data.get("languages", []),
        gpu=data.get("gpu", True),
        vram_mb=data.get("vram_mb", 0),
        disk_mb=data.get("disk_mb", 0),
        download=data.get("download", {}),
        server=data.get("server", {}),
        service_dir=data.get("service_dir", data["id"]),
    )


def scan_packages() -> list[PackageSpec]:
    """Scan packages/ dir for all YAML package definitions."""
    packages = []
    for yaml_file in PACKAGES_DIR.rglob("*.yaml"):
        packages.append(load_package(yaml_file))
    return packages


def is_downloaded(pkg: PackageSpec) -> bool:
    """Check if model weights exist on disk."""
    target = pkg.model_dir
    if not target.exists():
        return False
    # For snapshot downloads, check that the directory has contents
    # (HF snapshot_download creates the repo structure)
    return any(target.iterdir())


def download_package(pkg: PackageSpec, force: bool = False):
    """Download model weights from HuggingFace.

    Uses huggingface_hub.snapshot_download for full repo downloads
    and hf_hub_download for individual files.
    """
    if is_downloaded(pkg) and not force:
        print(f"✓ {pkg.id} already downloaded at {pkg.model_dir}")
        return

    from huggingface_hub import snapshot_download, hf_hub_download

    target_dir = pkg.model_dir
    target_dir.mkdir(parents=True, exist_ok=True)

    dl = pkg.download

    # Multiple repos (e.g., MossTTS needs model + tokenizer)
    if "repo_ids" in dl:
        for repo_id in dl["repo_ids"]:
            print(f"⬇ Downloading {repo_id} → {target_dir}...")
            snapshot_download(
                repo_id=repo_id,
                local_dir=str(target_dir / repo_id.replace("/", "_")),
                local_dir_use_symlinks=False,
            )
    # Single repo
    elif "repo_id" in dl:
        repo_id = dl["repo_id"]

        # Specific files only
        if "files" in dl:
            files = dl["files"]
            subfolder = dl.get("subfolder", "")
            for fname in files:
                print(f"⬇ Downloading {repo_id}/{subfolder}/{fname} → {target_dir}...")
                hf_hub_download(
                    repo_id=repo_id,
                    filename=fname,
                    subfolder=subfolder if subfolder else None,
                    local_dir=str(target_dir),
                )
        # Full repo snapshot
        else:
            print(f"⬇ Downloading {repo_id} → {target_dir}...")
            snapshot_download(
                repo_id=repo_id,
                local_dir=str(target_dir),
                local_dir_use_symlinks=False,
            )

    print(f"✓ {pkg.id} downloaded to {target_dir}")


def start_service(pkg: PackageSpec):
    """Start a model's server process."""
    service_path = SERVICES_DIR / pkg.service_dir
    if not service_path.exists():
        print(f"✗ No service dir at {service_path}")
        return

    # Check the service has a start script or Dockerfile
    start_sh = service_path / "start.sh"
    if start_sh.exists():
        env = os.environ.copy()
        env["MODEL_DIR"] = str(pkg.model_dir)
        env["SERVER_PORT"] = str(pkg.server.get("port", 8080))
        subprocess.Popen(["bash", str(start_sh)], env=env, cwd=str(service_path))
        print(f"▶ Started {pkg.id} on port {pkg.server.get('port')}")
    else:
        print(f"✗ No start.sh in {service_path}")


def stop_service(pkg: PackageSpec):
    """Stop a model's server process by port."""
    port = pkg.server.get("port")
    if not port:
        print(f"✗ No port defined for {pkg.id}")
        return

    result = subprocess.run(
        ["lsof", "-ti", f":{port}"],
        capture_output=True, text=True
    )
    if result.stdout.strip():
        pids = result.stdout.strip().split("\n")
        for pid in pids:
            subprocess.run(["kill", pid])
        print(f"■ Stopped {pkg.id} (PID(s): {', '.join(pids)})")
    else:
        print(f"■ {pkg.id} not running on port {port}")


def cmd_list(args):
    packages = scan_packages()
    print(f"{'ID':<20} {'Type':<6} {'GPU':<4} {'VRAM':>6} {'Disk':>7} {'Downloaded':>10} {'Languages'}")
    print("-" * 80)
    for pkg in sorted(packages, key=lambda p: (p.type, p.id)):
        dl = "✓" if is_downloaded(pkg) else "✗"
        print(
            f"{pkg.id:<20} {pkg.type:<6} {'Y' if pkg.gpu else 'N':<4} "
            f"{pkg.vram_mb:>5}M {pkg.disk_mb:>6}M {dl:>10} {','.join(pkg.languages)}"
        )


def cmd_download(args):
    packages = scan_packages()
    if args.package_id:
        pkg = next((p for p in packages if p.id == args.package_id), None)
        if not pkg:
            print(f"✗ Unknown package: {args.package_id}")
            sys.exit(1)
        download_package(pkg, force=args.force)
    elif args.tier:
        # Download all packages for a tier config
        # TODO: implement tier resolution from ARCHITECTURE.md configs
        print("Tier-based download not yet implemented. Use individual package IDs.")
        sys.exit(1)
    else:
        # Download all
        for pkg in packages:
            download_package(pkg, force=args.force)


def cmd_start(args):
    packages = scan_packages()
    pkg = next((p for p in packages if p.id == args.package_id), None)
    if not pkg:
        print(f"✗ Unknown package: {args.package_id}")
        sys.exit(1)
    start_service(pkg)


def cmd_stop(args):
    packages = scan_packages()
    pkg = next((p for p in packages if p.id == args.package_id), None)
    if not pkg:
        print(f"✗ Unknown package: {args.package_id}")
        sys.exit(1)
    stop_service(pkg)


def main():
    parser = argparse.ArgumentParser(description="LingLang Server Package Manager")
    sub = parser.add_subparsers(dest="command")

    # list
    sub.add_parser("list", help="List available packages and download status")

    # download
    dl = sub.add_parser("download", help="Download model weights from HuggingFace")
    dl.add_argument("package_id", nargs="?", help="Package to download (omit for all)")
    dl.add_argument("--tier", help="Download all packages for a tier config")
    dl.add_argument("--force", action="store_true", help="Re-download even if exists")

    # start / stop
    start = sub.add_parser("start", help="Start a model server")
    start.add_argument("package_id")
    stop = sub.add_parser("stop", help="Stop a model server")
    stop.add_argument("package_id")

    args = parser.parse_args()
    if args.command == "list":
        cmd_list(args)
    elif args.command == "download":
        cmd_download(args)
    elif args.command == "start":
        cmd_start(args)
    elif args.command == "stop":
        cmd_stop(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
