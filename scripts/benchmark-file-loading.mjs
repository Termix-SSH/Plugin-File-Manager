// Actual listing routes + client API over HTTP and encrypted loopback SSH/SFTP.
// No user hosts, credentials, installed plugins or working-tree checkouts are used.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir, platform, cpus } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { once } from "node:events";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import express from "express";
import ssh2 from "ssh2";
import { createDirectoryPrefetch } from "../src/frontend/lib/directory-prefetch.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineRef = "d6e2526a8c0d800085e771a410412038e73776f6";
const out =
  process.env.FM_BENCH_OUTPUT ||
  mkdtempSync(path.join(tmpdir(), "fm-loading-bench-"));
mkdirSync(out, { recursive: true });
const before = path.join(out, "before");
mkdirSync(before, { recursive: true });
execFileSync("tar", ["-xf", "-", "-C", before], {
  input: execFileSync("git", ["archive", baselineRef], {
    cwd: root,
    maxBuffer: 30_000_000,
  }),
});
const sourceHash = () => {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        hash.update(path.relative(root, file));
        hash.update(readFileSync(file));
      }
    }
  };
  walk(path.join(root, "src"));
  return hash.digest("hex");
};
const originalHash = sourceHash();
const variants = [];
for (const [name, src] of [
  ["before", before],
  ["after", root],
]) {
  const backendFile = path.join(out, `${name}-backend.mjs`);
  const apiFile = path.join(out, `${name}-api.mjs`);
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [path.join(root, "node_modules")],
    logLevel: "silent",
  };
  await build({
    ...common,
    entryPoints: [path.join(src, "src/backend/list-routes.ts")],
    outfile: backendFile,
    plugins: [
      {
        name: "session-boundary",
        setup(b) {
          b.onResolve({ filter: /^\.\/session\.js$/ }, () => ({
            path: "session",
            namespace: "bench",
          }));
          b.onLoad({ filter: /.*/, namespace: "bench" }, () => ({
            contents: `export const getSessionSftp = () => Promise.resolve(globalThis.__fmSftp); export const execChannel = () => { throw Error('Unexpected fallback'); };`,
          }));
        },
      },
    ],
  });
  await build({
    ...common,
    entryPoints: [
      path.join(src, "src/frontend/api/ssh-file-operations-api.ts"),
    ],
    outfile: apiFile,
    plugins: [
      {
        name: "http-boundary",
        setup(b) {
          b.onResolve({ filter: /^\.\/client$/ }, () => ({
            path: "client",
            namespace: "bench",
          }));
          b.onResolve({ filter: /^@termix-ssh\/plugin-sdk\/ui$/ }, () => ({
            path: "sdk",
            namespace: "bench",
          }));
          b.onResolve({ filter: /^axios$/ }, () => ({
            path: "axios",
            namespace: "bench",
          }));
          b.onLoad({ filter: /.*/, namespace: "bench" }, ({ path: p }) => ({
            contents:
              p === "client"
                ? `export const getFileManagerApiForSession=()=>globalThis.__fmHttp; export const handleApiError=e=>{throw e}; export const setSessionOrigin=()=>{}; export const clearSessionOrigin=()=>{};`
                : p === "sdk"
                  ? `export const createFrontendLogger=()=>({info(){},warn(){},error(){},success(){}}); export const resolveConnectionOrigin=()=> 'local';`
                  : `export default {};`,
          }));
        },
      },
    ],
  });
  variants.push({
    name,
    routes: await import(pathToFileURL(backendFile)),
    api: await import(pathToFileURL(apiFile)),
  });
}

