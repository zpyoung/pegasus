#!/bin/bash
# Capture GPU metrics alongside the performance benchmark.
# Requires sudo for powermetrics.
#
# Usage:
#   pnpm test:perf:gpu
#   # or directly:
#   sudo perf/capture-gpu.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GPU_LOG="$PROJECT_ROOT/perf/gpu-raw.txt"

# Ensure we're running as root (powermetrics requires it)
if [ "$(id -u)" -ne 0 ]; then
  echo "[gpu] Re-running with sudo..."
  exec sudo "$0" "$@"
fi

# Resolve the real user so pnpm runs unprivileged
REAL_USER="${SUDO_USER:-$(whoami)}"

# Clean previous run
rm -f "$GPU_LOG"

echo "[gpu] Starting GPU monitoring (1s interval, 50 samples max)..."
# Use -o flag so powermetrics manages its own file I/O (avoids shell
# buffering issues when the process is killed before stdout flushes).
# Do NOT suppress stderr — if powermetrics fails we need to see why.
powermetrics -i 1000 -n 80 --samplers gpu_power -o "$GPU_LOG" &
PM_PID=$!

# Give powermetrics a moment to start and write its first sample
sleep 2

echo "[gpu] Running performance benchmark..."
cd "$PROJECT_ROOT"
# Drop privileges for the actual test run
sudo -u "$REAL_USER" pnpm test:perf
BENCH_EXIT=$?

echo "[gpu] Stopping GPU monitor..."
kill "$PM_PID" 2>/dev/null || true
wait "$PM_PID" 2>/dev/null || true

# Make the log readable by the unprivileged user
chmod 644 "$GPU_LOG" 2>/dev/null || true

# Debug: show what powermetrics captured
if [ -f "$GPU_LOG" ]; then
  GPU_LINES=$(wc -l < "$GPU_LOG" | tr -d ' ')
  echo "[gpu] powermetrics captured $GPU_LINES lines → $GPU_LOG"
  echo "[gpu] First 10 lines:"
  head -10 "$GPU_LOG"
else
  echo "[gpu] ERROR: $GPU_LOG was not created. powermetrics may have failed."
  exit 1
fi

echo "[gpu] Merging GPU data into baseline report..."
sudo -u "$REAL_USER" node perf/merge-gpu.mjs "$GPU_LOG"

echo "[gpu] Done. (benchmark exit code: $BENCH_EXIT)"
