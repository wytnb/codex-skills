from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = SKILL_ROOT / ".state"
VENV_DIR = STATE_DIR / "venv"
DEFAULT_PROFILE_DIR = STATE_DIR / "default-profile"
CONSTRAINTS_FILE = STATE_DIR / "constraints.txt"
RUNTIME_FLAG = "CLOAKBROWSER_SKILL_RUNTIME_ACTIVE"
PACKAGES = ["cloakbrowser[geoip,patchright,serve]"]


def venv_python_path() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def run(
    command: list[str],
    *,
    capture_output: bool = False,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        text=True,
        check=check,
        capture_output=capture_output,
        env=env,
    )


def runtime_python_is_current() -> bool:
    runtime_python = venv_python_path()
    if not runtime_python.exists():
        return False
    return Path(sys.executable).resolve() == runtime_python.resolve()


def needs_greenlet_pin(version_info: tuple[int, int] | None = None) -> bool:
    major, minor = version_info or sys.version_info[:2]
    return os.name == "nt" and (major, minor) == (3, 9)


def write_constraints() -> Path | None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if needs_greenlet_pin():
        CONSTRAINTS_FILE.write_text("greenlet==3.1.1\n", encoding="utf-8")
        return CONSTRAINTS_FILE
    if CONSTRAINTS_FILE.exists():
        CONSTRAINTS_FILE.unlink()
    return None


def runtime_imports_ready(python_exe: Path) -> bool:
    if not python_exe.exists():
        return False
    command = [
        str(python_exe),
        "-c",
        (
            "import cloakbrowser, patchright, playwright, geoip2, aiohttp, "
            "websockets, greenlet"
        ),
    ]
    result = run(command, capture_output=True, check=False)
    return result.returncode == 0


def binary_installed(python_exe: Path) -> bool:
    result = run(
        [str(python_exe), "-m", "cloakbrowser", "info"],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0 and "Installed: True" in result.stdout


def ensure_runtime(*, install_binary: bool = True) -> Path:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    DEFAULT_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    runtime_python = venv_python_path()
    if not runtime_python.exists():
        run([sys.executable, "-m", "venv", str(VENV_DIR)])

    runtime_python = venv_python_path()
    constraints = write_constraints()

    if not runtime_imports_ready(runtime_python):
        run([str(runtime_python), "-m", "pip", "install", "--upgrade", "pip"])
        install_command = [str(runtime_python), "-m", "pip", "install"]
        if constraints is not None:
            install_command += ["-c", str(constraints)]
        install_command += PACKAGES
        run(install_command)

    if install_binary and not binary_installed(runtime_python):
        run([str(runtime_python), "-m", "cloakbrowser", "install"])

    return runtime_python


def ensure_runtime_and_reexec(argv: list[str]) -> None:
    runtime_python = ensure_runtime()
    if runtime_python_is_current() or os.environ.get(RUNTIME_FLAG) == "1":
        return

    env = os.environ.copy()
    env[RUNTIME_FLAG] = "1"
    result = subprocess.run([str(runtime_python), *argv], env=env)
    raise SystemExit(result.returncode)


def runtime_info() -> dict[str, str]:
    runtime_python = venv_python_path()
    return {
        "skill_root": str(SKILL_ROOT),
        "state_dir": str(STATE_DIR),
        "venv_dir": str(VENV_DIR),
        "runtime_python": str(runtime_python),
        "default_profile_dir": str(DEFAULT_PROFILE_DIR),
        "greenlet_pin": "greenlet==3.1.1" if needs_greenlet_pin() else "",
    }


def print_runtime_info_json() -> None:
    print(json.dumps(runtime_info(), indent=2))
