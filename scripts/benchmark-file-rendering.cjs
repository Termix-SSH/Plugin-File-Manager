// Controlled browser component benchmark; no live host/SSH access. Windows: node scripts/benchmark-file-rendering.cjs [repository] [new-output-directory]
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  cp = require("node:child_process"),
  crypto = require("node:crypto"),
  http = require("node:http");
const repo = path.resolve(process.argv[2] || process.cwd()),
  dir = process.argv[3]
    ? path.resolve(process.argv[3])
    : fs.mkdtempSync(path.join(os.tmpdir(), "fm-render-benchmark-")),
  base = "d6e2526a8c0d800085e771a410412038e73776f6";
const req = require("node:module").createRequire(
  path.join(repo, "package.json"),
);
const esbuild = req("esbuild"),
  { compile } = req("@tailwindcss/node"),
  { Scanner } = req("@tailwindcss/oxide");
const { chromium } = require(
  path.join(
    process.env.APPDATA,
    "npm/node_modules/@playwright/cli/node_modules/playwright",
  ),
);
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  if (path.resolve(__filename) !== path.join(dir, "benchmark.cjs"))
    fs.copyFileSync(__filename, path.join(dir, "benchmark.cjs"));
  const status = cp.execFileSync("git", ["status", "--short"], {
    cwd: repo,
    encoding: "utf8",
  });
  for (const variant of ["baseline", "current"])
    fs.mkdirSync(path.join(dir, variant), { recursive: true });
  cp.execFileSync(
    "git",
    [
      "archive",
      base,
      "--format=tar",
      "--output=" + path.join(dir, "baseline.tar"),
      "src/frontend",
    ],
    { cwd: repo },
  );
  cp.execFileSync("tar", [
    "-xf",
    path.join(dir, "baseline.tar"),
    "-C",
    path.join(dir, "baseline"),
  ]);
  fs.cpSync(
    path.join(repo, "src/frontend"),
    path.join(dir, "current/src/frontend"),
    { recursive: true },
  );
  const baselineManager = fs.readFileSync(
    path.join(dir, "baseline/src/frontend/FileManager.tsx"),
    "utf8",
  );
  const start = baselineManager.indexOf("  const filteredFiles = useMemo("),
    end = baselineManager.indexOf(
      "    [files, searchQuery, sortBy, sortOrder],",
      start,
    );
  if (start < 0 || end < 0)
    throw Error("Cannot extract exact baseline filter expression");
  const body = baselineManager
    .slice(start, end)
    .split("() =>")[1]
    .trim()
    .replace(/,\s*$/, "");
  fs.writeFileSync(
    path.join(dir, "baseline/filter.ts"),
    "export const filterAndSortFiles = (files, searchQuery, sortBy, sortOrder) => " +
      body +
      ";\n",
  );
  fs.writeFileSync(
    path.join(dir, "current/filter.ts"),
    'export {filterAndSortFiles} from "./src/frontend/file-list.ts";\n',
  );
  const entry = String.raw`
import React,{useState,useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {FileManagerGrid} from './src/frontend/FileManagerGrid.tsx';
import {filterAndSortFiles} from './filter.ts';
const params=new URLSearchParams(location.search),n=Number(params.get('n')),mode=params.get('mode');
let seed=123456789; const raw=Array.from({length:n},(_,i)=>({name:'file-'+String(i).padStart(5,'0')+'.txt',path:'/a/file-'+String(i).padStart(5,'0')+'.txt',type:i%10===0?'directory':'file',size:i*137,owner:'bench',group:'bench',permissions:'-rw-r--r--',modified:'2026-10-01',modifiedTimestamp:1790812800+i}));
for(let i=raw.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[raw[i],raw[j]]=[raw[j],raw[i]];}
window.input={n,mode,seed:123456789};window.dataset=raw;
const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.frames2=frames;
const root=createRoot(document.getElementById('root'));
function App(){const [folder,setFolder]=useState('a'),[query,setQuery]=useState(''),[order,setOrder]=useState('asc'),[hidden,setHidden]=useState(false),[selected,setSelected]=useState([]);
const files=useMemo(()=>raw.map(f=>({...f,name:(folder==='b'?'updated-':'')+f.name,path:'/'+folder+'/'+f.name})),[folder]);
const filtered=useMemo(()=>filterAndSortFiles(files,query,'name',order),[files,query,order]);window.expected=filtered;window.state={folder,query,order,hidden};
return <><nav><button id="update" onClick={()=>{setFolder('b');setSelected([])}}>Update directory</button><button id="filter" onClick={()=>setQuery('7')}>Filter</button><button id="sort" onClick={()=>setOrder('desc')}>Sort</button><button id="hide" onClick={()=>setHidden(true)}>Hide tab</button><button id="show" onClick={()=>setHidden(false)}>Show tab</button></nav><section id="pane" style={{display:hidden?'none':'block',height:640,width:1000}}><FileManagerGrid files={filtered} selectedFiles={selected} onSelectionChange={setSelected} onFileOpen={()=>{}} onRefresh={()=>{}} viewMode={mode} density="comfortable" sortBy="name" sortOrder={order}/></section></>}
window.mount=()=>root.render(<App/>);
window.check=()=>{const pane=document.querySelector('#pane'),scroller=pane?.querySelector('.overflow-y-auto'),sr=scroller?.getBoundingClientRect();const expected=window.expected||[];const allowed=new Set(expected.map(f=>f.path));const rows=[...(pane?.querySelectorAll('[data-file-path]')||[])].map(el=>{const r=el.getBoundingClientRect();return{path:el.dataset.filePath,name:el.querySelector('[title]')?.getAttribute('title')||el.title,x:r.x,y:r.y,width:r.width,height:r.height,visible:!!sr&&r.bottom>sr.top&&r.top<sr.bottom&&r.right>sr.left&&r.left<sr.right}});const visible=rows.filter(r=>r.visible);const ys=[...new Set(visible.map(r=>r.y))].sort((a,b)=>a-b);const gaps=ys.slice(1).map((y,i)=>y-ys[i]);const errors=[];
if(!scroller||!sr||sr.height<100||sr.width<500)errors.push('missing/collapsed scroller');
if(expected.length&&!visible.length)errors.push('no visible rows');if(!expected.length&&rows.length)errors.push('rows in empty listing');
if(rows.some(r=>!allowed.has(r.path)))errors.push('unexpected filename/path');
if(rows.some(r=>r.name!==expected.find(f=>f.path===r.path)?.name))errors.push('filename mismatch');
if(rows.some(r=>r.width<=0||r.height<=0))errors.push('zero geometry');
if(expected.length>500&&rows.length>=expected.length)errors.push('all rows rendered, not virtualized');
if(mode==='list'&&gaps.some(g=>g<20||g>43))errors.push('list spacing outside 20..43px');if(mode==='grid'&&gaps.some(g=>Math.abs(g-112)>1))errors.push('grid row stride is not 112px');
if(!expected.length&&!pane?.textContent.includes('fileManager.emptyFolder'))errors.push('missing empty state');
if(!pane?.textContent.includes(expected.length+' fileManager.items'))errors.push('footer count mismatch');
return {errors,expectedCount:expected.length,renderedCount:rows.length,visibleCount:visible.length,visibleNames:visible.map(r=>r.name),visibleRows:visible,firstExpected:expected[0]?.name,lastExpected:expected.at(-1)?.name,scrollTop:scroller?.scrollTop,scrollHeight:scroller?.scrollHeight,scroller:sr?{width:sr.width,height:sr.height,x:sr.x,y:sr.y}:null,gaps};};
window.perform=async(action)=>{const start=performance.now();if(action==='initial')window.mount();else document.getElementById(action).click();await frames();const elapsed=performance.now()-start;return{ms:elapsed,check:window.check(),state:window.state};};
`;
  fs.writeFileSync(path.join(dir, "entry-template.tsx"), entry);
  // shortcut: only SDK cn/i18n are stubbed, use the host application for integration coverage.
  const sdkStub = `export const cn=(...xs)=>xs.filter(Boolean).join(' ');export const useTranslation=()=>({t:key=>key});`;
  const metadata = {
    created: new Date().toISOString(),
    baseline: base,
    currentHead: cp
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      })
      .trim(),
    currentSource: "working-tree snapshot, not HEAD",
    status,
    os: os.platform() + " " + os.release(),
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    node: process.version,
    versions: {},
    inputs: {
      sizes: [0, 500, 10000],
      modes: ["list", "grid"],
      samples: 15,
      warmups: 2,
      viewport: { width: 1200, height: 850 },
      pane: { width: 1000, height: 640 },
      density: "comfortable",
      seed: 123456789,
    },
    hashes: {},
  };
  for (const mod of [
    "react",
    "react-dom",
    "@tanstack/react-virtual",
    "esbuild",
    "tailwindcss",
  ])
    metadata.versions[mod] = req(mod + "/package.json").version;
  let contents = [];
  for (const variant of ["baseline", "current"]) {
    const rootDir = path.join(dir, variant);
    fs.writeFileSync(path.join(rootDir, "entry.tsx"), entry);
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else if (/\.(tsx?|css)$/.test(q))
          contents.push({
            content: fs.readFileSync(q, "utf8"),
            extension: path.extname(q).slice(1),
          });
      }
    };
    walk(path.join(rootDir, "src/frontend"));
    metadata.hashes[variant] = {
      grid: hash(
        fs.readFileSync(path.join(rootDir, "src/frontend/FileManagerGrid.tsx")),
      ),
      filter: hash(fs.readFileSync(path.join(rootDir, "filter.ts"))),
    };
    const result = await esbuild.build({
      entryPoints: [path.join(rootDir, "entry.tsx")],
      outfile: path.join(rootDir, "bundle.js"),
      bundle: true,
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      nodePaths: [path.join(repo, "node_modules")],
      jsx: "automatic",
      metafile: true,
      plugins: [
        {
          name: "minimal-host-boundary",
          setup(build) {
            build.onResolve(
              { filter: /^@termix-ssh\/plugin-sdk\/(ui|frontend)$/ },
              (args) => ({ path: args.path, namespace: "sdk" }),
            );
            build.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({
              contents: sdkStub,
              loader: "js",
            }));
          },
        },
      ],
    });
    fs.writeFileSync(
      path.join(rootDir, "metafile.json"),
      JSON.stringify(result.metafile, null, 2),
    );
    fs.writeFileSync(
      path.join(rootDir, "index.html"),
      '<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="bundle.js"></script>',
    );
  }
  const themePath = req.resolve("@termix-ssh/plugin-sdk/theme.css");
  const theme = fs.readFileSync(themePath, "utf8");
  metadata.css = {
    themePath,
    themeSha256: hash(theme),
    kind: "Installed SDK theme + real Tailwind theme/preflight/utilities; isolated shell palette variables",
  };
  const compiler = await compile('@import "tailwindcss";\n' + theme, {
    base: path.join(repo, "node_modules"),
    onDependency: () => {},
  });
  const candidates = new Scanner({}).scanFiles(contents);
  fs.writeFileSync(
    path.join(dir, "style.css"),
    compiler.build(candidates) +
      "\n:root{--border:#444;--background:#171717;--foreground:#eee;--card:#222;--muted:#333;--muted-foreground:#aaa;--accent-brand:#68aaff;--font-ui:Arial}body{margin:0;background:var(--background);color:var(--foreground);font-family:Arial,sans-serif}nav{height:40px}button{padding:4px 10px;border:1px solid #555}",
  );
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost"),
      p = path.join(dir, url.pathname);
    if (!p.startsWith(dir)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const buf = fs.readFileSync(p);
      response.setHeader(
        "Content-Type",
        p.endsWith(".js")
          ? "text/javascript"
          : p.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      response.end(buf);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  metadata.browser = browser.version();
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  const samples = [],
    errors = [];
  const context = await browser.newContext({
    viewport: metadata.inputs.viewport,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const output = path.join(dir, "samples.jsonl");
  fs.writeFileSync(output, "");
  try {
    for (const mode of metadata.inputs.modes)
      for (const n of metadata.inputs.sizes)
        for (let round = -2; round < 15; round++) {
          const order =
            round % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"];
          for (const variant of order) {
            await page.goto(
              "http://127.0.0.1:" +
                server.address().port +
                "/" +
                variant +
                "/index.html?n=" +
                n +
                "&mode=" +
                mode,
            );
            await page.waitForFunction(() => window.perform);
            const record = {
              variant,
              mode,
              n,
              round,
              warmup: round < 0,
              started: new Date().toISOString(),
              actions: {},
            };
            for (const action of ["initial", "update"])
              record.actions[action] = await page.evaluate(
                (a) => window.perform(a),
                action,
              );
            record.fullPreHide = await page.evaluate(async () => {
              const el = document.querySelector(".overflow-y-auto");
              el.scrollTop = el.scrollHeight / 2;
              await window.frames2();
              await window.frames2();
              return window.check();
            });
            await page.evaluate(async () => {
              document.getElementById("hide").click();
              await window.frames2();
              await window.frames2();
            });
            record.fullHidden = await page.evaluate(() => ({
              display: getComputedStyle(document.querySelector("#pane"))
                .display,
              height: document.querySelector(".overflow-y-auto").clientHeight,
            }));
            record.actions.fullShow = await page.evaluate(() =>
              window.perform("show"),
            );
            await page.evaluate(async () => {
              document.querySelector(".overflow-y-auto").scrollTop = 0;
              await window.frames2();
              await window.frames2();
            });
            for (const action of ["filter", "sort"])
              record.actions[action] = await page.evaluate(
                (a) => window.perform(a),
                action,
              );
            // A real scroll plus a display:none tab transition; never override geometry/virtualizer.
            record.preHide = await page.evaluate(async () => {
              const el = document.querySelector(".overflow-y-auto");
              el.scrollTop = el.scrollHeight / 2;
              await window.frames2();
              return window.check();
            });
            await page.evaluate(async () => {
              document.getElementById("hide").click();
              await window.frames2();
              await window.frames2();
            });
            record.actions.show = await page.evaluate(() =>
              window.perform("show"),
            );
            record.scrollEnd = await page.evaluate(async () => {
              const el = document.querySelector(".overflow-y-auto");
              el.scrollTop = el.scrollHeight;
              await window.frames2();
              await window.frames2();
              const check = window.check();
              if (
                window.expected.length &&
                !check.visibleNames.includes(check.lastExpected)
              )
                check.errors.push("last filename not visible at scroll end");
              return check;
            });
            if (round === -2 && variant === "current")
              fs.writeFileSync(
                path.join(dir, "inputs-" + n + ".json"),
                JSON.stringify(await page.evaluate(() => window.dataset)),
              );
            fs.appendFileSync(output, JSON.stringify(record) + "\n");
            samples.push(record);
          }
          console.log(
            JSON.stringify({
              mode,
              n,
              round,
              complete: samples.length,
              failed: samples.filter(
                (r) =>
                  Object.values(r.actions).some((a) => a.check.errors.length) ||
                  r.scrollEnd.errors.length,
              ).length,
            }),
          );
        }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  metadata.finished = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "browser-errors.json"),
    JSON.stringify(errors, null, 2),
  );
  const groups = [];
  const pct = (arr, p) =>
    arr.slice().sort((a, b) => a - b)[Math.ceil(arr.length * p) - 1];
  for (const mode of metadata.inputs.modes)
    for (const n of metadata.inputs.sizes)
      for (const action of [
        "initial",
        "update",
        "fullShow",
        "filter",
        "sort",
        "show",
      ]) {
        const row = { mode, n, action };
        for (const variant of ["baseline", "current"]) {
          const records = samples.filter(
              (s) =>
                !s.warmup &&
                s.mode === mode &&
                s.n === n &&
                s.variant === variant,
            ),
            values = records.map((r) => r.actions[action].ms);
          row[variant] = {
            samples: values.length,
            median: pct(values, 0.5),
            p95: pct(values, 0.95),
            failures: records.filter(
              (r) => r.actions[action].check.errors.length,
            ).length,
          };
        }
        row.deltaMedian = row.current.median - row.baseline.median;
        row.deltaPercent = 100 * (row.current.median / row.baseline.median - 1);
        groups.push(row);
      }
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify(
      {
        metadata,
        groups,
        browserErrors: errors,
        measuredRecords: samples.filter((s) => !s.warmup).length,
        failedRecords: samples.filter(
          (s) =>
            !s.warmup &&
            (Object.values(s.actions).some((a) => a.check.errors.length) ||
              s.scrollEnd.errors.length),
        ).length,
      },
      null,
      2,
    ),
  );
  console.log("DONE " + dir);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
