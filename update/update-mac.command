#!/bin/bash
# Pitchroom — macOS: double-click to update Pitchroom to the latest version (close Pitchroom first).
# All in main, so bash has read it all before it runs: the update may write over this file.
main() {
  cd "$(dirname "$0")/.." || exit 1
  if [ ! -x .venv/bin/python ]; then
    read -r -p "Start Pitchroom once first (start-mac.command), then run this again. Press Enter to close."
    exit 1
  fi
  .venv/bin/python update.py
  status=$?
  read -r -p "Press Enter to close."
  exit $status
}
main "$@"
