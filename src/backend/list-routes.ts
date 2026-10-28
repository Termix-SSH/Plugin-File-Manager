import { resolveHomeDirectory } from "./home-directory.js";
import { readDirectory } from "./read-directory.js";
import { getErrorMessage } from "./error-message.js";
import type { Express } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { execChannel, getSessionSftp, type SSHSession } from "./session.js";
import {
  formatMtime,
  isExecutableFile,
  modeToPermissions,
  parseLsDateToTimestamp,
} from "./utils.js";

type FileListingRoutesDeps = {
  ctx: PluginContext;
  sshSessions: Record<string, SSHSession>;
  verifySessionOwnership: (session: SSHSession, userId: string) => boolean;
};

type ListingResult = { status: number; body: unknown };

export function registerFileListingRoutes(
  app: Express,
  { ctx, sshSessions, verifySessionOwnership }: FileListingRoutesDeps,
): void {
  const pendingListings = new WeakMap<
    SSHSession,
    Map<
      string,
      {
        sudoPassword: SSHSession["sudoPassword"];
        promise: Promise<ListingResult>;
      }
    >
  >();
  /**
   * @openapi
   * /plugin-api/file-manager/listFiles:
   *   get:
   *     summary: List files in a directory
   *     description: Lists the files and directories in a given path on the remote host.
   *     tags:
   *       - File Manager
   *     parameters:
   *       - in: query
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: A list of files and directories.
   *       400:
   *         description: Session ID is required or SSH connection not established.
   *       500:
   *         description: Failed to list files.
   */
  app.get("/listFiles", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const sshConn = sshSessions[sessionId];
    let sshPath = (req.query.path as string) || ".";
    const userId = ctx.currentActor()!;
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    const sendJson = ({ status, body }: ListingResult) => {
      if (closed || res.destroyed || res.writableEnded || res.headersSent)
        return;
      return res.status(status).json(body);
    };

    if (!sessionId) {
      return sendJson({
        status: 400,
        body: { error: "Session ID is required" },
      });
    }

    if (!sshConn?.isConnected) {
      return sendJson({
        status: 400,
        body: { error: "SSH connection not established" },
      });
    }

    if (!verifySessionOwnership(sshConn, userId)) {
      return sendJson({
        status: 403,
        body: { error: "Session access denied" },
      });
    }

    if (sshPath === ".") {
      try {
        sshPath = await resolveHomeDirectory(sshConn);
      } catch (error) {
        return sendJson({
          status: 500,
          body: {
            error: getErrorMessage(error, "Could not resolve home directory"),
          },
        });
      }
      // Home discovery yields; the session or its ownership may have changed.
      if (sshSessions[sessionId] !== sshConn || !sshConn.isConnected) {
        return sendJson({
          status: 400,
          body: { error: "SSH connection not established" },
        });
      }
      if (!verifySessionOwnership(sshConn, userId)) {
        return sendJson({
          status: 403,
          body: { error: "Session access denied" },
        });
      }
    }

    const sudoPassword = sshConn.sudoPassword;
    const force = req.query.force === "true";
    const epoch =
      typeof req.query.epoch === "string" && /^\d+$/.test(req.query.epoch)
        ? req.query.epoch
        : "0";
    const prefetch = req.query.prefetch === "true";
    const listKey = JSON.stringify([userId, sshPath, epoch, prefetch]);
    let listings = pendingListings.get(sshConn);
    if (!listings) {
      listings = new Map();
      pendingListings.set(sshConn, listings);
    }
    const inFlight = listings.get(listKey);
    if (!force && inFlight && inFlight.sudoPassword === sudoPassword) {
      return sendJson(await inFlight.promise);
    }
    let settle!: (result: ListingResult) => void;
    const promise = new Promise<ListingResult>((resolve) => {
      settle = resolve;
    });
    if (!force) listings.set(listKey, { sudoPassword, promise });
    let settled = false;
    let released = false;
    // Once-only so the watchdog and a late callback never double-decrement.
    const release = () => {
      if (released) return;
      released = true;
      sshConn.activeOperations--;
    };
    // Joiners wait on this promise; a hung SFTP/exec callback must not strand them.
    const watchdog = setTimeout(() => {
      release();
      finish(504, { error: "Directory listing timed out" });
    }, 30_000);
    const finish = (status: number, body: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (!force && listings.get(listKey)?.promise === promise) {
        listings.delete(listKey);
      }
      settle({ status, body });
    };

    sshConn.lastActive = Date.now();
    sshConn.activeOperations++;
    const trySFTP = () => {
      try {
        ctx.log.info(`Opening SFTP channel for listFiles: ${sessionId}`);
        getSessionSftp(sshConn)
          .then((sftp) => {
            readDirectory(
              sftp,
              sshPath,
              (readdirErr, list) => {
                if (readdirErr) {
                  if (
                    prefetch &&
                    ((readdirErr as Error & { code?: number }).code === 3 ||
                      /permission denied|access denied/i.test(
                        readdirErr.message,
                      ))
                  ) {
                    release();
                    return finish(403, {
                      needsSudo: true,
                      prefetchSkippedSudo: true,
                      path: sshPath,
                    });
                  }
                  ctx.log.warn(
                    `SFTP readdir failed, trying fallback: ${readdirErr.message}`,
                  );
                  tryFallbackMethod();
                  return;
                }

                const symlinks: Array<{ index: number; path: string }> = [];
                const files: Array<{
                  name: string;
                  type: string;
                  size: number | undefined;
                  modified: string;
                  modifiedTimestamp: number;
                  permissions: string;
                  owner: string;
                  group: string;
                  linkTarget: string | undefined;
                  path: string;
                  executable: boolean;
                }> = [];

                for (const entry of list) {
                  if (entry.filename === "." || entry.filename === "..")
                    continue;

                  const attrs = entry.attrs;
                  const permissions = modeToPermissions(attrs.mode);
                  const isDirectory = attrs.isDirectory();
                  const isLink = attrs.isSymbolicLink();

                  const fileEntry = {
                    name: entry.filename,
                    type: isDirectory ? "directory" : isLink ? "link" : "file",
                    size: isDirectory ? undefined : attrs.size,
                    modified: formatMtime(attrs.mtime),
                    modifiedTimestamp: attrs.mtime,
                    permissions,
                    owner: String(attrs.uid),
                    group: String(attrs.gid),
                    linkTarget: undefined as string | undefined,
                    path: `${sshPath.endsWith("/") ? sshPath : sshPath + "/"}${entry.filename}`,
                    executable:
                      !isDirectory && !isLink
                        ? isExecutableFile(permissions, entry.filename)
                        : false,
                  };

                  if (isLink) {
                    symlinks.push({
                      index: files.length,
                      path: fileEntry.path,
                    });
                  }

                  files.push(fileEntry);
                }

                if (symlinks.length === 0) {
                  release();
                  return finish(200, { files, path: sshPath });
                }

                let resolved = 0;
                let responded = false;

                const sendResponse = () => {
                  if (responded) return;
                  responded = true;
                  release();
                  finish(200, { files, path: sshPath });
                };

                const readlinkTimeout = setTimeout(sendResponse, 5000);

                for (const link of symlinks) {
                  sftp.readlink(link.path, (linkErr, target) => {
                    resolved++;
                    if (!linkErr && target) {
                      files[link.index].linkTarget = target;
                    }
                    if (resolved === symlinks.length) {
                      clearTimeout(readlinkTimeout);
                      sendResponse();
                    }
                  });
                }
              },
              (error) =>
                ctx.log.warn(`SFTP directory close failed: ${error.message}`),
            );
          })
          .catch((err: Error) => {
            ctx.log.warn(
              `SFTP failed for listFiles, trying fallback: ${err.message}`,
            );
            const isChannelFailure =
              err.message.toLowerCase().includes("channel open failure") ||
              err.message.toLowerCase().includes("open failed");
            if (isChannelFailure) {
              sshConn.isConnected = false;
              sshConn.sftp = undefined;
            }
            tryFallbackMethod();
          });
      } catch (sftpErr: unknown) {
        const errMsg = getErrorMessage(sftpErr);
        ctx.log.warn(`SFTP connection error, trying fallback: ${errMsg}`);
        tryFallbackMethod();
      }
    };

    const tryFallbackMethod = () => {
      if (!sshConn?.isConnected) {
        release();
        return finish(503, {
          error: "SSH session disconnected",
          disconnected: true,
        });
      }
      try {
        const escapedPath = sshPath.replace(/'/g, "'\"'\"'");
        execChannel(
          sshConn,
          `command ls -la --color=never '${escapedPath}'`,
          (err, stream) => {
            if (err) {
              release();
              ctx.log.error("SSH listFiles error:", err);
              return finish(500, { error: err.message });
            }

            let data = "";
            let errorData = "";

            stream.on("data", (chunk: Buffer) => {
              data += chunk.toString();
            });

            stream.stderr.on("data", (chunk: Buffer) => {
              errorData += chunk.toString();
            });

            stream.on("close", (code) => {
              if (code !== 0) {
                const isPermissionDenied =
                  errorData.toLowerCase().includes("permission denied") ||
                  errorData.toLowerCase().includes("access denied");

                if (isPermissionDenied) {
                  if (prefetch) {
                    release();
                    return finish(403, {
                      needsSudo: true,
                      prefetchSkippedSudo: true,
                      path: sshPath,
                    });
                  }
                  if (sudoPassword) {
                    ctx.log.info(
                      "Permission denied for listFiles, retrying with sudo",
                    );
                    tryWithSudo();
                    return;
                  }

                  release();
                  ctx.log.warn(
                    `Permission denied for listFiles, sudo required: ${sshPath}`,
                  );
                  return finish(403, {
                    error: `Permission denied: Cannot access ${sshPath}`,
                    needsSudo: true,
                    path: sshPath,
                  });
                }

                release();
                ctx.log.error(
                  `SSH listFiles command failed with code ${code}: ${errorData.replace(/\n/g, " ").trim()}`,
                );
                return finish(500, { error: `Command failed: ${errorData}` });
              }
              release();

              const lines = data.split("\n").filter((line) => line.trim());
              const files = [];

              for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const parts = line.split(/\s+/);
                if (parts.length >= 9) {
                  const permissions = parts[0];
                  const owner = parts[2];
                  const group = parts[3];
                  const size = parseInt(parts[4], 10);

                  let dateStr = "";
                  const nameStartIndex = 8;

                  if (parts[5] && parts[6] && parts[7]) {
                    dateStr = `${parts[5]} ${parts[6]} ${parts[7]}`;
                  }

                  const name = parts.slice(nameStartIndex).join(" ");
                  const isDirectory = permissions.startsWith("d");
                  const isLink = permissions.startsWith("l");

                  if (name === "." || name === "..") continue;

                  let actualName = name;
                  let linkTarget = undefined;
                  if (isLink && name.includes(" -> ")) {
                    const linkParts = name.split(" -> ");
                    actualName = linkParts[0];
                    linkTarget = linkParts[1];
                  }

                  files.push({
                    name: actualName,
                    type: isDirectory ? "directory" : isLink ? "link" : "file",
                    size: isDirectory ? undefined : size,
                    modified: dateStr,
                    modifiedTimestamp: parseLsDateToTimestamp(dateStr),
                    permissions,
                    owner,
                    group,
                    linkTarget,
                    path: `${sshPath.endsWith("/") ? sshPath : sshPath + "/"}${actualName}`,
                    executable:
                      !isDirectory && !isLink
                        ? isExecutableFile(permissions, actualName)
                        : false,
                  });
                }
              }

              finish(200, { files, path: sshPath });
            });
          },
        );
      } catch (execErr: unknown) {
        release();
        const errMsg = getErrorMessage(execErr);
        ctx.log.error(`Fallback listFiles exec failed: ${errMsg}`);
        return finish(500, { error: errMsg });
      }
    };

    const tryWithSudo = () => {
      try {
        const escapedPath = sshPath.replace(/'/g, "'\"'\"'");
        const sudoCommand = `sudo -S -p '' /bin/ls -la --color=never '${escapedPath}' 2>&1`;

        execChannel(sshConn, sudoCommand, (err, stream) => {
          if (err) {
            release();
            ctx.log.error("SSH sudo listFiles error:", err);
            return finish(500, { error: err.message });
          }

          let data = "";
          let errorData = "";

          // stdin, not argv: keeps the password out of the process list
          stream.write(`${sudoPassword}\n`);

          stream.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });

          stream.stderr.on("data", (chunk: Buffer) => {
            errorData += chunk.toString();
          });

          stream.on("close", (code) => {
            release();

            data = data.replace(/\[sudo\] password for .+?:\s*/g, "");

            if (
              data.toLowerCase().includes("sorry, try again") ||
              data.toLowerCase().includes("incorrect password") ||
              errorData.toLowerCase().includes("sorry, try again")
            ) {
              if (sshConn.sudoPassword === sudoPassword) {
                sshConn.sudoPassword = undefined;
              }
              return finish(403, {
                error: "Sudo authentication failed. Please try again.",
                needsSudo: true,
                sudoFailed: true,
                path: sshPath,
              });
            }

            if (code !== 0 && !data.trim()) {
              ctx.log.error(
                `SSH sudo listFiles failed with code ${code}: ${errorData.replace(/\n/g, " ").trim()}`,
              );
              return finish(500, {
                error: `Sudo command failed: ${errorData || data}`,
              });
            }

            const lines = data.split("\n").filter((line) => line.trim());
            const files: Array<{
              name: string;
              type: string;
              size: number | undefined;
              modified: string;
              modifiedTimestamp: number;
              permissions: string;
              owner: string;
              group: string;
              linkTarget: string | undefined;
              path: string;
              executable: boolean;
            }> = [];

            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              const parts = line.split(/\s+/);
              if (parts.length >= 9) {
                const permissions = parts[0];
                const owner = parts[2];
                const group = parts[3];
                const size = parseInt(parts[4], 10);

                let dateStr = "";
                const nameStartIndex = 8;

                if (parts[5] && parts[6] && parts[7]) {
                  dateStr = `${parts[5]} ${parts[6]} ${parts[7]}`;
                }

                const name = parts.slice(nameStartIndex).join(" ");
                const isDirectory = permissions.startsWith("d");
                const isLink = permissions.startsWith("l");

                if (name === "." || name === "..") continue;

                let actualName = name;
                let linkTarget = undefined;
                if (isLink && name.includes(" -> ")) {
                  const linkParts = name.split(" -> ");
                  actualName = linkParts[0];
                  linkTarget = linkParts[1];
                }

                files.push({
                  name: actualName,
                  type: isDirectory ? "directory" : isLink ? "link" : "file",
                  size: isDirectory ? undefined : size,
                  modified: dateStr,
                  modifiedTimestamp: parseLsDateToTimestamp(dateStr),
                  permissions,
                  owner,
                  group,
                  linkTarget,
                  path: `${sshPath.endsWith("/") ? sshPath : sshPath + "/"}${actualName}`,
                  executable:
                    !isDirectory && !isLink
                      ? isExecutableFile(permissions, actualName)
                      : false,
                });
              }
            }

            finish(200, { files, path: sshPath });
          });
        });
      } catch (execErr: unknown) {
        release();
        const errMsg = getErrorMessage(execErr);
        ctx.log.error(`Sudo listFiles exec failed: ${errMsg}`);
        return finish(500, { error: errMsg });
      }
    };

    trySFTP();
    return sendJson(await promise);
  });
}
