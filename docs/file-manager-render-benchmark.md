# File Manager rendering benchmark

## Scope and result

**Controlled production-browser component harness, not live Termix or SSH.** Baseline: `d6e2526a8c0d800085e771a410412038e73776f6`. Current: snapshotted **working-tree files**, not HEAD (HEAD was `e0cbccdd43aac094145a91ea4932d406d16db9d8`). Source snapshot taken 2026-10-28T02:53:07.042Z; finished 2026-10-28T02:55:35.754Z. The current grid source still matches its snapshot after sampling: **true**.

At 10,000 input entries, initial/update medians changed as follows:

- list initial: **314.1 → 41.2 ms** (-86.9%).
- list update: **298.6 → 37.5 ms** (-87.4%).
- grid initial: **302.7 → 43.7 ms** (-85.6%).
- grid update: **296.2 → 34.9 ms** (-88.2%).

These timings include the actual filtering/sorting code as well as React updates/layout. They do **not** isolate a pure grid-render speedup. The original uses per-comparison localeCompare options; current uses its real shared Intl.Collator helper. This is a plausible contributor, not separately profiled causal attribution.

## Reproduction and artifacts

Run from the repository with already installed dependencies (no install step):

```powershell
node scripts/benchmark-file-rendering.cjs "$PWD" "$env:TEMP\fm-render-repeat-unique"
```

Use a new output directory. The runner archives the upstream commit into temp, copies current frontend sources, builds two minified production esbuild bundles against the same node_modules, starts a loopback HTTP server, launches the installed Playwright CLI package's Chromium, and closes browser/server afterward. No checkout/stash/reset, deployed plugin changes, or remote access. It writes raw JSONL, exact generated inputs, source snapshots, entry/filter harness source, compiled CSS/bundles, esbuild metafiles, metadata and summary into that output directory.

Retained run directory: `C:\Users\deanm\AppData\Local\Temp\fm-render-benchmark-20261028-025055`. Primary script: `scripts/benchmark-file-rendering.cjs`. Raw samples are not committed; rerun the script to regenerate them. Source/filter SHA-256 hashes and initial dirty-tree status are in metadata. Full original source snapshot and entry are retained in temp; repeat runs intentionally sample whatever working-tree state then exists.

## Method

- AMD Ryzen 9 9900X 12-Core Processor, 24 logical CPUs; win32 10.0.26300; Node v24.15.0; Chromium 155.0.8059.12; React 19.3.1; react-virtual 3.14.21; esbuild 0.28.2; Tailwind 4.3.3. No throttling.
- Viewport 1200×850, component pane 1000×640, comfortable density. Actual scroller geometry recorded per sample. Inputs: 0, 500, 10,000 seeded-shuffled entries, 10% directories, fixed metadata; both list and grid. Full inputs retained.
- Actual FileManagerGrid and local dependencies are bundled without source modifications. Baseline filter/sort expression is extracted verbatim from baseline FileManager.tsx; current imports actual file-list.ts. Only host SDK cn and translation boundaries are stubbed. **No react-virtual, ResizeObserver, RAF or DOM-geometry mocks.**
- Production CSS: installed SDK `theme.css` plus actual Tailwind theme/preflight/utilities, scanned from both source snapshots and shared by both variants. SDK thin-scrollbar utility is included. A tiny wrapper supplies pane dimensions, ordinary Arial font and neutral CSS palette variables; **not host-perfect fonts, theme/chrome or application CSS**. An earlier exploratory simplified-theme run was discarded and is not used in this report.
- Two unmeasured warmup pairs per size/mode, then **15 measured samples per variant/size/mode/action**. Baseline/current order alternates each round. Fresh page per variant; script/CSS already loaded before initial timer starts. No navigation, network listing, build or Playwright protocol time is included.
- Initial: root.render to two requestAnimationFrame callbacks. Update/filter/sort/show: real DOM button click handler to two RAF callbacks, then filename/count/geometry inspection. Clicks are programmatic HTMLElement.click(), not trusted hardware input. This is an action-to-two-frame paint-opportunity proxy, **not GPU presentation instrumentation**. Checks run after the timer.
- Update changes every path/name with the same count. fullShow hides the full listing after a real middle scroll with display:none, waits four RAFs, then measures show. Hidden display and zero height are recorded. Filter uses substring "7" (0/95/3439 resulting entries); sort then reverses name order with directories first. show repeats hide/show on that filtered listing. Scroll-to-end additionally checks the last expected filename.
- Median is nearest-rank p50; p95 is nearest rank ceil(0.95×15), hence the maximum of 15. No significance intervals or claim that small differences are reliable.
- **Potential concurrent CPU contention:** parent ran its independent backend benchmark on this machine. No CPU isolation or utilization recording was used. Alternation limits order bias but cannot remove changing background load. Interpret small deltas/tails cautiously.

