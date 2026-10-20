import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLaunchableFileName,
  registerLocalDesktop,
  sanitizeFileName,
} from "../../src/backend/local-desktop";

interface Harness {
  call: (
    route: string,
    body?: unknown,
    method?: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  local: Record<string, unknown> & {
    pluginFetch: ReturnType<typeof vi.fn>;
    fs: Record<string, ReturnType<typeof vi.fn>>;
    available: ReturnType<typeof vi.fn>;
  };
  wsRoutes: Map<string, (connection: unknown) => void>;
  dispose: () => Promise<void>;
  tmp: string;
}

let userDataDir = "";

async function setup(available = true): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fm-local-"));
  userDataDir = tmp;
  const disposables: Array<() => void> = [];
  const wsRoutes = new Map<string, (connection: unknown) => void>();
  const local = {
    available: vi.fn(() => available),
    info: vi.fn(async () => ({
      home: "/home/u",
      separator: "/",
      platform: "linux",
      userDataDir,
      backendPort: 30001,
      link: null,
    })),
    pluginFetch: vi.fn(),
    fs: {
      list: vi.fn(async (p: string) => ({
        path: p,
        parent: null,
        entries: [],
      })),
      mkdir: vi.fn(async (a: string, b: string) => path.join(a, b)),
      createFile: vi.fn(),
      rename: vi.fn(),
      ensureDir: vi.fn(),
      exists: vi.fn(async (paths: string[]) => paths.slice(0, 1)),
      walk: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      open: vi.fn(async () => {}),
      openRead: vi.fn(),
      openDownload: vi.fn(),
    },
  };
  const ctx = {
    desktop: { local },
    currentActor: () => "user-1",
    ws: { route: (p: string, h: (c: unknown) => void) => wsRoutes.set(p, h) },
    disposables: { add: (fn: () => void) => disposables.push(fn) },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const app = express();
  registerLocalDesktop(app, ctx as never);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    local: local as never,
    wsRoutes,
    tmp,
    async call(route, body, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    async dispose() {
      disposables.forEach((fn) => fn());
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

describe("helpers", () => {
  it("flags names the OS would run", () => {
    expect(isLaunchableFileName("setup.exe")).toBe(true);
    expect(isLaunchableFileName("a.EXE. ")).toBe(true);
    expect(isLaunchableFileName("notes.txt")).toBe(false);
  });

  it("refuses remote file names the OS would run instead of open", () => {
    for (const name of [
      "payload.exe",
      "run.BAT",
      "script.ps1",
      "a.exe. ",
      "a.cmd...",
      "../../evil.vbs",
      "start.command",
      "launch.desktop",
      "install.sh",
    ]) {
      expect(isLaunchableFileName(name)).toBe(true);
    }
  });

  it("opens ordinary text files", () => {
    for (const name of [
      "nginx.conf",
      "README.md",
      "Dockerfile",
      ".bashrc",
      "config.json",
      "index.ts",
      "",
      undefined,
    ]) {
      expect(isLaunchableFileName(name)).toBe(false);
    }
  });

  it("keeps temp file names inside one folder", () => {
    expect(sanitizeFileName("../../etc/pa:ss")).toBe("pa_ss");
    expect(sanitizeFileName("")).toBe("file");
  });
});

describe("local routes", () => {
  it("answer 404 outside the desktop app", async () => {
    harness = await setup(false);
    const res = await harness.call("/local/home");
    expect(res.status).toBe(404);
    expect(harness.local.fs.list).not.toHaveBeenCalled();
  });

  it("wrap results and errors in success objects", async () => {
    harness = await setup();
    const ok = await harness.call("/local/mkdir", { parent: "/a", name: "b" });
    expect(ok.body).toMatchObject({
      success: true,
      path: path.join("/a", "b"),
    });

    harness.local.fs.list.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    const failed = await harness.call("/local/list", { path: "/x" });
    expect(failed.body).toEqual({
      success: false,
      error: "denied",
      code: "EACCES",
    });
  });

  it("returns the existing paths", async () => {
    harness = await setup();
    const res = await harness.call("/local/exists", { paths: ["/a", "/b"] });
    expect(res.body).toMatchObject({ success: true, existing: ["/a"] });
  });
});

describe("transfers", () => {
  it("rejects an unknown origin and a bad device id", async () => {
    harness = await setup();
    const origin = await harness.call("/local/upload", {
      transferId: "t",
      localPath: "/f",
      origin: "https://evil.example",
    });
    expect(origin.body).toMatchObject({ success: false });
    expect(String(origin.body.error)).toMatch(/origin/);

    const device = await harness.call("/local/download", {
      transferId: "t",
      destPath: "/d/f",
      origin: "local",
      deviceId: "bad id!",
    });
    expect(String(device.body.error)).toMatch(/device id/);
    expect(harness.local.pluginFetch).not.toHaveBeenCalled();
  });

  it("streams an upload as multipart to the fixed upload route", async () => {
    harness = await setup();
    harness.local.fs.openRead.mockResolvedValue({
      stream: Readable.from([Buffer.from("hello")]),
      size: 5,
    });
    let sent = "";
    harness.local.pluginFetch.mockImplementation(
      async (origin: string, route: string, init: { body: Readable }) => {
        expect(origin).toBe("remote");
        expect(route).toBe("/uploadFileStream");
        for await (const chunk of init.body) sent += chunk.toString();
        return { ok: true, status: 200, text: async () => "{}" };
      },
    );

    const res = await harness.call("/local/upload", {
      transferId: "t1",
      origin: "remote",
      localPath: "/tmp/f.txt",
      fileName: 'we"ird.txt',
      fields: { sessionId: "s", path: "/up" },
    });
    expect(res.body).toMatchObject({ success: true, bytes: 5 });
    expect(sent).toContain('name="sessionId"');
    expect(sent).toContain('filename="we%22ird.txt"');
    expect(sent).toContain("hello");
  });

  it("surfaces the server error of a failed upload", async () => {
    harness = await setup();
    harness.local.fs.openRead.mockResolvedValue({
      stream: Readable.from([Buffer.from("x")]),
      size: 1,
    });
    harness.local.pluginFetch.mockImplementation(
      async (_o: string, _r: string, init: { body: Readable }) => {
        for await (const chunk of init.body) void chunk;
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: "Session access denied" }),
        };
      },
    );
    const res = await harness.call("/local/upload", {
      transferId: "t2",
      origin: "local",
      localPath: "/tmp/f",
    });
    expect(res.body).toEqual({
      success: false,
      error: "Session access denied",
    });
  });

  it("writes a download into the guarded sink and publishes it", async () => {
    harness = await setup();
    const sink = new PassThrough();
    const written: Buffer[] = [];
    sink.on("data", (chunk) => written.push(chunk));
    const publish = vi.fn(async () => "/dest/f.bin");
    harness.local.fs.openDownload.mockResolvedValue({
      path: "/dest/f.bin",
      stream: sink,
      publish,
      abort: vi.fn(),
    });
    harness.local.pluginFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "4" },
      body: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3, 4]);
      })(),
    });

    const res = await harness.call("/local/download", {
      transferId: "d1",
      origin: "local",
      body: { sessionId: "s", path: "/r/f.bin" },
      destPath: "/dest/f.bin",
      rootPath: "/dest",
    });
    expect(res.body).toMatchObject({ success: true, path: "/dest/f.bin" });
    expect(Buffer.concat(written)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(harness.local.fs.openDownload).toHaveBeenCalledWith({
      rootPath: "/dest",
      destPath: "/dest/f.bin",
      transferId: "d1",
      overwrite: false,
    });
    expect(publish).toHaveBeenCalled();
  });

  it("aborts the partial file when the download fails", async () => {
    harness = await setup();
    const abort = vi.fn(async () => {});
    harness.local.fs.openDownload.mockResolvedValue({
      path: "/d/f",
      stream: new PassThrough(),
      publish: vi.fn(),
      abort,
    });
    harness.local.pluginFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: "SSH session not found" }),
    });
    const res = await harness.call("/local/download", {
      transferId: "d2",
      origin: "local",
      destPath: "/d/f",
      rootPath: "/d",
    });
    expect(res.body).toMatchObject({
      success: false,
      error: "SSH session not found",
    });
    expect(abort).toHaveBeenCalled();
  });

  it("cancel reports false for an unknown transfer", async () => {
    harness = await setup();
    const res = await harness.call("/local/cancel", { transferId: "nope" });
    expect(res.body).toMatchObject({ success: true, cancelled: false });
  });
});

