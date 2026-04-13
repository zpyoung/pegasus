/**
 * Performance Benchmark Baseline — Wave 1
 *
 * Implements the test scenario specified in wave-1-trivial-wins.design.md §Task 5:
 *   "10 concurrent agent streams: performance baseline"
 *
 * Creates N features in `in_progress` state to simulate concurrent agent streams,
 * then samples CDP Performance metrics for 30 seconds while the board renders all
 * running cards (animated borders, status indicators, Zustand subscriptions, etc.).
 *
 * Run with:
 *   pnpm --filter @pegasus/ui test:perf
 *   pnpm --filter @pegasus/ui test:perf -- --streams 5
 *   pnpm --filter @pegasus/ui test:perf -- --compare perf-baseline.json
 *
 * Environment variable equivalents:
 *   PERF_STREAMS=5 pnpm --filter @pegasus/ui test:perf
 *   PERF_COMPARE=perf-baseline.json pnpm --filter @pegasus/ui test:perf
 *
 * Output: perf/perf-baseline.json  (written to project root perf/)
 *         perf/perf-comparison.json (when --compare is used)
 *
 * Gate thresholds (from design doc):
 *   - avgFPS  > 20 fps
 *   - heap growth < 150 MB
 *   - CPU task time < 67 %
 *
 * NOTE: `totalRenders` in the report is null — it requires React profiling mode
 * (unavailable in production builds) and cannot be measured via CDP alone.
 */

import { test, expect, type BrowserContext } from "@playwright/test";
// CDPSession is not a named runtime export; derive its type from the API return type
type CDPSession = Awaited<ReturnType<BrowserContext["newCDPSession"]>>;

import * as fs from "fs";
import * as path from "path";
import {
  setupProjectWithFixture,
  getFixturePath,
  getWorkspaceRoot,
  navigateToBoard,
  authenticateForTests,
  API_BASE_URL,
} from "../utils";

// ---------------------------------------------------------------------------
// CLI / environment argument parsing (module-level, available during test)
// ---------------------------------------------------------------------------

/**
 * Scan process.argv for `--flag value` pairs, falling back to an environment
 * variable name if the flag is absent.  Returns `undefined` when neither
 * source provides a value.
 */
