import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import express, { type Express, type Request, type Response } from "express";
import type {
  PluginContext,
  PluginLocalResponse,
  PluginWebSocketConnection,
} from "@termix-ssh/plugin-sdk/backend";

// The desktop app's own disk, for the dual-pane file manager and the external
// editor. Everything here is refused outside the desktop app.

const EXTERNAL_EDITOR_SETTING = "fileManager.externalEditorPath";
const PROGRESS_INTERVAL_MS = 150;
const OPEN = 1;

// Extensions the OS would run rather than open in an editor. With no editor
// configured the temp copy is opened by the OS, and its name comes from the
// remote server.
const LAUNCHABLE_EXTENSIONS = new Set([
  "application",
  "appref-ms",
  "bat",
  "chm",
  "cmd",
  "com",
  "cpl",
  "exe",
  "gadget",
  "hta",
  "inf",
  "jar",
  "js",
  "jse",
  "library-ms",
  "lnk",
  "msc",
  "msi",
  "msp",
  "mst",
  "pif",
  "ps1",
  "psd1",
  "psm1",
  "py",
  "pyw",
  "reg",
  "scf",
  "scr",
  "search-ms",
  "settingcontent-ms",
  "url",
  "vbe",
  "vbs",
  "ws",
  "wsf",
  "wsh",
  "xll",
  "app",
  "command",
  "pkg",
  "terminal",
  "tool",
  "workflow",
  "appimage",
  "desktop",
  "run",
  "sh",
]);

export function isLaunchableFileName(fileName: unknown): boolean {
  // Windows drops trailing dots and spaces, so "a.exe. " is saved as a.exe.
  const name = path.basename(String(fileName || "")).replace(/[. ]+$/, "");
  return LAUNCHABLE_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());
}

export function sanitizeFileName(fileName: unknown): string {
  const baseName = path.basename(String(fileName || "file"));
  // eslint-disable-next-line no-control-regex
  return baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "file";
}

// The two streaming routes a transfer may call.
export const TRANSFER_ROUTES = Object.freeze({
  uploadFileStream: "/uploadFileStream",
  downloadFileStream: "/downloadFileStream",
});

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface Socket {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: never[]) => void) => unknown;
}

interface ActiveTransfer {
  userId: string;
  abort: () => void;
}

interface EditorSession {
  userId: string;
  dir: string;
  path: string;
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  lastMtimeMs: number;
}

function fail(error: unknown): {
  success: false;
  error: string;
  code?: string;
} {
  const e = error as { message?: string; code?: string };
  return {
    success: false,
    error: e?.message ? e.message : String(error),
    code: e?.code,
  };
}

function describeHttpError(statusCode: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed.error === "string") return parsed.error;
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return bodyText?.trim() || `Request failed with status ${statusCode}`;
}