describe("external editor", () => {
  const savedEditor = (dir: string, value: string | null) => {
    if (value === null) return;
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ "fileManager.externalEditorPath": value }),
    );
  };

  beforeEach(() => {
    userDataDir = "";
  });

  it("refuses a launchable file with no editor configured", async () => {
    harness = await setup();
    const res = await harness.call("/local/editor/open", {
      fileName: "run.sh",
      content: "x",
    });
    expect(res.body).toMatchObject({ success: false });
    expect(String(res.body.error)).toMatch(/external editor/);
    expect(harness.local.fs.open).not.toHaveBeenCalled();
  });

  it("opens a plain file with the OS when no editor is set", async () => {
    harness = await setup();
    const res = await harness.call("/local/editor/open", {
      fileName: "../notes.txt",
      content: "hi",
    });
    expect(res.body).toMatchObject({ success: true });
    const opened = harness.local.fs.open.mock.calls[0][0] as string;
    expect(path.basename(opened)).toBe("notes.txt");
    expect(fs.readFileSync(opened, "utf8")).toBe("hi");
    await harness.call("/local/editor/close", { editId: res.body.editId });
  });

  it("takes the editor from the saved setting, never from the caller", async () => {
    harness = await setup();
    savedEditor(harness.tmp, process.execPath);
    const res = await harness.call("/local/editor/open", {
      fileName: "notes.txt",
      content: "hi",
      editorPath: "/evil",
    });
    // The saved editor (node) runs and exits on its own; the OS opener is not used.
    expect(harness.local.fs.open).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ success: true });
    await harness.call("/local/editor/close", { editId: res.body.editId });
  });
});
