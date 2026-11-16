import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { execChannel, type SSHSession } from "./session.js";

const quote = (value: string) => value.replace(/'/g, "'\"'\"'");

const isTar = (name: string) =>
  /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(name);

export type ExtractCommand = {
  command: string;
  targetPath: string;
  /** Whether the command prints one line per extracted entry on stdout. */
  listsEntries: boolean;
  /** Prints the number of entries in the archive, when that is cheap to get. */
  countCommand?: string;
};

/**
 * The command that extracts an archive on the remote host, picked by file
 * extension. With `verbose`, tar and unzip print each entry as it is written
 * so the caller can count them.
 */
export function buildExtractCommand(
  archivePath: string,
  extractPath?: string,
  { verbose = false }: { verbose?: boolean } = {},
): ExtractCommand | null {
  const fileExt = (archivePath.split("/").pop() || "").toLowerCase();
  const targetPath =
    extractPath || archivePath.substring(0, archivePath.lastIndexOf("/"));
  const archive = quote(archivePath);
  const target = quote(targetPath);
  const v = verbose ? "v" : "";
  const result = (command: string, extra: Partial<ExtractCommand> = {}) => ({
    command,
    targetPath,
    listsEntries: false,
    ...extra,
  });
  const tar = (flags: string) =>
    result(`tar -x${v}${flags} '${archive}' -C '${target}'`, {
      listsEntries: verbose,
    });

  if (fileExt.endsWith(".tar.gz") || fileExt.endsWith(".tgz")) return tar("zf");
  if (fileExt.endsWith(".tar.bz2") || fileExt.endsWith(".tbz2"))
    return tar("jf");
  if (fileExt.endsWith(".tar.xz") || fileExt.endsWith(".txz")) return tar("Jf");
  if (fileExt.endsWith(".tar")) return tar("f");
  if (fileExt.endsWith(".zip")) {
    // unzip already prints a line per entry; -q is what would silence it.
    return result(`unzip -o '${archive}' -d '${target}'`, {
      listsEntries: verbose,
      countCommand: verbose ? `unzip -Z1 '${archive}' | wc -l` : undefined,
    });
  }
  if (fileExt.endsWith(".gz")) {
    const decompressed = quote(archivePath.replace(/\.gz$/i, ""));
    return result(`gunzip -c '${archive}' > '${decompressed}'`);
  }
  if (fileExt.endsWith(".bz2")) return result(`bunzip2 -k '${archive}'`);
  if (fileExt.endsWith(".xz")) return result(`unxz -k '${archive}'`);
  if (fileExt.endsWith(".7z")) return result(`7z x '${archive}' -o'${target}'`);
  if (fileExt.endsWith(".rar"))
    return result(`unrar x '${archive}' '${target}/'`);
  return null;
}

/** Turns a failed extract's stderr into a message that says what to install. */
export function friendlyExtractError(
  archivePath: string,
  errorOutput: string,
): string {
  const fileExt = (archivePath.split("/").pop() || "").toLowerCase();
  if (!errorOutput) return "Failed to extract archive";
  if (!errorOutput.includes("not found")) return errorOutput;

  let missingCmd = "";
  let installHint = "";
  if (fileExt.endsWith(".zip")) {
    missingCmd = "unzip";
    installHint = "apt install unzip / yum install unzip / brew install unzip";
  } else if (isTar(fileExt)) {
    missingCmd = "tar";
    installHint = "Usually pre-installed on Linux/Unix systems";
  } else if (fileExt.endsWith(".gz")) {
    missingCmd = "gunzip";
    installHint = "apt install gzip / yum install gzip / Usually pre-installed";
  } else if (fileExt.endsWith(".bz2")) {
    missingCmd = "bunzip2";
    installHint = "apt install bzip2 / yum install bzip2 / brew install bzip2";
  } else if (fileExt.endsWith(".xz")) {
    missingCmd = "unxz";
    installHint = "apt install xz-utils / yum install xz / brew install xz";
  } else if (fileExt.endsWith(".7z")) {
    missingCmd = "7z";
    installHint =
      "apt install p7zip-full / yum install p7zip / brew install p7zip";
  } else if (fileExt.endsWith(".rar")) {
    missingCmd = "unrar";
    installHint = "apt install unrar / yum install unrar / brew install unrar";
  }
  return missingCmd
    ? `Command '${missingCmd}' not found on remote server. Please install it first: ${installHint}`
    : errorOutput;
}

/** unzip prints a header and a summary; only these lines are entries. */
const UNZIP_ENTRY = /^\s*(inflating|extracting|creating|linking):/;

export type ExtractJob = {
  id: string;
  userId: string;
  sessionId: string;
  archivePath: string;
  extractPath: string;
  status: "running" | "done" | "error";
  /** Entries written so far, when the command lists them. */
  extracted?: number;
  /** Entries in the archive, when it could be counted cheaply. */
  total?: number;
  error?: string;
};

type ExtractRoutesDeps = {
  ctx: PluginContext;
  sshSessions: Record<string, SSHSession>;
  scheduleSessionCleanup: (sessionId: string) => void;
  verifySessionOwnership: (session: SSHSession, userId: string) => boolean;
  /** How long a finished job stays readable. */
  keepFinishedMs?: number;
};

