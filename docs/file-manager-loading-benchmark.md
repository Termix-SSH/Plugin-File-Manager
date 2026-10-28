# File Manager loading benchmark

## Scope

Compared unmodified upstream `d6e2526` with the current working tree, **not HEAD**, which already contains some fixes. Actual listing routes and actual frontend `listSSHFiles`/cache code run against HTTP and an encrypted loopback SSH/SFTP server. The server returns synthetic files; it never connects to your hosts, reads your files, or changes the installed plugin. This is protocol-level controlled evidence, **not live remote-host or whole-app click-to-paint timing**.

## Method and retained evidence

- Node v24.15.0, win32, AMD Ryzen 9 9900X 12-Core Processor, ssh2 1.17.0; same installed dependencies and input data for both versions.
- 15 measured rounds plus two warmups per variant, size and delay; baseline/current order alternates. Nearest-rank median and p95; with 15 samples p95 is the maximum, not a stable population-tail estimate.
- 0, 500 and 10,000 regular files, deterministic names and metadata, 100 entries per SFTP READDIR reply. Every successful response is checked for exact count, uniqueness and ordered filenames. No directories, symlinks, sudo or ls fallback in this fixture.
- Cold listing means a new uncached path on an **already established SSH/SFTP connection**. It includes HTTP, encrypted SFTP read, real route mapping/JSON serialization and client response parsing; excludes connection/auth setup, browser rendering and FileManager's own navigation debounce. Baseline `force` was not forwarded to the backend, but unique paths make every measured cold read uncached for both versions.
- Zero-delay replies are synchronous: **no setTimeout(0)**. An exploratory run with zero-delay timers was discarded, because Windows timer overhead would falsely inflate a LAN fixture. 20ms is a requested per-response service delay, not measured/calibrated network RTT. Windows timer quantization makes actual delays longer.
- The baseline ssh2 path-based read waits for CLOSE acknowledgement; the new helper returns after scheduling CLOSE. That real behavioral difference contributes to measured latency, especially for empty folders; it is not entirely pipelining. Both use the same real SFTP protocol and server.
- Browser benchmarking was also running on this machine for part of collection. No CPU isolation, controlled power profile or utilization trace; alternating versions limits order bias, but small differences are not statistically established.
- Production source SHA-256 before and after: `af527640033b77ac2c6fd9f298b8516e73ce5eac9c551ca9e4cf7cd84bab4396`. All three collected runs checked the source tree stayed unchanged. No checkout, stash, reset, commit, push or deployment.
- Raw per-round measurements, inputs/formula, environment and summaries: `scripts/benchmark-file-loading.mjs` regenerates them (raw data is not committed). Generated baseline snapshots and built bundles retained under temporary `fm-loading-bench-*` directories. The 0ms and 20ms rows come from separate runs; preliminary timer-backed 0ms rows were excluded.

## Uncached listing results

Times in milliseconds, median / p95. Positive change means slower.

| Requested reply delay |  Files |        Upstream |         Current | Median change |
| --------------------- | -----: | --------------: | --------------: | ------------: |
| 0ms                   |      0 |       1.0 / 2.2 |       1.0 / 2.3 |          2.4% |
| 0ms                   |    500 |       3.4 / 5.2 |       3.5 / 6.5 |          0.2% |
| 0ms                   | 10,000 |     48.9 / 74.1 |     45.9 / 66.8 |         -6.2% |
| 20ms                  |      0 |     93.2 / 93.8 |     62.5 / 63.9 |        -33.0% |
| 20ms                  |    500 |   248.4 / 251.4 |   154.1 / 156.1 |        -38.0% |
| 20ms                  | 10,000 | 3211.4 / 3248.7 | 1633.5 / 1658.3 |        -49.1% |

