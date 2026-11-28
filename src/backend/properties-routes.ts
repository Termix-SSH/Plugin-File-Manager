import type { Express } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { execBuffer, getLiveSessionSftp, type SSHSession } from "./session.js";
import { modeToPermissions } from "./utils.js";

type PropertiesRoutesDeps = {
  ctx: PluginContext;
  sshSessions: Record<string, SSHSession>;
  verifySessionOwnership: (session: SSHSession, userId: string) => boolean;
};

const MAX_PATHS = 50;
// shortcut: one wall-clock cap per batch, partial results kept; upgrade to a cancellable job if huge trees matter.
const DU_TIMEOUT_MS = 60_000;

const quote = (s: string) => `'${s.replace(/'/g, "'\"'\"'")}'`;

/** Sizes in bytes. GNU du first (apparent size), then POSIX -k (disk blocks). */
async function folderSizes(
  session: SSHSession,
  paths: string[],
): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  const deadline = Date.now() + DU_TIMEOUT_MS;
  for (const [flag, unit] of [
    ["-sb", 1],
    ["-sk", 1024],
  ] as const) {
    const todo = paths.filter((p) => sizes[p] === undefined);
    const left = deadline - Date.now();
    if (todo.length === 0 || left <= 0) break;
    const result = await Promise.race([
      execBuffer(
        session,
        `du ${flag} -- ${todo.map(quote).join(" ")} 2>/dev/null`,
        1 << 20,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
    ]);
    if (!result) break;
    for (const line of result.stdout.toString("utf8").split("\n")) {
      const m = /^(\d+)\t(.+)$/.exec(line);
      if (m && todo.includes(m[2])) sizes[m[2]] = Number(m[1]) * unit;
    }
  }
  return sizes;
}

export function registerPropertiesRoutes(
  app: Express,
  { ctx, sshSessions, verifySessionOwnership }: PropertiesRoutesDeps,
): void {
  const sessionFor = (sessionId: unknown) => {
    const session =
      typeof sessionId === "string" ? sshSessions[sessionId] : undefined;
    if (!session?.isConnected)
      return { error: 400, message: "SSH connection not established" } as const;
    if (!verifySessionOwnership(session, ctx.currentActor()!)) {
      return { error: 403, message: "Session access denied" } as const;
    }
    session.lastActive = Date.now();
    return { session } as const;
  };

  /**
   * @openapi
   * /plugin-api/file-manager/dirSizes:
   *   post:
   *     summary: Folder sizes
   *     description: Total size in bytes of each folder, measured with du. A folder that could not be measured is left out.
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
   *               paths:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Map of folder path to size in bytes.
   *       400:
   *         description: Missing parameters or SSH connection not established.
   */
  app.post("/dirSizes", async (req, res) => {
    const { sessionId, paths } = req.body ?? {};
    const found = sessionFor(sessionId);
    if ("error" in found) {
      return res.status(found.error).json({ error: found.message });
    }
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.length > MAX_PATHS ||
      paths.some((p) => typeof p !== "string" || !p)
    ) {
      return res.status(400).json({ error: "paths must be 1-50 strings" });
    }
    try {
      res.json({ sizes: await folderSizes(found.session, paths) });
    } catch (error) {
      ctx.log.error("dirSizes failed", error);
      res.status(500).json({ error: "Failed to measure folders" });
    }
  });

  /**
   * @openapi
   * /plugin-api/file-manager/properties:
   *   post:
   *     summary: File or folder properties
   *     description: Type, size, times, permissions and owner of one path.
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
   *               path:
   *                 type: string
   *     responses:
   *       200:
   *         description: The properties.
   *       400:
   *         description: Missing parameters or SSH connection not established.
   *       500:
   *         description: Failed to read the properties.
   */
  app.post("/properties", async (req, res) => {
    const { sessionId, path } = req.body ?? {};
    const found = sessionFor(sessionId);
    if ("error" in found) {
      return res.status(found.error).json({ error: found.message });
    }
    if (typeof path !== "string" || !path) {
      return res.status(400).json({ error: "Path is required" });
    }
    try {
      const sftp = await getLiveSessionSftp(found.session);
      const lstat = await new Promise<import("ssh2").Stats>((resolve, reject) =>
        sftp.lstat(path, (err, s) => (err ? reject(err) : resolve(s))),
      );
      const isLink = modeToPermissions(lstat.mode).startsWith("l");
      let stats = lstat;
      let linkTarget: string | undefined;
      if (isLink) {
        linkTarget = await new Promise<string | undefined>((resolve) =>
          sftp.readlink(path, (err, t) => resolve(err ? undefined : t)),
        );
        stats = await new Promise<import("ssh2").Stats>((resolve) =>
          sftp.stat(path, (err, s) => resolve(err ? lstat : s)),
        );
      }
      const isDirectory = modeToPermissions(stats.mode).startsWith("d");

      // Owner names and creation time need GNU stat; the numeric ids stand in without it.
      let owner: string | undefined;
      let group: string | undefined;
      let created: number | undefined;
      const named = await execBuffer(
        found.session,
        `stat -c '%U\t%G\t%W' -- ${quote(path)} 2>/dev/null`,
        4096,
      );
      const parts = named.stdout.toString("utf8").trim().split("\t");
      if (named.code === 0 && parts.length === 3) {
        owner = parts[0];
        group = parts[1];
        const born = Number(parts[2]);
        if (born > 0) created = born;
      }

      res.json({
        path,
        name: path.split("/").filter(Boolean).pop() || path,
        type: isLink ? "link" : isDirectory ? "directory" : "file",
        targetIsDirectory: isLink ? isDirectory : undefined,
        linkTarget,
        size: stats.size,
        modified: stats.mtime,
        accessed: stats.atime,
        created,
        permissions: modeToPermissions(lstat.mode),
        octal: (lstat.mode & 0o7777).toString(8).padStart(3, "0"),
        uid: stats.uid,
        gid: stats.gid,
        owner,
        group,
      });
    } catch (error) {
      ctx.log.error("properties failed", error);
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to read properties",
      });
    }
  });
}