function getArg(flag: string, envVar: string): string | undefined {
  // Environment variable takes precedence over argv so it can be set via
  // shell wrappers without needing to thread it through Playwright's -- forwarding.
  if (process.env[envVar]) return process.env[envVar];

  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const streamsArg = getArg("--streams", "PERF_STREAMS");
const compareArg = getArg("--compare", "PERF_COMPARE");

// ---------------------------------------------------------------------------
// Benchmark configuration
// ---------------------------------------------------------------------------

const STREAM_COUNT: number = streamsArg ? parseInt(streamsArg, 10) : 10;
const SAMPLE_DURATION_MS = 30_000;
const SAMPLE_INTERVAL_MS = 1_000;

// Path to an existing baseline report to compare against (optional)
const COMPARE_PATH: string | undefined = compareArg
  ? path.resolve(compareArg)
  : undefined;

// Gate thresholds from the design document
const THRESHOLDS = {
  minAvgFps: 20,
  maxHeapGrowthMB: 150,
  maxCpuPercent: 67,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CdpMetricMap {
  [key: string]: number;
}

/** One second snapshot of CDP Performance metrics + rAF frame count */
interface BenchmarkSample {
  timestamp: number;
  frames: number;
  jsHeapUsedBytes: number;
  taskDurationSeconds: number;
  scriptDurationSeconds: number;
}

/** Final report written to perf/perf-baseline.json */
interface BenchmarkReport {
  timestamp: string;
  wave: "baseline";
  config: {
    streams: number;
    duration_sec: number;
  };
  metrics: {
    avgFPS: number;
    minFPS: number;
    maxFPS: number;
    heapGrowthMB: number;
    cpuPercent: number;
    scriptPercent: number;
    longTaskCount: number;
    /** null — requires React profiling mode, not measurable via CDP */
    totalRenders: null;
  };
  samples: BenchmarkSample[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMetrics(
  rawMetrics: { name: string; value: number }[],
): CdpMetricMap {
  return Object.fromEntries(rawMetrics.map((m) => [m.name, m.value]));
}

async function collectSample(
  cdp: CDPSession,
  page: import("@playwright/test").Page,
): Promise<BenchmarkSample> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = parseMetrics(metrics);

  // Read frame count from our injected rAF counter (falls back to CDP Frames)
  const rafFrames = await page
    .evaluate(
      () =>
        (window as unknown as { __perfFrameCount?: number }).__perfFrameCount ??
        0,
    )
    .catch(() => 0);

  return {
    timestamp: m["Timestamp"] ?? 0,
    frames: rafFrames || (m["Frames"] ?? 0),
    jsHeapUsedBytes: m["JSHeapUsedSize"] ?? 0,
    taskDurationSeconds: m["TaskDuration"] ?? 0,
    scriptDurationSeconds: m["ScriptDuration"] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe("Performance Baseline", () => {
  test.setTimeout(120_000); // 30s sampling + feature setup/teardown overhead

  test("10 concurrent agent streams: performance baseline", async ({
    page,
  }) => {
    // -----------------------------------------------------------------------
    // 1. Set up fixture project and navigate to the board
    // -----------------------------------------------------------------------
    await setupProjectWithFixture(page);

    // Route-intercept resume-interrupted so the server does not auto-start
    // any lingering features during the benchmark window.
    await page.route("**/api/auto-mode/resume-interrupted", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    await authenticateForTests(page);
    await navigateToBoard(page);

    // Wait for board to fully settle (WebSocket, Zustand hydration)
    await page.waitForTimeout(2_000);

    // -----------------------------------------------------------------------
    // 2. Create STREAM_COUNT features in `in_progress` state to simulate
    //    concurrent agent streams.
    //
    //    With PEGASUS_MOCK_AGENT=true the mock provider completes in
    //    milliseconds, so we create features directly in the `in_progress`
    //    status.  The board renders all running cards (animated gradient
    //    borders, running-task indicators, Zustand subscriptions) for the
    //    full 30-second measurement window.
    // -----------------------------------------------------------------------
    const projectPath = getFixturePath();
    const featureIds: string[] = [];

    for (let i = 0; i < STREAM_COUNT; i++) {
      const featureId = `perf-stream-${Date.now()}-${i}`;
      featureIds.push(featureId);

      const res = await page.request.post(
        `${API_BASE_URL}/api/features/create`,
        {
          data: {
            projectPath,
            feature: {
              id: featureId,
              description: `Performance benchmark stream ${i + 1}`,
              category: "perf-test",
              status: "in_progress",
              skipTests: false,
              model: "mock-model",
              thinkingLevel: "none",
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              // No branchName — unassigned features show on the primary worktree.
              // Using branchName: "perf-stream-N" caused features to be filtered
              // out because the board views the "main" worktree.
              priority: 2,
            },
          },
          headers: { "Content-Type": "application/json" },
        },
      );

      // Continue even if individual creates fail — log to console rather
      // than failing early so we still get partial benchmark data.
      if (!res.ok()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[perf] Feature create ${featureId} returned ${res.status()}`,
        );
      }
    }

    // Re-navigate to the board so the features query runs fresh and picks
    // up the newly created features from the server.
    await navigateToBoard(page);
    await page.waitForTimeout(2_000);

    // Verify features are visible (check for kanban cards with our IDs)
    const inProgressCount = await page
      .locator('[data-testid^="kanban-card-perf-stream-"]')
      .count()
      .catch(() => 0);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${featureIds.length} features created, ${inProgressCount} visible on board`,
    );

    // -----------------------------------------------------------------------
    // 3. Attach CDP session, enable Performance domain, start rAF counter
    // -----------------------------------------------------------------------
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });

    // Inject a requestAnimationFrame counter to accurately measure FPS.
    // CDP's Frames metric only counts compositor frames and stays flat for
    // idle React apps; rAF counting tracks actual paint opportunities.
    await page.evaluate(() => {
      const win = window as unknown as {
        __perfFrameCount: number;
        __perfRafId: number;
      };
      win.__perfFrameCount = 0;
      function tick() {
        win.__perfFrameCount++;
        win.__perfRafId = requestAnimationFrame(tick);
      }
      win.__perfRafId = requestAnimationFrame(tick);
    });

    // -----------------------------------------------------------------------
    // 4. Collect per-second samples for SAMPLE_DURATION_MS
    // -----------------------------------------------------------------------
    const samples: BenchmarkSample[] = [];
    const baselineSample = await collectSample(cdp, page);
    samples.push(baselineSample);

    const endTime = Date.now() + SAMPLE_DURATION_MS;
    while (Date.now() < endTime) {
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
      samples.push(await collectSample(cdp, page));
    }

    // Stop rAF counter and detach CDP
    await page
      .evaluate(() => {
        const win = window as unknown as { __perfRafId?: number };
        if (win.__perfRafId) cancelAnimationFrame(win.__perfRafId);
      })
      .catch(() => {});
    await cdp.detach();

    // -----------------------------------------------------------------------
    // 5. Derive aggregate metrics from samples
    // -----------------------------------------------------------------------
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsedSeconds = last.timestamp - first.timestamp;

    // Per-second FPS values (delta frames / delta timestamp)
    const perSecondFps = samples.slice(1).map((s, i) => {
      const prev = samples[i];
      const dt = s.timestamp - prev.timestamp;
      return dt > 0 ? (s.frames - prev.frames) / dt : 0;
    });

    const avgFPS =
      perSecondFps.length > 0
        ? perSecondFps.reduce((a, b) => a + b, 0) / perSecondFps.length
        : 0;
    const minFPS = perSecondFps.length > 0 ? Math.min(...perSecondFps) : 0;
    const maxFPS = perSecondFps.length > 0 ? Math.max(...perSecondFps) : 0;

    // Heap growth: peak used heap minus starting heap (bytes → MB)
    const maxHeap = Math.max(...samples.map((s) => s.jsHeapUsedBytes));
    const heapGrowthMB = (maxHeap - first.jsHeapUsedBytes) / (1024 * 1024);

    // CPU%: fraction of elapsed wall time in main-thread tasks
    const taskDelta = last.taskDurationSeconds - first.taskDurationSeconds;
    const cpuPercent =
      elapsedSeconds > 0 ? (taskDelta / elapsedSeconds) * 100 : 0;

    // Script%: fraction of elapsed wall time spent executing JS
    const scriptDelta =
      last.scriptDurationSeconds - first.scriptDurationSeconds;
    const scriptPercent =
      elapsedSeconds > 0 ? (scriptDelta / elapsedSeconds) * 100 : 0;

    // Long-task count: number of 1-second intervals where main-thread task
    // time exceeded 50 ms (i.e., a task longer than one animation frame).
    const longTaskCount = samples.slice(1).filter((s, i) => {
      const taskMs =
        (s.taskDurationSeconds - samples[i].taskDurationSeconds) * 1000;
      return taskMs > 50;
    }).length;

    // -----------------------------------------------------------------------
    // 6. Build and write the report
    // -----------------------------------------------------------------------
    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      wave: "baseline",
      config: {
        streams: STREAM_COUNT,
        duration_sec: Math.round(SAMPLE_DURATION_MS / 1000),
      },
      metrics: {
        avgFPS: Math.round(avgFPS * 10) / 10,
        minFPS: Math.round(minFPS * 10) / 10,
        maxFPS: Math.round(maxFPS * 10) / 10,
        heapGrowthMB: Math.round(heapGrowthMB * 10) / 10,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        scriptPercent: Math.round(scriptPercent * 10) / 10,
        longTaskCount,
        totalRenders: null,
      },
      samples,
    };

    const perfDir = path.join(getWorkspaceRoot(), "perf");
    if (!fs.existsSync(perfDir)) {
      fs.mkdirSync(perfDir, { recursive: true });
    }
    const reportPath = path.join(perfDir, "perf-baseline.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // eslint-disable-next-line no-console
    console.log(
      `[perf] avgFPS=${report.metrics.avgFPS} ` +
        `minFPS=${report.metrics.minFPS} ` +
        `maxFPS=${report.metrics.maxFPS} ` +
        `heapGrowthMB=${report.metrics.heapGrowthMB} ` +
        `cpuPercent=${report.metrics.cpuPercent} ` +
        `scriptPercent=${report.metrics.scriptPercent} ` +
        `longTaskCount=${report.metrics.longTaskCount}`,
    );

    // -----------------------------------------------------------------------
    // 6b. Optional: compare against a saved baseline when --compare was given
    // -----------------------------------------------------------------------
    if (COMPARE_PATH) {
      // Load the previous baseline report — if the file is missing or corrupt,
      // log a warning and skip comparison but do NOT return early (cleanup and
      // gate assertions below must still run).
      let prevReport: BenchmarkReport | null = null;
      try {
        const raw = fs.readFileSync(COMPARE_PATH, "utf-8");
        prevReport = JSON.parse(raw) as BenchmarkReport;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[perf] Could not load comparison file ${COMPARE_PATH}: ${err}`,
        );
      }

      if (prevReport) {
        const prev = prevReport.metrics;
        const curr = report.metrics;

        /** Format a metric row: name, old → new, % change */
        function fmtRow(name: string, oldVal: number, newVal: number): string {
          const pct =
            oldVal !== 0 ? ((newVal - oldVal) / Math.abs(oldVal)) * 100 : 0;
          const sign = pct >= 0 ? "+" : "";
          return `  ${name.padEnd(14)}: ${oldVal.toFixed(1)} → ${newVal.toFixed(1)} (${sign}${pct.toFixed(1)}%)`;
        }

        // eslint-disable-next-line no-console
        console.log("[perf] Comparison with previous baseline:");
        // eslint-disable-next-line no-console
        console.log(fmtRow("avgFPS", prev.avgFPS, curr.avgFPS));
        // eslint-disable-next-line no-console
        console.log(fmtRow("minFPS", prev.minFPS, curr.minFPS));
        // eslint-disable-next-line no-console
        console.log(
          fmtRow("heapGrowthMB", prev.heapGrowthMB, curr.heapGrowthMB),
        );
        // eslint-disable-next-line no-console
        console.log(fmtRow("cpuPercent", prev.cpuPercent, curr.cpuPercent));

        // Write the side-by-side comparison artifact
        const comparisonPath = path.join(perfDir, "perf-comparison.json");
        fs.writeFileSync(
          comparisonPath,
          JSON.stringify({ previous: prevReport, current: report }, null, 2),
        );

        // Assert: no metric should regress by more than 20%.
        //   FPS regression = new value is lower than old  (negative % change)
        //   Heap/CPU regression = new value is higher than old (positive % change)
        const REGRESSION_LIMIT = 20; // percent

        const fpsPctChange =
          prev.avgFPS !== 0
            ? ((curr.avgFPS - prev.avgFPS) / Math.abs(prev.avgFPS)) * 100
            : 0;
        expect(
          fpsPctChange,
          `avgFPS regressed by ${Math.abs(fpsPctChange).toFixed(1)}% (limit: ${REGRESSION_LIMIT}%)`,
        ).toBeGreaterThanOrEqual(-REGRESSION_LIMIT);

        const minFpsPctChange =
          prev.minFPS !== 0
            ? ((curr.minFPS - prev.minFPS) / Math.abs(prev.minFPS)) * 100
            : 0;
        expect(
          minFpsPctChange,
          `minFPS regressed by ${Math.abs(minFpsPctChange).toFixed(1)}% (limit: ${REGRESSION_LIMIT}%)`,
        ).toBeGreaterThanOrEqual(-REGRESSION_LIMIT);

        const heapPctChange =
          prev.heapGrowthMB !== 0
            ? ((curr.heapGrowthMB - prev.heapGrowthMB) /
                Math.abs(prev.heapGrowthMB)) *
              100
            : 0;
        expect(
          heapPctChange,
          `heapGrowthMB regressed by ${heapPctChange.toFixed(1)}% (limit: ${REGRESSION_LIMIT}%)`,
        ).toBeLessThanOrEqual(REGRESSION_LIMIT);

        const cpuPctChange =
          prev.cpuPercent !== 0
            ? ((curr.cpuPercent - prev.cpuPercent) /
                Math.abs(prev.cpuPercent)) *
              100
            : 0;
        expect(
          cpuPctChange,
          `cpuPercent regressed by ${cpuPctChange.toFixed(1)}% (limit: ${REGRESSION_LIMIT}%)`,
        ).toBeLessThanOrEqual(REGRESSION_LIMIT);
      }
    }

    // -----------------------------------------------------------------------
    // 7. Clean up the benchmark features to leave the fixture in a clean state
    // -----------------------------------------------------------------------
    for (const featureId of featureIds) {
      await page.request
        .post(`${API_BASE_URL}/api/features/delete`, {
          data: { projectPath, featureId },
          headers: { "Content-Type": "application/json" },
        })
        .catch(() => {
          // Best-effort cleanup — don't fail the test if delete fails
        });
    }

    // -----------------------------------------------------------------------
    // 8. Assert gate thresholds (from design doc Gate Criteria section)
    // -----------------------------------------------------------------------
    expect(
      report.metrics.avgFPS,
      `avgFPS ${report.metrics.avgFPS.toFixed(1)} must be > ${THRESHOLDS.minAvgFps}`,
    ).toBeGreaterThan(THRESHOLDS.minAvgFps);

    expect(
      report.metrics.heapGrowthMB,
      `Heap growth ${report.metrics.heapGrowthMB.toFixed(1)} MB must be < ${THRESHOLDS.maxHeapGrowthMB} MB`,
    ).toBeLessThan(THRESHOLDS.maxHeapGrowthMB);

    expect(
      report.metrics.cpuPercent,
      `CPU% ${report.metrics.cpuPercent.toFixed(1)} must be < ${THRESHOLDS.maxCpuPercent}`,
    ).toBeLessThan(THRESHOLDS.maxCpuPercent);
  });
});
