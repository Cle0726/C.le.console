from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
ENTRY = REPO_ROOT / "storyos" / "sidecar_main.py"
OUTPUT_DIR = REPO_ROOT / "sidecars" / "storyos-workspace" / "bin"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the read-only StoryOS desktop sidecar")
    parser.add_argument(
        "--target",
        required=True,
        choices=(
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
        ),
    )
    parser.add_argument("--skip-smoke", action="store_true")
    return parser.parse_args()


def validate_host(target: str) -> None:
    if target.endswith("pc-windows-msvc"):
        if sys.platform != "win32":
            raise SystemExit(f"Windows StoryOS sidecar must be built on Windows, not {sys.platform}")
        return

    if target.endswith("apple-darwin"):
        if sys.platform != "darwin":
            raise SystemExit(f"macOS StoryOS sidecar must be built on macOS, not {sys.platform}")
        machine = platform.machine().lower()
        expected = "arm64" if target.startswith("aarch64-") else "x86_64"
        normalized = "arm64" if machine in {"arm64", "aarch64"} else machine
        if normalized != expected:
            raise SystemExit(
                f"StoryOS sidecar target {target} requires host architecture {expected}, got {machine}"
            )
        return

    raise SystemExit(f"unsupported target: {target}")


def run(command: list[str], *, cwd: Path | None = None) -> None:
    rendered = " ".join(command)
    print(f"+ {rendered}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    args = parse_args()
    validate_host(args.target)
    if not ENTRY.is_file():
        raise SystemExit(f"StoryOS sidecar entry point is missing: {ENTRY}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    suffix = ".exe" if sys.platform == "win32" else ""
    destination = OUTPUT_DIR / f"storyos-workspace-{args.target}{suffix}"

    with tempfile.TemporaryDirectory(prefix="storyos-sidecar-") as temp_dir:
        temp = Path(temp_dir)
        dist = temp / "dist"
        work = temp / "work"
        spec = temp / "spec"
        env = dict(os.environ)
        env.setdefault("PYTHONUTF8", "1")

        command = [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--noupx",
            "--name",
            "storyos-workspace",
            "--distpath",
            str(dist),
            "--workpath",
            str(work),
            "--specpath",
            str(spec),
            "--paths",
            str(REPO_ROOT / "storyos"),
            str(ENTRY),
        ]
        print(f"+ {' '.join(command)}", flush=True)
        subprocess.run(command, cwd=REPO_ROOT, env=env, check=True)

        built = dist / f"storyos-workspace{suffix}"
        if not built.is_file():
            raise SystemExit(f"PyInstaller did not produce the expected executable: {built}")
        shutil.copy2(built, destination)

    if sys.platform != "win32":
        destination.chmod(0o755)

    if sys.platform == "darwin":
        run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(destination)])
        run(["codesign", "--verify", "--strict", "--verbose=2", str(destination)])

    if not args.skip_smoke:
        run([str(destination), "--help"], cwd=REPO_ROOT)

    size = destination.stat().st_size
    print(f"StoryOS sidecar ready: {destination} ({size} bytes)")


if __name__ == "__main__":
    main()
