#!/bin/bash
set -euo pipefail

# Capture GPU metrics alongside the performance benchmark.
# Requires sudo for powermetrics.
#
# Usage:
#   pnpm test:perf:gpu                                      # auto-compares if baseline exists
#   pnpm test:perf:gpu -- --compare perf/perf-baseline.json # explicit compare path
#   pnpm test:perf:gpu -- --streams 5                       # custom stream count
#   pnpm test:perf:gpu -- --baseline                        # force new baseline (overwrite)
#   # or directly:
#   sudo perf/capture-gpu.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_PATH="$PROJECT_ROOT/perf/perf-baseline.json"

# Parse --compare / --streams / --baseline into env vars so they survive the
# pnpm → playwright → sudo re-exec forwarding chain.
export PERF_FORCE_BASELINE="${PERF_FORCE_BASELINE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compare) export PERF_COMPARE="$2"; shift 2 ;;
    --streams) export PERF_STREAMS="$2"; shift 2 ;;
    --baseline) export PERF_FORCE_BASELINE=1; shift ;;
    --) shift ;;  # skip bare -- from pnpm forwarding
    *) shift ;;
  esac
done

# Auto-compare: if baseline exists and no explicit --compare or --baseline, compare against it
if [ "${PERF_FORCE_BASELINE:-}" != "1" ] && [ -z "${PERF_COMPARE:-}" ] && [ -f "$BASELINE_PATH" ]; then
  echo "[gpu] Baseline found at $BASELINE_PATH — running in comparison mode"
  export PERF_COMPARE="$BASELINE_PATH"
fi

# Ensure we're running as root (powermetrics requires it)
if [ "$(id -u)" -ne 0 ]; then
  echo "[gpu] Re-running with sudo..."
  exec sudo \
    PERF_COMPARE="${PERF_COMPARE:-}" \
    PERF_STREAMS="${PERF_STREAMS:-}" \
    PERF_FORCE_BASELINE="${PERF_FORCE_BASELINE:-}" \
    "$0"
fi

# Resolve the real user so pnpm runs unprivileged
REAL_USER="${SUDO_USER:-$(whoami)}"

# Write GPU log to a secure temp file owned by root, then move into repo
GPU_TMPLOG="$(mktemp /tmp/pegasus-gpu-raw.XXXXXX)"
trap 'rm -f "$GPU_TMPLOG"' EXIT

echo "[gpu] Starting GPU monitoring (1s interval, 80 samples max)..."
# Use -o flag so powermetrics manages its own file I/O (avoids shell
# buffering issues when the process is killed before stdout flushes).
# Do NOT suppress stderr — if powermetrics fails we need to see why.
powermetrics -i 1000 -n 80 --samplers gpu_power -o "$GPU_TMPLOG" &
PM_PID=$!

# Give powermetrics a moment to start and write its first sample
sleep 2

# Verify powermetrics is still running before starting the benchmark
if ! kill -0 "$PM_PID" 2>/dev/null; then
  echo "[gpu] ERROR: powermetrics exited early. Check permissions or availability."
  exit 1
fi

echo "[gpu] Running performance benchmark..."
cd "$PROJECT_ROOT" || exit 1
# Drop privileges for the actual test run
sudo -u "$REAL_USER" \
    PERF_COMPARE="${PERF_COMPARE:-}" \
    PERF_STREAMS="${PERF_STREAMS:-}" \
    pnpm test:perf
BENCH_EXIT=$?

echo "[gpu] Stopping GPU monitor..."
kill "$PM_PID" 2>/dev/null || true
wait "$PM_PID" 2>/dev/null || true

# Move the root-owned temp log into the repo as the real user
GPU_LOG="$PROJECT_ROOT/perf/gpu-raw.txt"
if [ -f "$GPU_TMPLOG" ]; then
  cp "$GPU_TMPLOG" "$GPU_LOG"
  chown "$REAL_USER" "$GPU_LOG"
  chmod 644 "$GPU_LOG"
  GPU_LINES=$(wc -l < "$GPU_LOG" | tr -d ' ')
  echo "[gpu] powermetrics captured $GPU_LINES lines → $GPU_LOG"
  echo "[gpu] First 10 lines:"
  head -10 "$GPU_LOG"
else
  echo "[gpu] ERROR: GPU log was not created. powermetrics may have failed."
  exit 1
fi

echo "[gpu] Merging GPU data into baseline report..."
sudo -u "$REAL_USER" node perf/merge-gpu.mjs "$GPU_LOG"
MERGE_EXIT=$?

if [ "$BENCH_EXIT" -ne 0 ]; then
  echo "[gpu] Benchmark failed (exit code: $BENCH_EXIT)"
  exit "$BENCH_EXIT"
fi

if [ "$MERGE_EXIT" -ne 0 ]; then
  echo "[gpu] GPU merge failed (exit code: $MERGE_EXIT)"
  exit "$MERGE_EXIT"
fi

echo "[gpu] Done."
