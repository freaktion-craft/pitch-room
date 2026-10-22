#!/bin/bash
# Stem — macOS: double-click to start. First run sets up Python packages (1–2 min).
cd "$(dirname "$0")" || exit 1

if [ ! -x .venv/bin/python ]; then
  PY=""
  for c in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
    p=$(command -v "$c" 2>/dev/null) || continue
    [ "$p" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1 && continue # Apple's stand-in: it only offers to install the developer tools
    if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then PY="$p"; break; fi
  done
  if [ -n "$PY" ]; then
    echo "First run: creating a private Python environment…"
    "$PY" -m venv .venv || { read -r -p "Couldn’t create the environment. Press Enter to close."; exit 1; }
  else
    # No Python 3.9+ on this Mac: uv (astral.sh) fetches one for Stem alone, into .tools; nothing outside this folder changes
    echo "First run: Python isn’t installed, so Stem fetches its own copy (about 40 MB, once)…"
    export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python" UV_CACHE_DIR="$PWD/.tools/cache"
    arch=x86_64; [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && arch=aarch64 # Apple silicon, even from a Terminal under Rosetta
    if [ ! -x .tools/uv ]; then
      mkdir -p .tools && curl -fsSL "https://github.com/astral-sh/uv/releases/download/0.12.24/uv-$arch-apple-darwin.tar.gz" | tar -xz -C .tools --strip-components 1
    fi
    if [ ! -x .tools/uv ] || ! .tools/uv venv --seed --managed-python --python 3.11 .venv; then
      read -r -p "Couldn’t fetch Python. Check the internet connection and run this again, or install Python 3.9 or newer from python.org. Press Enter to close."
      exit 1
    fi
  fi
fi

.venv/bin/python launch.py "$@"
status=$?
[ $status -ne 0 ] && read -r -p "Something went wrong — see the message above. Press Enter to close."
exit $status
