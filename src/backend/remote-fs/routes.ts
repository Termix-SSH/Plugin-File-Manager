import { PassThrough, Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import Busboy from "busboy";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { detectBinary, getMimeType } from "../utils.js";
import { contentDisposition } from "../download-routes.js";
import {
  joinPath,
  message,
  parentOf,
  type RemoteFs,
  type RemoteProtocol,
} from "./types.js";

const IDLE_MS = 30 * 60 * 1000;
const MAX_READ_BYTES = 10 * 1024 * 1024;

interface Session {
  fs: RemoteFs;
  userId: string;
  hostId: number;
  isConnected: boolean;
  timeout?: NodeJS.Timeout;
  tail: Promise<unknown>;
}

/**
 * The File Manager routes for a protocol other than SFTP, under /<id>/. They
 * answer like the SFTP routes, so the browser only changes the prefix.
 */
export function registerRemoteRoutes<S>(
  app: Express,
  ctx: PluginContext,
  protocol: RemoteProtocol<S>,
): void {
  const at = (path: string) => `/${protocol.id}${path}`;
  const label = protocol.label;
  // No prototype, so an id like "__proto__" is only ever a missing key.
  const sessions: Record<string, Session> = Object.create(null);

  function close(sessionId: string): void {
    const session = sessions[sessionId];
    if (!session) return;
    clearTimeout(session.timeout);
    session.isConnected = false;
    try {
      session.fs.close();
    } catch {
      // expected
    }
    delete sessions[sessionId];
  }

  function touch(sessionId: string): void {
    const session = sessions[sessionId];
    if (!session) return;
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => close(sessionId), IDLE_MS);
  }

  ctx.disposables.add(() => {
    for (const id of Object.keys(sessions)) close(id);
  });

  /** One call at a time per session, since the clients are not concurrent. */
  function run<T>(session: Session, work: (fs: RemoteFs) => Promise<T>) {
    const next = session.tail.then(
      () => work(session.fs),
      () => work(session.fs),
    );
    session.tail = next.catch(() => {});
    return next;
  }

  function owned(
    req: Request,
    res: Response,
    source: "query" | "body" = "body",
  ) {
    const userId = ctx.currentActor();
    const raw = source === "query" ? req.query.sessionId : req.body?.sessionId;
    const sessionId = typeof raw === "string" ? raw : "";
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    if (!sessionId) {
      res.status(400).json({ error: "Session ID is required" });
      return null;
    }
    const session = sessions[sessionId];
    if (!session?.isConnected || session.fs.closed) {
      if (session) close(sessionId);
      res.status(400).json({ error: `${label} connection not established` });
      return null;
    }
    if (session.userId !== userId) {
      res.status(403).json({ error: "Session access denied" });
      return null;
    }
    touch(sessionId);
    return { session, sessionId, userId };
  }

  ctx.hosts.status.registerPort(protocol.id, async (hostId) =>
    protocol.port(await protocol.readSettings(ctx, hostId)),
  );

  /**
   * @openapi
   * /plugin-api/file-manager/{protocol}/connect:
   *   post:
   *     summary: Open an FTP, WebDAV or SMB session for a host
   *     tags:
   *       - File Manager
   *     parameters:
   *       - in: path
   *         name: protocol
   *         required: true
   *         schema:
   *           type: string
   *           enum: [ftp, webdav, smb]
   *     responses:
   *       200: { description: Connected. }
   *       400: { description: Missing or invalid parameters. }
   *       401: { description: Authentication required. }
   */
  app.post(at("/connect"), async (req, res) => {
    const userId = ctx.currentActor();
    const { sessionId, hostId } = req.body ?? {};
    if (!userId)
      return res.status(401).json({ error: "Authentication required" });
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      !Number.isInteger(Number(hostId))
    ) {
      return res
        .status(400)
        .json({ error: `Missing ${label} connection parameters` });
    }
    const existing = sessions[sessionId];
    if (existing && existing.userId !== userId) {
      return res.status(403).json({ error: "Session access denied" });
    }
    close(sessionId);

    let target;
    try {
      target = await ctx.credentials.resolveHostProtocol(
        Number(hostId),
        protocol.id,
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "access-denied" || code === "access-required") {
        const body = (error as { toJSON?: () => unknown }).toJSON?.();
        return res
          .status(403)
          .json(body ?? { error: message(error, "Access denied") });
      }
      return res
        .status(500)
        .json({ error: message(error, `Could not read the ${label} login`) });
    }
    if (!target) return res.status(404).json({ error: "Host not found" });

    let fs: RemoteFs;
    try {
      const settings = await protocol.readSettings(ctx, Number(hostId));
      fs = await protocol.connect(target, settings);
    } catch (error) {
      return res
        .status(502)
        .json({ error: message(error, `${label} connection failed`) });
    }

    sessions[sessionId] = {
      fs,
      userId,
      hostId: Number(hostId),
      isConnected: true,
      tail: Promise.resolve(),
    };
    touch(sessionId);
    res.json({ success: true, message: `${label} connected` });
  });

  app.post(at("/disconnect"), (req, res) => {
    const userId = ctx.currentActor();
    const sessionId = req.body?.sessionId;
    const session = sessions[sessionId];
    if (session && session.userId !== userId) {
      return res.status(403).json({ error: "Session access denied" });
    }
    close(sessionId);
    res.json({
      status: "success",
      message: `${label} connection disconnected`,
    });
  });

  app.get(at("/status"), (req, res) => {
    const userId = ctx.currentActor();
    const session = sessions[req.query.sessionId as string];
    if (session && session.userId !== userId) {
      return res.status(403).json({ error: "Session access denied" });
    }
    res.json({
      status: "success",
      connected: !!session?.isConnected && !session.fs.closed,
    });
  });

  app.post(at("/keepalive"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    try {
      await run(found.session, (fs) => fs.ping());
      res.json({ status: "success", connected: true });
    } catch (error) {
      close(found.sessionId);
      res.status(400).json({
        error: message(error, `${label} session lost`),
        connected: false,
      });
    }
  });

  app.get(at("/listFiles"), async (req, res) => {
    const found = owned(req, res, "query");
    if (!found) return;
    try {
      const files = await run(found.session, async (fs) => {
        let dir = (req.query.path as string) || ".";
        if (dir === ".") dir = await fs.home();
        return { path: dir, files: await fs.list(dir) };
      });
      res.json(files);
    } catch (error) {
      res.status(500).json({ error: message(error, "Could not list files") });
    }
  });

  app.get(at("/resolvePath"), async (req, res) => {
    const found = owned(req, res, "query");
    if (!found) return;
    const path = (req.query.path as string) || ".";
    try {
      const resolved = await run(found.session, async (fs) =>
        path === "." ? fs.home() : path,
      );
      res.json({ resolvedPath: resolved });
    } catch (error) {
      res.status(500).json({ error: message(error, "Could not resolve path") });
    }
  });

  app.get(at("/identifySymlink"), (_req, res) => {
    res.status(404).json({ error: `Symlinks are not resolved over ${label}` });
  });

  async function readBuffer(session: Session, path: string): Promise<Buffer> {
    return run(session, async (fs) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const sink = new PassThrough();
      sink.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_READ_BYTES) {
          sink.destroy(new Error("File is too large to open"));
          return;
        }
        chunks.push(chunk);
      });
      await fs.downloadTo(sink, path, 0);
      return Buffer.concat(chunks);
    });
  }

  app.get(at("/readFile"), async (req, res) => {
    const found = owned(req, res, "query");
    if (!found) return;
    const path = req.query.path as string;
    if (!path) return res.status(400).json({ error: "File path is required" });
    try {
      const data = await readBuffer(found.session, path);
      const binary = detectBinary(data);
      res.json({
        content: data.toString(binary ? "base64" : "utf8"),
        path,
        encoding: binary ? "base64" : "utf8",
      });
    } catch (error) {
      const text = message(error, "Could not read file");
      res
        .status(/550|404|not found|no such/i.test(text) ? 404 : 500)
        .json({ error: text });
    }
  });

  async function writeBuffer(session: Session, path: string, data: Buffer) {
    await run(session, (fs) => fs.uploadFrom(Readable.from([data]), path));
  }

  app.post(at("/writeFile"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const { path, content, encoding } = req.body;
    if (!path) return res.status(400).json({ error: "File path is required" });
    if (typeof content !== "string") {
      return res.status(400).json({ error: "File content is required" });
    }
    try {
      await writeBuffer(
        found.session,
        path,
        Buffer.from(content, encoding === "base64" ? "base64" : "utf8"),
      );
      res.json({ message: "File written successfully", path });
    } catch (error) {
      res.status(500).json({ error: message(error, "Could not write file") });
    }
  });

  app.post(at("/createFile"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const { path, fileName, content } = req.body;
    if (!path || !fileName)
      return res.status(400).json({ error: "Path and file name are required" });
    try {
      await writeBuffer(
        found.session,
        joinPath(path, fileName),
        Buffer.from(String(content ?? ""), "utf8"),
      );
      res.json({
        message: "File created successfully",
        path: joinPath(path, fileName),
      });
    } catch (error) {
      res.status(500).json({ error: message(error, "Could not create file") });
    }
  });

  app.post(at("/createFolder"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const { path, folderName } = req.body;
    if (!path || !folderName)
      return res
        .status(400)
        .json({ error: "Path and folder name are required" });
    try {
      const full = joinPath(path, folderName);
      await run(found.session, (fs) => fs.mkdir(full));
      res.json({ message: "Folder created successfully", path: full });
    } catch (error) {
      res
        .status(500)
        .json({ error: message(error, "Could not create folder") });
    }
  });

  app.delete(at("/deleteItem"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const { path, isDirectory } = req.body;
    if (!path) return res.status(400).json({ error: "Path is required" });
    try {
      await run(found.session, (fs) => fs.remove(path, isDirectory === true));
      res.json({ message: "Item deleted successfully", path });
    } catch (error) {
      res.status(500).json({ error: message(error, "Could not delete item") });
    }
  });

  const cancelled = new Set<string>();

  app.post(at("/deleteItems"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const paths: unknown = req.body?.paths;
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every((p) => typeof p === "string" && p)
    ) {
      return res.status(400).json({ error: "paths must be non-empty strings" });
    }
    const dirs = new Set<unknown>(
      Array.isArray(req.body?.directories) ? req.body.directories : [],
    );
    const key =
      typeof req.body?.opId === "string"
        ? `${found.sessionId}:${req.body.opId}`
        : "";
    const results: Array<{ path: string; error?: string }> = [];
    for (const path of new Set(paths as string[])) {
      if (key && cancelled.has(key)) {
        results.push({ path, error: "Cancelled" });
        continue;
      }
      try {
        await run(found.session, (fs) => fs.remove(path, dirs.has(path)));
        results.push({ path });
      } catch (error) {
        results.push({ path, error: message(error, "Could not delete item") });
      }
    }
    if (key) cancelled.delete(key);
    res.json({ results });
  });

  app.post(at("/deleteItems/cancel"), (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    if (typeof req.body?.opId === "string")
      cancelled.add(`${found.sessionId}:${req.body.opId}`);
    res.json({ status: "success" });
  });

  async function renameTo(
    req: Request,
    res: Response,
    oldPath: string,
    newPath: string,
  ) {
    const found = owned(req, res);
    if (!found) return;
    try {
      await run(found.session, (fs) => fs.rename(oldPath, newPath));
      res.json({ message: "Item renamed successfully", oldPath, newPath });
    } catch (error) {
      res.status(500).json({ error: message(error, "Could not rename item") });
    }
  }

  app.put(at("/renameItem"), (req, res) => {
    const { oldPath, newName } = req.body ?? {};
    if (!oldPath || !newName || String(newName).includes("/")) {
      return res
        .status(400)
        .json({ error: "Old path and a new name are required" });
    }
    return renameTo(req, res, oldPath, joinPath(parentOf(oldPath), newName));
  });

  app.put(at("/moveItem"), (req, res) => {
    const { oldPath, newPath } = req.body ?? {};
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: "Old and new paths are required" });
    }
    return renameTo(req, res, oldPath, newPath);
  });

  app.post(at("/downloadFile"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const path = req.body?.path;
    if (!path)
      return res.status(400).json({ error: "Missing download parameters" });
    try {
      const data = await readBuffer(found.session, path);
      const fileName = path.split("/").pop() || "download";
      res.json({
        content: data.toString("base64"),
        fileName,
        size: data.length,
        mimeType: getMimeType(fileName),
        path,
      });
    } catch (error) {
      res.status(500).json({ error: message(error, "Download failed") });
    }
  });

  app.post(at("/downloadFileStream"), async (req, res) => {
    const found = owned(req, res);
    if (!found) return;
    const path = req.body?.path;
    if (!path)
      return res.status(400).json({ error: "Missing download parameters" });
    const rangeStart = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
    const start = rangeStart ? Number(rangeStart[1]) : 0;
    const fileName = path.split("/").pop() || "download";
    try {
      await run(found.session, async (fs) => {
        let size = 0;
        try {
          size = await fs.size(path);
        } catch {
          // some servers refuse SIZE
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", contentDisposition(fileName));
        res.setHeader("Accept-Ranges", "bytes");
        if (start > 0) {
          if (size && start >= size) {
            res.setHeader("Content-Range", `bytes */${size}`);
            res.status(416).end();
            return;
          }
          res.status(206);
          if (size)
            res.setHeader(
              "Content-Range",
              `bytes ${start}-${size - 1}/${size}`,
            );
        }
        if (size) res.setHeader("Content-Length", String(size - start));
        res.on("close", () => {
          if (!res.writableEnded) fs.close();
        });
        await fs.downloadTo(res, path, start);
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ error: message(error, "Download failed") });
      } else {
        res.destroy();
        close(found.sessionId);
      }
    }
  });

  app.post(at("/uploadFileStream"), (req, res) => {
    const userId = ctx.currentActor();
    if (!userId)
      return res.status(401).json({ error: "Authentication required" });
    if (
      !String(req.headers["content-type"] ?? "").includes("multipart/form-data")
    ) {
      return res
        .status(400)
        .json({ error: "Expected multipart/form-data request" });
    }
    const fields: Record<string, string> = {};
    let handled = false;
    let failed = false;
    const fail = (status: number, error: string) => {
      if (failed || res.headersSent) return;
      failed = true;
      res.status(status).json({ error });
    };
    const bb = Busboy({ headers: req.headers, defParamCharset: "utf8" });
    bb.on("field", (name, value) => {
      fields[name] = value;
    });
    bb.on("file", (_name, stream, info) => {
      handled = true;
      const sessionId = fields.sessionId;
      const session = sessions[sessionId];
      if (!session?.isConnected || session.userId !== userId) {
        stream.resume();
        return fail(
          session ? 403 : 400,
          session
            ? "Session access denied"
            : `${label} connection not established`,
        );
      }
      touch(sessionId);
      const dir = fields.path || "/";
      const name = (fields.fileName || info.filename || "").replace(
        /[\\/]/g,
        "",
      );
      if (!name) {
        stream.resume();
        return fail(400, "File name is required");
      }
      const remote = joinPath(dir, name);
      run(session, (fs) => fs.uploadFrom(stream, remote)).then(
        () => {
          if (!failed)
            res.json({ message: "File uploaded successfully", path: remote });
        },
        (error) => fail(500, message(error, "Upload failed")),
      );
    });
    bb.on("close", () => {
      if (!handled) fail(400, "No file was sent");
    });
    bb.on("error", (error) => fail(400, message(error, "Upload failed")));
    req.on("aborted", () => {
      const session = sessions[fields.sessionId];
      if (session && session.userId === userId) close(fields.sessionId);
    });
    req.pipe(bb);
  });
}