**Interpretation:** roughly 38% lower uncached listing latency for 500 files and 49% lower for 10,000 files in the delayed fixture. With no injected latency, 500 files are effectively unchanged and the 10k median improves only about 6%; this is not a universal 2x throughput claim. Small zero-delay regressions/tail changes are present in raw results, not hidden.

## Immediate reopen

Both upstream and current already have a short-lived cache. Reopen after each completed cold listing returned entirely from that cache, with no extra API request: medians were about 0.004–0.020ms across these cases. That is **data availability only, not display time**, and is not a new all-or-nothing cache benefit introduced by this PR. No cache-expiry or idle reconnect timing was measured.

## Hover prefetch over the real protocol fixture

500 files, 20ms requested per SFTP response. Both versions get the same time between hover start and click. Current uses the actual 100ms hover-dwell scheduler; the SDK admission callback is allowed immediately (resource-budget denial/defer is not benchmarked). Baseline makes no hover read.

| Hover before click | Variant  | Click-to-data median / p95 | Hover-to-data median | Ready when clicked | HTTP reads |
| ------------------ | -------- | -------------------------: | -------------------: | -----------------: | ---------: |
| 50ms               | Upstream |              253.6 / 267.4 |                312.1 |               0/15 |          1 |
| 50ms               | Current  |              159.0 / 166.9 |                217.2 |               0/15 |          1 |
| 500ms              | Upstream |              251.9 / 264.8 |                759.0 |               0/15 |          1 |
| 500ms              | Current  |              0.036 / 0.069 |                512.4 |              15/15 |          1 |

The 500ms lead case removes the wait **after clicking** because the read finished beforehand; it does not make SSH free or eliminate remote work. At 50ms the dwell never fires before navigation, so the remaining improvement is the faster cold listing, not a cache hit. All 15 measured reads per variant/lead returned the exact 500 filenames. This successful-target hover fixture does not measure automatic two-child prediction hit rate, wasted reads, browsing habits or SDK budget denial.

## Concurrent requests

Two direct HTTP requests for the same uncached session/path produced `200 + 409` upstream and `200 + 200` currently, consistently in the measured fixture; current shares one listing. Both variants opened one SFTP directory per duplicate pair. Completion time is recorded, but it is **not an equal-success performance comparison**: upstream rejects one consumer, while current also serializes and transfers its response. In the zero-delay 10k fixture, pair completion is about 50ms upstream versus 72ms currently; that extra work buys a second successful response and should not be disguised as a speedup. FileManager's old 409 retry delay is outside this benchmark.

## Reproduce

From the repository root with the existing dependencies and Windows tar:

```powershell
# A fresh temporary baseline, current bundles and results.json are generated.
node scripts/benchmark-file-loading.mjs

# Hover cases only. Each shell/process should use its own environment.
$env:FM_BENCH_PREDICT_ONLY = '1'
node scripts/benchmark-file-loading.mjs
Remove-Item Env:FM_BENCH_PREDICT_ONLY
```

Optional `FM_BENCH_RUNS`, `FM_BENCH_SIZES` and `FM_BENCH_DELAYS` control measured count and comma-separated fixture values. `FM_BENCH_OUTPUT` selects the output directory. The runner emits raw JSON, verifies every returned filename/count and source preservation, then closes the HTTP/SSH connections. The fixture host key is generated in memory and never saved.

## Evidence limits

Verified: comparable original/current code paths, real HTTP/encrypted SFTP exchange, successful response completeness, empty/500/10k listings, cold/reopen/hover/concurrent cases, all expected measurements retained, production source unchanged.

Not run: real user remote host/connection startup; installed Termix end-to-end navigation or tab/reconnect timings; sudo, symlink-heavy folders, mutations/cache invalidation, non-ssh2 servers, actual storage I/O and CPU/memory profiling. See [file-manager-render-benchmark.md](file-manager-render-benchmark.md) for separately measured Chromium rendering. **Do not add the separately measured loading and browser medians together as if they were a single observed end-to-end run.**
