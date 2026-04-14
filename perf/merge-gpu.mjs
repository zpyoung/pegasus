#!/usr/bin/env node
/**
 * Merge GPU metrics from powermetrics output into perf-baseline.json.
 *
 * Usage:
 *   node perf/merge-gpu.mjs <path-to-powermetrics-output.txt>
 *
 * Parses the text output of:
 *   sudo powermetrics -i 1000 -n N --samplers gpu
 *
 * Extracts per-sample GPU active residency %, frequency, and power,
 * then appends them to the existing perf-baseline.json report.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const gpuLogPath = process.argv[2];
if (!gpuLogPath) {
  console.error("Usage: node perf/merge-gpu.mjs <powermetrics-output.txt>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse powermetrics text output
// ---------------------------------------------------------------------------

const raw = readFileSync(gpuLogPath, "utf-8");

// Split into per-sample blocks (each starts with "*** GPU usage ****" or similar)
const blocks = raw.split(/^\*{3,}.*GPU.*\*{3,}$/m).filter((b) => b.trim());

const gpuSamples = blocks.map((block) => {
  const residencyMatch = block.match(
    /GPU (?:HW )?active residency:\s*([\d.]+)%/,
  );
  const frequencyMatch = block.match(
    /GPU (?:HW )?active frequency:\s*([\d.]+)\s*MHz/,
  );
  const powerMatch = block.match(/GPU Power:\s*([\d.]+)\s*mW/);
  const idleMatch = block.match(/GPU idle residency:\s*([\d.]+)%/);

  return {
    gpuResidencyPercent: residencyMatch ? parseFloat(residencyMatch[1]) : null,
    gpuFrequencyMHz: frequencyMatch ? parseFloat(frequencyMatch[1]) : null,
    gpuPowerMW: powerMatch ? parseFloat(powerMatch[1]) : null,
    gpuIdlePercent: idleMatch ? parseFloat(idleMatch[1]) : null,
  };
});

// Filter out samples with no data (e.g. empty trailing blocks)
const validSamples = gpuSamples.filter((s) => s.gpuResidencyPercent !== null);

if (validSamples.length === 0) {
  console.error("[gpu-merge] No GPU samples found in powermetrics output.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Merge into perf-baseline.json
// ---------------------------------------------------------------------------

const baselinePath = join(__dirname, "perf-baseline.json");
let report;
try {
  report = JSON.parse(readFileSync(baselinePath, "utf-8"));
} catch {
  console.error(`[gpu-merge] Could not read ${baselinePath}`);
  process.exit(1);
}

// Align GPU samples with benchmark samples (1:1 by index, trim extras)
const benchSampleCount = report.samples.length;
const aligned = validSamples.slice(0, benchSampleCount);

// Attach GPU data to each benchmark sample
for (let i = 0; i < aligned.length; i++) {
  report.samples[i].gpuResidencyPercent = aligned[i].gpuResidencyPercent;
  report.samples[i].gpuFrequencyMHz = aligned[i].gpuFrequencyMHz;
  report.samples[i].gpuPowerMW = aligned[i].gpuPowerMW;
}

// Add aggregate GPU metrics
const residencies = aligned
  .map((s) => s.gpuResidencyPercent)
  .filter((v) => v !== null);
const powers = aligned.map((s) => s.gpuPowerMW).filter((v) => v !== null);

report.metrics.gpu = {
  avgResidencyPercent:
    Math.round(
      (residencies.reduce((a, b) => a + b, 0) / residencies.length) * 10,
    ) / 10,
  maxResidencyPercent: Math.round(Math.max(...residencies) * 10) / 10,
  avgPowerMW:
    powers.length > 0
      ? Math.round((powers.reduce((a, b) => a + b, 0) / powers.length) * 10) /
        10
      : null,
  maxPowerMW: powers.length > 0 ? Math.round(Math.max(...powers)) : null,
  samplesCollected: aligned.length,
};

writeFileSync(baselinePath, JSON.stringify(report, null, 2));

console.log(
  `[gpu-merge] Merged ${aligned.length} GPU samples into ${baselinePath}`,
);
console.log(
  `[gpu-merge] GPU: avg=${report.metrics.gpu.avgResidencyPercent}% ` +
    `max=${report.metrics.gpu.maxResidencyPercent}% ` +
    `power=${report.metrics.gpu.avgPowerMW ?? "n/a"} mW`,
);