let latencyMs = 0;
let operations = { opendir: 0, readdir: 0, close: 0 };
const batchSize = 100;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const server = new ssh2.Server({ hostKeys: [privateKey] }, (connection) => {
  connection.setNoDelay(true);
  connection.on("authentication", (ctx) => ctx.accept()); // Loopback-only, ephemeral synthetic data.
  connection.on("ready", () =>
    connection.on("session", (accept) =>
      accept().on("sftp", (accept) => {
        const sftp = accept();
        const handles = new Map();
        let next = 0;
        const reply = (fn) =>
          latencyMs > 0 ? setTimeout(fn, latencyMs) : fn();
        sftp.on("OPENDIR", (id, p) => {
          operations.opendir++;
          const count = Number(p.split("/").at(-1));
          assert(Number.isSafeInteger(count) && count >= 0);
          const key = String(++next);
          handles.set(key, { count, index: 0 });
          reply(() => sftp.handle(id, Buffer.from(key)));
        });
        sftp.on("READDIR", (id, handle) => {
          operations.readdir++;
          const state = handles.get(handle.toString());
          assert(state);
          const start = state.index;
          state.index += batchSize;
          const entries = Array.from(
            { length: Math.max(0, Math.min(batchSize, state.count - start)) },
            (_, offset) => {
              const index = start + offset;
              const filename = `file-${String(index).padStart(5, "0")}.txt`;
              return {
                filename,
                longname: `-rw-r--r-- 1 1000 1000 ${index} Oct 28 2026 ${filename}`,
                attrs: {
                  mode: 0o100644,
                  uid: 1000,
                  gid: 1000,
                  size: index,
                  atime: 1793145600,
                  mtime: 1793145600,
                },
              };
            },
          );
          reply(() =>
            entries.length
              ? sftp.name(id, entries)
              : sftp.status(id, ssh2.utils.sftp.STATUS_CODE.EOF),
          );
        });
        sftp.on("CLOSE", (id, handle) => {
          operations.close++;
          handles.delete(handle.toString());
          reply(() => sftp.status(id, ssh2.utils.sftp.STATUS_CODE.OK));
        });
      }),
    ),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const client = new ssh2.Client();
client.connect({
  host: "127.0.0.1",
  port: server.address().port,
  username: "fixture",
  readyTimeout: 10000,
});
await once(client, "ready");
client.setNoDelay(true);
globalThis.__fmSftp = await new Promise((resolve, reject) =>
  client.sftp((e, s) => (e ? reject(e) : resolve(s))),
);
const app = express();
for (const variant of variants) {
  const router = express.Router();
  variant.routes.registerFileListingRoutes(router, {
    ctx: {
      currentActor: () => "fixture",
      log: { info() {}, warn() {}, error() {} },
    },
    sshSessions: { s: { isConnected: true, activeOperations: 0 } },
    activeListRequests: {},
    verifySessionOwnership: () => true,
  });
  app.use("/" + variant.name, router);
}
const http = app.listen(0, "127.0.0.1");
await once(http, "listening");
const base = `http://127.0.0.1:${http.address().port}`;
let requests = 0;
const setApi = (name) => {
  globalThis.__fmHttp = {
    get: async (url, { params }) => {
      requests++;
      const response = await fetch(
        `${base}/${name}${url}?${new URLSearchParams(params)}`,
      );
      const data = await response.json();
      if (!response.ok) throw { response: { data, status: response.status } };
      return { data };
    },
  };
};
const verify = (value, count) => {
  assert.equal(value.files.length, count);
  assert.equal(new Set(value.files.map((f) => f.name)).size, count);
  for (let i = 0; i < count; i++)
    assert.equal(value.files[i].name, `file-${String(i).padStart(5, "0")}.txt`);
};
const samples = [];
const runs = Number(process.env.FM_BENCH_RUNS || 15);
const delays = (process.env.FM_BENCH_DELAYS || "0,20").split(",").map(Number);
const sizes = (process.env.FM_BENCH_SIZES || "0,500,10000")
  .split(",")
  .map(Number);
if (process.env.FM_BENCH_PREDICT_ONLY === "1") sizes.length = 0;
const time = async (fn) => {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
};
try {
  for (const delay of delays)
    for (const count of sizes) {
      latencyMs = delay;
      for (let run = -2; run < runs; run++) {
        for (const v of run % 2 === 0 ? variants : [...variants].reverse()) {
          setApi(v.name);
          const dir = `/fixture/${run}/${v.name}/${count}`;
          const startOps = { ...operations };
          const startRequests = requests;
          const cold = await time(() =>
            v.api.listSSHFiles("s", dir, { force: true }),
          );
          verify(cold.result, count);
          const repeat = await time(() => v.api.listSSHFiles("s", dir));
          verify(repeat.result, count);
          // Same two HTTP requests issued concurrently; bypass frontend cache to
          // measure the route's sharing/conflict policy directly.
          const duplicatePath = `${dir}/duplicate/${count}`;
          const duplicates = await time(() =>
            Promise.all(
              [0, 1].map(async () => {
                const r = await fetch(
                  `${base}/${v.name}/listFiles?sessionId=s&path=${encodeURIComponent(duplicatePath)}`,
                );
                const body = await r.json();
                if (r.ok) verify(body, count);
                return r.status;
              }),
            ),
          );
          if (run >= 0)
            samples.push({
              variant: v.name,
              delayMs: delay,
              count,
              run,
              coldMs: cold.ms,
              repeatMs: repeat.ms,
              duplicateMs: duplicates.ms,
              duplicateStatuses: duplicates.result,
              httpRequests: requests - startRequests,
              operations: Object.fromEntries(
                Object.keys(operations).map((k) => [
                  k,
                  operations[k] - startOps[k],
                ]),
              ),
            });
        }
      }
      console.log(`Completed delay=${delay}ms entries=${count}`);
    }
  const intentSamples = [];
  if (process.env.FM_BENCH_PREDICT_ONLY === "1") {
    latencyMs = 20;
    for (const leadMs of [50, 500]) {
      for (let run = -2; run < runs; run++) {
        for (const v of run % 2 === 0 ? variants : [...variants].reverse()) {
          setApi(v.name);
          const dir = `/hover/${leadMs}/${run}/${v.name}/500`;
          const startRequests = requests;
          const complete = new Set();
          let background;
          const scheduler = createDirectoryPrefetch({
            read: (p) =>
              (background = v.api
                .listSSHFiles("s", p, { prefetch: true })
                .then((r) => {
                  verify(r, 500);
                  complete.add(p);
                })),
            isCached: (p) => complete.has(p),
            run: (task) => {
              void task();
              return true;
            },
          });
          const interactionStart = performance.now();
          if (v.name === "after") scheduler.hover(dir);
          await new Promise((resolve) => setTimeout(resolve, leadMs));
          const readyAtClick = complete.has(dir);
          scheduler.setForeground(true);
          const clicked = await time(() => v.api.listSSHFiles("s", dir));
          verify(clicked.result, 500);
          await background;
          scheduler.dispose();
          if (run >= 0)
            intentSamples.push({
              variant: v.name,
              leadMs,
              run,
              clickToLoadedMs: clicked.ms,
              hoverToLoadedMs: performance.now() - interactionStart,
              readyAtClick,
              httpRequests: requests - startRequests,
            });
        }
      }
    }
  }
  assert.equal(sourceHash(), originalHash, "Benchmark changed source files");
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const summary = [];
  for (const delay of delays)
    for (const count of sizes)
      for (const v of variants) {
        const group = samples.filter(
          (s) =>
            s.delayMs === delay && s.count === count && s.variant === v.name,
        );
        summary.push({
          variant: v.name,
          delayMs: delay,
          count,
          samples: group.length,
          ...Object.fromEntries(
            ["coldMs", "repeatMs", "duplicateMs"].flatMap((k) => [
              [
                k + "Median",
                percentile(
                  group.map((s) => s[k]),
                  0.5,
                ),
              ],
              [
                k + "P95",
                percentile(
                  group.map((s) => s[k]),
                  0.95,
                ),
              ],
            ]),
          ),
          duplicateStatuses: group[0].duplicateStatuses,
        });
      }
  writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(
      {
        baselineRef,
        currentSourceHash: originalHash,
        sourceUnchanged: true,
        environment: {
          node: process.version,
          platform: platform(),
          cpu: cpus()[0]?.model,
          ssh2: "1.17.0",
        },
        method: {
          runs,
          warmups: 2,
          batchSize,
          delays,
          sizes,
          order: "alternating",
          fixture:
            "real encrypted loopback SSH/SFTP with synthetic data and per-response delay; actual routes/API; existing SSH/SFTP connection; no real user remote or browser",
        },
        summary,
        samples,
        intentSamples,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ out, summary }, null, 2));
} finally {
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  globalThis.__fmSftp.end();
  client.end();
  server.close();
}