## Observed timings

All times in ms; columns are median / p95. Positive delta means current was slower.

| View | Input entries | Action   | Baseline median / p95 | Current median / p95 | Current median delta |
| ---- | ------------: | -------- | --------------------: | -------------------: | -------------------: |
| list |             0 | initial  |           19.9 / 33.1 |          28.3 / 33.2 |          8.4 (42.2%) |
| list |             0 | update   |           31.5 / 33.3 |          31.2 / 32.3 |         -0.3 (-1.0%) |
| list |             0 | fullShow |           30.6 / 32.6 |          30.5 / 31.9 |         -0.1 (-0.3%) |
| list |             0 | filter   |           31.9 / 33.4 |          32.0 / 32.7 |           0.1 (0.3%) |
| list |             0 | sort     |           31.4 / 33.1 |          31.3 / 33.2 |         -0.1 (-0.3%) |
| list |             0 | show     |           32.5 / 33.5 |          32.0 / 33.2 |         -0.5 (-1.5%) |
| list |           500 | initial  |           28.5 / 33.2 |          29.3 / 33.0 |           0.8 (2.8%) |
| list |           500 | update   |           30.1 / 32.6 |          30.9 / 32.3 |           0.8 (2.7%) |
| list |           500 | fullShow |           31.1 / 32.6 |          30.9 / 31.9 |         -0.2 (-0.6%) |
| list |           500 | filter   |           31.9 / 33.0 |          31.6 / 32.8 |         -0.3 (-0.9%) |
| list |           500 | sort     |           30.2 / 31.4 |          30.6 / 32.8 |           0.4 (1.3%) |
| list |           500 | show     |           31.9 / 33.1 |          31.8 / 33.3 |         -0.1 (-0.3%) |
| list |        10,000 | initial  |         314.1 / 344.7 |          41.2 / 48.4 |      -272.9 (-86.9%) |
| list |        10,000 | update   |         298.6 / 322.5 |          37.5 / 47.0 |      -261.1 (-87.4%) |
| list |        10,000 | fullShow |           31.2 / 33.0 |          30.2 / 32.5 |         -1.0 (-3.2%) |
| list |        10,000 | filter   |          97.1 / 108.5 |          31.9 / 37.9 |       -65.2 (-67.1%) |
| list |        10,000 | sort     |          92.4 / 104.9 |          29.4 / 31.8 |       -63.0 (-68.2%) |
| list |        10,000 | show     |           31.9 / 33.2 |          31.5 / 33.6 |         -0.4 (-1.3%) |
| grid |             0 | initial  |           28.8 / 34.1 |          19.4 / 32.1 |        -9.4 (-32.6%) |
| grid |             0 | update   |           31.1 / 33.3 |          31.1 / 32.3 |           0.0 (0.0%) |
| grid |             0 | fullShow |           30.6 / 31.7 |          31.4 / 32.6 |           0.8 (2.6%) |
| grid |             0 | filter   |           32.1 / 33.0 |          31.9 / 32.9 |         -0.2 (-0.6%) |
| grid |             0 | sort     |           31.4 / 32.7 |          32.0 / 32.8 |           0.6 (1.9%) |
| grid |             0 | show     |           32.0 / 33.2 |          31.9 / 32.9 |         -0.1 (-0.3%) |
| grid |           500 | initial  |           28.9 / 30.8 |          28.6 / 30.6 |         -0.3 (-1.0%) |
| grid |           500 | update   |           27.8 / 30.3 |          28.1 / 29.7 |           0.3 (1.1%) |
| grid |           500 | fullShow |           30.6 / 32.4 |          30.8 / 32.4 |           0.2 (0.7%) |
| grid |           500 | filter   |           31.8 / 32.7 |          31.8 / 32.7 |           0.0 (0.0%) |
| grid |           500 | sort     |           29.0 / 30.0 |          29.1 / 30.4 |           0.1 (0.3%) |
| grid |           500 | show     |           31.8 / 33.5 |          32.4 / 33.2 |           0.6 (1.9%) |
| grid |        10,000 | initial  |         302.7 / 366.9 |          43.7 / 53.9 |      -259.0 (-85.6%) |
| grid |        10,000 | update   |         296.2 / 371.2 |          34.9 / 46.7 |      -261.3 (-88.2%) |
| grid |        10,000 | fullShow |           31.1 / 32.8 |          30.8 / 33.1 |         -0.3 (-1.0%) |
| grid |        10,000 | filter   |          96.6 / 112.4 |          31.9 / 33.2 |       -64.7 (-67.0%) |
| grid |        10,000 | sort     |          89.6 / 108.3 |          28.7 / 30.3 |       -60.9 (-68.0%) |
| grid |        10,000 | show     |           32.2 / 34.2 |          32.2 / 34.9 |           0.0 (0.0%) |

