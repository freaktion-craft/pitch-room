#!/bin/bash
# Stem — macOS: double-click to start. First run sets up Python packages (1–2 min).
cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.9 or newer is needed. Opening the download page — install it, then run this again."
  open "https://www.python.org/downloads/macos/"
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: creating a private Python environment…"
  "$PY" -m venv .venv || { read -r -p "Couldn’t create the environment. Press Enter to close."; exit 1; }
fi

.venv/bin/python launch.py "$@"
status=$?
[ $status -ne 0 ] && read -r -p "Something went wrong — see the message above. Press Enter to close."
exit $status
