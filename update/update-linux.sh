#!/bin/bash
# Pitchroom — Linux: run ./update/update-linux.sh to update Pitchroom to the latest version (close Pitchroom first).
# All in main, so bash has read it all before it runs: the update may write over this file.
main() {
  cd "$(dirname "$0")/.." || exit 1
  if [ ! -x .venv/bin/python ]; then
    echo "Start Pitchroom once first (./start-linux.sh), then run this again."
    exit 1
  fi
  .venv/bin/python update.py
  exit $?
}
main "$@"