Observed median regressions (including tiny frame-noise-scale changes, not hidden): list/0/initial: +8.4 ms (+42.2%); list/0/filter: +0.1 ms (+0.3%); list/500/initial: +0.8 ms (+2.8%); list/500/update: +0.8 ms (+2.7%); list/500/sort: +0.4 ms (+1.3%); grid/0/fullShow: +0.8 ms (+2.6%); grid/0/sort: +0.6 ms (+1.9%); grid/500/update: +0.3 ms (+1.1%); grid/500/fullShow: +0.2 ms (+0.7%); grid/500/sort: +0.1 ms (+0.3%); grid/500/show: +0.6 ms (+1.9%); grid/10000/show: +0.0 ms (+0.0%). These are descriptive, not proof of a significant regression.

## Correctness and geometry evidence

180 measured variant runs, 1080 action checks. Browser page errors: 0. Per-action checks and scroll-end failures: 0; independent numeric-filename/directory-first oracle failures: 0. The independent oracle checks matching counts, prefixes, contiguous visible filename order and top filename for initial/update/filter/sort. It does not rely solely on the same helper supplying expected files.

Below ranges are from initial/update/fullShow only (unfiltered input counts); rendered includes overscan, visible means actual rectangle intersection with scroller. These bounded counts disprove fake all-row rendering for large cases. List baseline uses measured content heights; current uses fixed 41px stride. Geometry differences are reported rather than calling both layouts pixel-identical.

| View / input / variant | DOM file nodes | Visible file nodes | Observed row strides (px) |
| ---------------------- | -------------: | -----------------: | ------------------------- |
| list/0/baseline        |            0–0 |                0–0 | n/a                       |
| list/0/current         |            0–0 |                0–0 | n/a                       |
| list/500/baseline      |          32–48 |              15–17 | 40                        |
| list/500/current       |          32–48 |              14–16 | 41                        |
| list/10000/baseline    |          32–48 |              15–17 | 40                        |
| list/10000/current     |          32–48 |              14–16 | 41                        |
| grid/0/baseline        |            0–0 |                0–0 | n/a                       |
| grid/0/current         |            0–0 |                0–0 | n/a                       |
| grid/500/baseline      |         96–152 |              48–48 | 112                       |
| grid/500/current       |         96–152 |              48–48 | 112                       |
| grid/10000/baseline    |         96–144 |              48–48 | 112                       |
| grid/10000/current     |         96–144 |              48–48 | 112                       |

Both versions recovered visible rows in the tested display:none→shown scenario; this run does **not** reproduce the original live-host blank-tab failure and must not be cited as its definitive fix verification.

## Acceptance evidence matrix

| Criterion                                                       | Status   | Exact check and observed outcome                                                                                                              |
| --------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact upstream versus current working tree                      | verified | git archive of d6e2526…; copied live frontend; source hashes retained; current grid unchanged after samples: true                             |
| Actual production grid and shared dependency versions           | verified | Two esbuild minified NODE_ENV=production bundles; metafiles retained; same installed React/react-virtual/esbuild; SDK-only boundaries stubbed |
| Actual browser, utilities and DOM geometry                      | verified | Installed Playwright package Chromium 155.0.8059.12; installed SDK theme and Tailwind-generated CSS; no virtualizer/geometry mocks            |
| Repeated initial/update/list/grid/empty/500/10k timings         | verified | 15 measured + 2 warmup samples for each variant/size/mode/action; alternating pair order; raw JSONL retained                                  |
| Full and filtered tab hide/show                                 | verified | fullShow and show each timed; fullHidden records display:none and height=0; visible filenames/geometries recovered                            |
| Filename/count/order/geometry/virtualization checks             | verified | 1080 independent action oracle checks; 0 failures; raw visible names/rectangles, bounded nodes, footer counts and final filename checks       |
| Median/p95, raw inputs/results, regressions                     | verified | Complete table above; summary.json + gzipped raw samples/input JSON; positive median deltas listed                                            |
| Live Termix/SSH, actual reported blank-tab bug                  | not_run  | Isolated component shell only; both versions recover in this controlled scenario                                                              |
| Hardware click-to-display/GPU paint and isolated CPU timings    | not_run  | Programmatic DOM events/two RAF paint-opportunity proxy; concurrent workload not isolated                                                     |
| Production code, installed plugin and unrelated edits preserved | verified | No production edits; only benchmark script/report/evidence added; other dirty-tree changes retained                                           |

Skipped live host/SSH, compact density, varied viewport/font/theme, drag/edit/selection stress and GPU presentation timing. Small timing deltas and p95 tails remain sensitive to frame phase and concurrent CPU load.