export function registerExtractProgressRoutes(
  app: Express,
  {
    ctx,
    sshSessions,
    scheduleSessionCleanup,
    verifySessionOwnership,
    keepFinishedMs = 10 * 60 * 1000,
  }: ExtractRoutesDeps,
): void {
  const jobs = new Map<string, ExtractJob>();

  /**
   * @openapi
   * /plugin-api/file-manager/extractArchive/start:
   *   post:
   *     summary: Start extracting an archive
   *     description: Starts extracting an archive on the remote host and answers at once with an operation id. Poll /extractArchive/status/{operationId} for progress and the result. The same formats as /extractArchive are supported.
   *     tags:
   *       - File Manager
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               sessionId:
   *                 type: string
   *               archivePath:
   *                 type: string
   *               extractPath:
   *                 type: string
   *     responses:
   *       202:
   *         description: Extraction started.
   *       400:
   *         description: Missing required parameters, SSH connection not established, or unsupported archive format.
   *       403:
   *         description: Session access denied.
   */
  app.post("/extractArchive/start", (req, res) => {
    const { sessionId, archivePath, extractPath } = req.body ?? {};
    const userId = ctx.currentActor();

    if (
      typeof sessionId !== "string" ||
      typeof archivePath !== "string" ||
      !sessionId ||
      !archivePath ||
      (extractPath !== undefined && typeof extractPath !== "string")
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }
    const session = sshSessions[sessionId];
    if (!session || !session.isConnected) {
      return res.status(400).json({ error: "SSH session not connected" });
    }
    if (!userId || !verifySessionOwnership(session, userId)) {
      return res.status(403).json({ error: "Session access denied" });
    }
    const plan = buildExtractCommand(archivePath, extractPath, {
      verbose: true,
    });
    if (!plan) {
      return res.status(400).json({ error: "Unsupported archive format" });
    }

    session.lastActive = Date.now();
    scheduleSessionCleanup(sessionId);

    const job: ExtractJob = {
      id: randomUUID(),
      userId,
      sessionId,
      archivePath,
      extractPath: plan.targetPath,
      status: "running",
      extracted: plan.listsEntries ? 0 : undefined,
    };
    jobs.set(job.id, job);

    // The session stays open while the archive extracts, however long it takes.
    session.activeOperations++;
    const finish = (error?: string) => {
      if (job.status !== "running") return;
      job.status = error === undefined ? "done" : "error";
      job.error = error;
      if (error !== undefined) {
        ctx.log.error(`Extract failed: ${archivePath} ${error}`);
      }
      session.activeOperations--;
      setTimeout(() => jobs.delete(job.id), keepFinishedMs).unref?.();
    };

    if (plan.countCommand) {
      execChannel(session, plan.countCommand, (err, stream) => {
        if (err) return;
        let out = "";
        stream.on("data", (data: Buffer) => {
          if (out.length < 64) out += data.toString();
        });
        stream.stderr.on("data", () => {});
        stream.on("error", () => {});
        stream.on("close", (code: number) => {
          const total = Number.parseInt(out.trim(), 10);
          if (code === 0 && Number.isFinite(total) && total > 0)
            job.total = total;
        });
      });
    }

    const isZip = archivePath.toLowerCase().endsWith(".zip");
    execChannel(session, plan.command, (err, stream) => {
      if (err) {
        finish("Failed to execute extract command");
        return;
      }
      let errorOutput = "";
      let partial = "";
      stream.on("data", (data: Buffer) => {
        if (!plan.listsEntries) return;
        const lines = (partial + data.toString()).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (!line || (isZip && !UNZIP_ENTRY.test(line))) continue;
          job.extracted = (job.extracted ?? 0) + 1;
        }
      });
      stream.stderr.on("data", (data: Buffer) => {
        if (errorOutput.length < 8192) errorOutput += data.toString();
      });
      stream.on("error", () => finish("Stream error while extracting archive"));
      stream.on("close", (code: number) => {
        if (code === 0) finish();
        else finish(friendlyExtractError(archivePath, errorOutput.trim()));
      });
    });

    res.status(202).json({ operationId: job.id, extractPath: job.extractPath });
  });

  /**
   * @openapi
   * /plugin-api/file-manager/extractArchive/status/{operationId}:
   *   get:
   *     summary: Progress of an archive extraction
   *     description: Reports whether an extraction started with /extractArchive/start is running, done or failed, with the number of entries written so far and the total when they are known.
   *     tags:
   *       - File Manager
   *     parameters:
   *       - in: path
   *         name: operationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The extraction's status.
   *       404:
   *         description: No such extraction for this user.
   */
  app.get("/extractArchive/status/:operationId", (req, res) => {
    const job = jobs.get(String(req.params.operationId));
    // Someone else's job answers the same as a missing one.
    if (!job || job.userId !== ctx.currentActor()) {
      return res.status(404).json({ error: "Extraction not found" });
    }
    const session = sshSessions[job.sessionId];
    if (session && job.status === "running") session.lastActive = Date.now();
    res.json({
      status: job.status,
      extracted: job.extracted,
      total: job.total,
      error: job.error,
      extractPath: job.extractPath,
    });
  });
}
