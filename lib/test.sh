#!/bin/bash
# Scores the submitted tests by the mutants they kill (tests/mutation/scoring.toml).
set -uo pipefail
V=/logs/verifier
log() { echo "[verifier] $*"; }
mkdir -p "$V"

trap 'if [ ! -f "$V/reward.json" ] && [ ! -f "$V/reward.txt" ] && [ ! -f "$V/ungraded.json" ]; then echo -1 > "$V/reward.txt"; fi' EXIT
rm -f "$V/reward.json" "$V/reward.txt" "$V/ungraded.json" "$V/grade.json"
/opt/judge/python/bin/python3 -I /tests/mutation/score_mutants.py verify
_rc=$?
log "reward.json=$(cat "$V/reward.json" 2>/dev/null)"
exit "$_rc"
