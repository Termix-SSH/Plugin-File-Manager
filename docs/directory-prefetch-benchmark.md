# Directory prefetch benchmark

Run from the repository root with Node 24:

```sh
node scripts/benchmark-directory-prefetch.mjs
```

This controlled client benchmark uses the actual directory-prefetch scheduler
and keyed request cache with a Promise-based loader delayed by 120 ms. It is
not an SSH throughput or browser-rendering benchmark.

## Inputs

- Windows, Node v24.15.0; five independent runs.
- Each listing returns 484 entries; cache freshness is five seconds.
- Three candidate child directories; at most two are predicted, one at a time.
- Prediction starts after 200 ms; navigation occurs 500 ms after scheduling.
- Hover sweep crosses ten rows, spending 5 ms over each before leaving.

## Observed results

| Run    | Cold navigation (ms) | Ready-prefetched navigation (ms) |
| ------ | -------------------: | -------------------------------: |
| 1      |               126.44 |                           0.0210 |
| 2      |               122.64 |                           0.0197 |
| 3      |               124.93 |                           0.0554 |
| 4      |               127.26 |                           0.0235 |
| 5      |               124.03 |                           0.0704 |
| Median |           **124.93** |                       **0.0235** |

Cold navigation makes one loader request. Prediction makes two requests ahead
of navigation, including one folder that is not opened. Navigation to the ready
folder makes no additional request. Returned entries are asserted equal.

The hover sweep made **zero** requests with the 100 ms dwell gate. A separate
immediate-request fixture made ten; that comparison deliberately omits SDK
resource budgeting and is not a measurement of the previous app. Starting
foreground navigation before the prediction timer fired also made **zero**
speculative requests.

## Limits and trade-offs

Prefetch moves work ahead of the click, not out of the system. A folder that was
not predicted, a click before prefetch completes, or SDK budget denial still
requires waiting for the listing. The benchmark deliberately provides enough
lead time for both predicted folders to finish; it does not estimate prediction
hit rate, remote-host latency or rendering time. Extra reads are bounded but can
still consume remote resources. Live Termix navigation remains a separate check.

Streaming and stored backend snapshots are deferred: current evidence does not
justify sorted-row churn or a second mutation-sensitive cache. Existing client
cache entries are shared, and backend sharing covers in-flight reads only.
