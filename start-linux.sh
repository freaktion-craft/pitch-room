#!/bin/bash
# Stem — Linux: run ./start-linux.sh (or double-click if your file manager allows).
cd "$(dirname "$0")" || exit 1

if [ ! -x .venv/bin/python ]; then
  PY=""
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then PY="$c"; break; fi
  done
  echo "First run: creating a private Python environment…"
  if [ -z "$PY" ] || ! "$PY" -m venv .venv 2>/dev/null; then
    # No Python 3.9+ (or no venv module, as on Debian and Ubuntu without python3-venv): uv (astral.sh) fetches one for
    # Stem alone, into .tools; nothing outside this folder changes
    rm -rf .venv
    echo "Python isn’t ready here, so Stem fetches its own copy (about 40 MB, once)…"
    export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python" UV_CACHE_DIR="$PWD/.tools/cache"
    if [ ! -x .tools/uv ]; then
      url="https://github.com/astral-sh/uv/releases/download/0.12.24/uv-$(uname -m)-unknown-linux-gnu.tar.gz"
      mkdir -p .tools && { if command -v curl >/dev/null 2>&1; then curl -fsSL "$url"; else wget -qO- "$url"; fi; } | tar -xz -C .tools --strip-components 1
    fi
    if [ ! -x .tools/uv ] || ! .tools/uv venv --seed --managed-python --python 3.11 .venv; then
      echo "Couldn’t fetch Python. Check the internet connection and run this again, or install Python 3.9 or newer (sudo apt install python3 python3-venv)."
      exit 1
    fi
  fi
fi

exec .venv/bin/python launch.py "$@"