export function registerLocalDesktop(app: Express, ctx: PluginContext) {
  const local = ctx.desktop.local;
  const activeTransfers = new Map<string, ActiveTransfer>();
  const editors = new Map<string, EditorSession>();
  const sockets = new Map<string, Set<Socket>>();

  const emit = (userId: string, payload: Record<string, unknown>) => {
    const text = JSON.stringify(payload);
    for (const ws of sockets.get(userId) ?? []) {
      if (ws.readyState === OPEN) ws.send(text);
    }
  };

  ctx.ws.route("/local-events", (connection: PluginWebSocketConnection) => {
    const ws = connection.socket as Socket;
    if (!connection.userId || !local.available()) {
      ws.close(1008, "Desktop only");
      return;
    }
    const userId = connection.userId;
    let set = sockets.get(userId);
    if (!set) sockets.set(userId, (set = new Set()));
    const mine = set;
    mine.add(ws);
    ws.on("close", (() => {
      mine.delete(ws);
      if (mine.size === 0) sockets.delete(userId);
    }) as never);
  });

  const desktopOnly = (_req: Request, res: Response, next: () => void) => {
    if (!local.available()) {
      res.status(404).json({ error: "Only available in the desktop app" });
      return;
    }
    next();
  };

  const handle =
    (fn: (req: Request, userId: string) => Promise<object | void>) =>
    async (req: Request, res: Response) => {
      try {
        const userId = ctx.currentActor();
        if (!userId) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        res.json({ success: true, ...((await fn(req, userId)) ?? {}) });
      } catch (error) {
        res.json(fail(error));
      }
    };

  app.use("/local", desktopOnly as never, express.json({ limit: "64mb" }));

  app.get(
    "/local/home",
    handle(async () => {
      const info = await local.info();
      return {
        home: info.home,
        separator: info.separator,
        platform: info.platform,
      };
    }),
  );
  app.post(
    "/local/list",
    handle(async (req) => local.fs.list(req.body.path)),
  );
  app.post(
    "/local/mkdir",
    handle(async (req) => ({
      path: await local.fs.mkdir(req.body.parent, req.body.name),
    })),
  );
  app.post(
    "/local/create-file",
    handle(async (req) => ({
      path: await local.fs.createFile(req.body.parent, req.body.name),
    })),
  );
  app.post(
    "/local/rename",
    handle(async (req) => ({
      path: await local.fs.rename(req.body.path, req.body.name),
    })),
  );
  app.post(
    "/local/trash",
    handle(async (req) => local.fs.trash(req.body.paths)),
  );
  app.post(
    "/local/ensure-dir",
    handle(async (req) => ({
      path: await local.fs.ensureDir(req.body.path, req.body.root),
    })),
  );
  app.post(
    "/local/exists",
    handle(async (req) => ({
      existing: await local.fs.exists(req.body.paths),
    })),
  );
  app.post(
    "/local/walk",
    handle(async (req) => local.fs.walk(req.body.paths)),
  );
  app.post(
    "/local/reveal",
    handle(async (req) => {
      await local.fs.reveal(req.body.path);
    }),
  );
  app.post(
    "/local/open",
    handle(async (req) => {
      await local.fs.open(req.body.path);
    }),
  );

  // Progress for the owner's transfers, throttled.
  const progressReporter = (userId: string, transferId: string) => {
    let lastSentAt = 0;
    return (transferred: number, total?: number, force = false) => {
      const now = Date.now();
      if (!force && now - lastSentAt < PROGRESS_INTERVAL_MS) return;
      lastSentAt = now;
      emit(userId, { type: "progress", transferId, transferred, total });
    };
  };

  function resolveTransfer(
    body: Record<string, unknown>,
    route: keyof typeof TRANSFER_ROUTES,
  ) {
    const origin = body.origin;
    if (origin !== "local" && origin !== "remote") {
      throw new Error(`Unknown transfer origin: ${String(origin)}`);
    }
    const deviceId = body.deviceId;
    const headers: Record<string, string> = {};
    if (deviceId !== undefined && deviceId !== null && deviceId !== "") {
      if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
        throw new Error("Invalid device id");
      }
      headers["X-Termix-Device-ID"] = deviceId;
    }
    return {
      origin: origin as "local" | "remote",
      headers,
      subPath: TRANSFER_ROUTES[route],
    };
  }

  async function readText(response: PluginLocalResponse): Promise<string> {
    return response.text().catch(() => "");
  }

  app.post(
    "/local/upload",
    handle(async (req, userId) => {
      const body = req.body as Record<string, unknown>;
      const transferId = String(body.transferId ?? "");
      const localPath = String(body.localPath ?? "");
      if (!transferId || !localPath) {
        throw new Error("Missing upload parameters");
      }
      const { origin, headers, subPath } = resolveTransfer(
        body,
        "uploadFileStream",
      );

      const { stream: fileStream, size } = await local.fs.openRead(localPath);
      const boundary = `----TermixLocalUpload${Date.now()}${Math.random()
        .toString(36)
        .slice(2)}`;
      const safeName = String(body.fileName || path.basename(localPath))
        .replace(/[\r\n]/g, " ")
        .replace(/"/g, "%22");
      let preamble = "";
      for (const [key, value] of Object.entries(
        (body.fields as Record<string, unknown>) ?? {},
      )) {
        if (value === undefined || value === null) continue;
        preamble +=
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key.replace(/["\r\n]/g, "")}"\r\n\r\n` +
          `${String(value)}\r\n`;
      }
      preamble +=
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`;

      const report = progressReporter(userId, transferId);
      const controller = new AbortController();
      const source = fileStream as unknown as Readable;
      activeTransfers.set(transferId, {
        userId,
        abort: () => {
          controller.abort();
          source.destroy();
        },
      });

      let sent = 0;
      async function* multipart() {
        yield Buffer.from(preamble, "utf8");
        for await (const chunk of source as AsyncIterable<Buffer>) {
          sent += chunk.length;
          report(sent, size);
          yield chunk;
        }
        yield Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      }

      try {
        const response = await local.pluginFetch(origin, subPath, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: Readable.from(multipart()),
          signal: controller.signal,
        });
        const text = await readText(response);
        if (!response.ok) {
          throw new Error(describeHttpError(response.status, text));
        }
        report(size, size, true);
        return { bytes: size };
      } catch (error) {
        source.destroy();
        if (controller.signal.aborted) throw new Error("Transfer cancelled");
        throw error;
      } finally {
        activeTransfers.delete(transferId);
      }
    }),
  );

  app.post(
    "/local/download",
    handle(async (req, userId) => {
      const body = req.body as Record<string, unknown>;
      const transferId = String(body.transferId ?? "");
      const destPath = String(body.destPath ?? "");
      if (!transferId || !destPath) {
        throw new Error("Missing download parameters");
      }
      const { origin, headers, subPath } = resolveTransfer(
        body,
        "downloadFileStream",
      );

      const download = await local.fs.openDownload({
        rootPath: String(body.rootPath ?? ""),
        destPath,
        transferId,
        overwrite: body.overwrite === true,
      });

      const report = progressReporter(userId, transferId);
      const controller = new AbortController();
      activeTransfers.set(transferId, {
        userId,
        abort: () => controller.abort(),
      });

      try {
        const response = await local.pluginFetch(origin, subPath, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body.body ?? {}),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            describeHttpError(response.status, await readText(response)),
          );
        }
        const total =
          Number(response.headers.get("content-length")) ||
          Number(body.expectedSize) ||
          undefined;
        let received = 0;
        const sink = download.stream as unknown as Writable;
        if (response.body) {
          for await (const chunk of response.body) {
            received += chunk.length;
            if (!sink.write(chunk)) {
              await new Promise((resolve) => sink.once("drain", resolve));
            }
            report(received, total);
          }
        }
        report(received, total ?? received, true);
        return { path: await download.publish() };
      } catch (error) {
        await download.abort();
        if (controller.signal.aborted) throw new Error("Transfer cancelled");
        throw error;
      } finally {
        activeTransfers.delete(transferId);
      }
    }),
  );

  app.post(
    "/local/cancel",
    handle(async (req, userId) => {
      const state = activeTransfers.get(String(req.body.transferId));
      if (!state || state.userId !== userId) return { cancelled: false };
      state.abort();
      return { cancelled: true };
    }),
  );

  // External editor: a temp copy opened in the user's editor. Saves come back
  // over the events socket.
  const closeEditor = (editId: string) => {
    const session = editors.get(editId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    try {
      session.watcher.close();
    } catch {
      // already closed
    }
    editors.delete(editId);
    void fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {});
  };
  ctx.disposables.add(() => {
    for (const editId of [...editors.keys()]) closeEditor(editId);
    for (const state of activeTransfers.values()) state.abort();
    for (const set of sockets.values()) for (const ws of set) ws.close(1001);
  });

  const notifySaved = async (editId: string) => {
    const session = editors.get(editId);
    if (!session) return;
    try {
      const stat = await fsp.stat(session.path);
      if (stat.mtimeMs === session.lastMtimeMs) return;
      session.lastMtimeMs = stat.mtimeMs;
      const content = await fsp.readFile(session.path, "utf8");
      emit(session.userId, {
        type: "editor-saved",
        editId,
        content,
        encoding: "utf8",
        path: session.path,
      });
    } catch (error) {
      ctx.log.warn(
        `Failed to read external editor file: ${(error as Error).message}`,
      );
    }
  };

  async function readEditorPath(): Promise<string | null> {
    const info = await local.info();
    try {
      const raw = await fsp.readFile(
        path.join(info.userDataDir, "settings.json"),
        "utf8",
      );
      const value = JSON.parse(raw)[EXTERNAL_EDITOR_SETTING];
      return typeof value === "string" && value ? value : null;
    } catch {
      return null;
    }
  }

  app.post(
    "/local/editor/open",
    handle(async (req, userId) => {
      const { fileName, content, encoding } = req.body as Record<
        string,
        string
      >;
      // The editor comes from the saved setting, never from the caller.
      const editorPath = await readEditorPath();
      if (!editorPath && isLaunchableFileName(fileName)) {
        throw new Error("Choose an external editor to open this file type");
      }

      const root = path.join(os.tmpdir(), "termix");
      await fsp.mkdir(root, { recursive: true });
      const editId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dir = await fsp.mkdtemp(path.join(root, `${editId}-`));
      const filePath = path.join(dir, sanitizeFileName(fileName));
      await fsp.writeFile(
        filePath,
        Buffer.from(
          String(content || ""),
          encoding === "base64" ? "base64" : "utf8",
        ),
      );
      const stat = await fsp.stat(filePath);
      const watcher = fs.watch(filePath, { persistent: false }, () => {
        const session = editors.get(editId);
        if (!session) return;
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => void notifySaved(editId), 500);
      });
      editors.set(editId, {
        userId,
        dir,
        path: filePath,
        watcher,
        timer: null,
        lastMtimeMs: stat.mtimeMs,
      });

      try {
        if (!editorPath) {
          await local.fs.open(filePath);
        } else {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(editorPath, [filePath], {
              detached: true,
              stdio: "ignore",
            });
            child.once("error", reject);
            child.once("spawn", () => {
              child.unref();
              resolve();
            });
          });
        }
      } catch (error) {
        closeEditor(editId);
        throw error;
      }
      return { editId, path: filePath };
    }),
  );

  app.post(
    "/local/editor/close",
    handle(async (req, userId) => {
      const editId = String(req.body.editId);
      if (editors.get(editId)?.userId === userId) closeEditor(editId);
    }),
  );
}
