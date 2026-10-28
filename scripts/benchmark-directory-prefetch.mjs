// Controlled client benchmark, not a remote-host or browser-rendering benchmark.
// Run with Node 24: node scripts/benchmark-directory-prefetch.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createDirectoryPrefetch } from "../src/frontend/lib/directory-prefetch.ts";
import { createKeyedRequestCache } from "../src/frontend/lib/keyed-request-cache.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inputs = {
  runs: 5,
  listingDelayMs: 120,
  entries: 484,
  predictionLeadMs: 500,
  sweepRows: 10,
  sweepDwellMs: 5,
};
const entries = Array.from({ length: inputs.entries }, (_, index) => ({
  name: `file-${index}`,
  path: `/parent/a/file-${index}`,
  type: "file",
  size: index,
}));
const children = ["a", "b", "c"].map((name) => ({
  name,
  path: `/parent/${name}`,
  type: "directory",
}));

function fixture() {
  const cache = createKeyedRequestCache(5_000, 150);
  let calls = 0;
  const read = (path) =>
    cache.get(path, async () => {
      calls++;
      await delay(inputs.listingDelayMs);
      return entries;
    });
  const scheduler = createDirectoryPrefetch({
    read,
    isCached: (path) => cache.peek(path, 5_000) !== null,
    run: (task) => {
      void task().catch(() => {});
      return true;
    },
  });
  return { read, scheduler, calls: () => calls };
}

const runs = [];
for (let run = 0; run < inputs.runs; run++) {
  const cold = fixture();
  let start = performance.now();
  assert.deepEqual(await cold.read("/parent/a"), entries);
  const coldMs = performance.now() - start;
  cold.scheduler.dispose();

  const predicted = fixture();
  predicted.scheduler.predict("/parent", children);
  await delay(inputs.predictionLeadMs);
  predicted.scheduler.setForeground(true);
  start = performance.now();
  assert.deepEqual(await predicted.read("/parent/a"), entries);
  const predictedMs = performance.now() - start;
  assert.equal(
    predicted.calls(),
    2,
    "Only two direct children should be prefetched",
  );
  predicted.scheduler.dispose();
  runs.push({
    run,
    coldMs,
    predictedMs,
    coldRequests: cold.calls(),
    predictedRequests: predicted.calls(),
  });
}

const immediateSweep = fixture();
await Promise.all(
  Array.from({ length: inputs.sweepRows }, (_, index) =>
    immediateSweep.read(`/parent/sweep-${index}`),
  ),
);
immediateSweep.scheduler.dispose();
const sweep = fixture();
for (let index = 0; index < inputs.sweepRows; index++) {
  const path = `/parent/sweep-${index}`;
  sweep.scheduler.hover(path);
  await delay(inputs.sweepDwellMs);
  sweep.scheduler.cancelIntent(path);
}
await delay(150);
assert.equal(sweep.calls(), 0);
sweep.scheduler.dispose();

const cancelled = fixture();
cancelled.scheduler.predict("/parent", children);
cancelled.scheduler.setForeground(true);
await delay(250);
assert.equal(cancelled.calls(), 0);
cancelled.scheduler.dispose();

const median = (key) =>
  [...runs].sort((a, b) => a[key] - b[key])[Math.floor(runs.length / 2)][key];
console.log(
  JSON.stringify(
    {
      environment: { node: process.version, platform: process.platform },
      fixture:
        "Controlled 120ms Promise-based listing; actual scheduler/cache; immediate-hover comparison omits SDK budget; no SSH/browser",
      inputs,
      medians: {
        coldMs: +median("coldMs").toFixed(2),
        prefetchedNavigationMs: +median("predictedMs").toFixed(2),
      },
      sweep: {
        immediateHoverFixtureRequests: immediateSweep.calls(),
        deliberateHoverRequests: sweep.calls(),
      },
      foregroundCancelledPredictionRequests: cancelled.calls(),
      runs,
    },
    null,
    2,
  ),
);
