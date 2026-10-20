#!/bin/bash
# Stem — Linux: run ./start-linux.sh (or double-click if your file manager allows).
cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.9 or newer is needed. For example: sudo apt install python3 python3-venv"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating a private Python environment…"
  "$PY" -m venv .venv || { echo "Couldn’t create the environment. On Ubuntu/Debian: sudo apt install python3-venv"; exit 1; }
fi

exec .venv/bin/python launch.py "$@"
