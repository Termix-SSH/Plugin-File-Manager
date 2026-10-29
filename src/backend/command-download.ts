import type { Response } from "express";
import type { ClientChannel } from "ssh2";

export function isPermissionDenied(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  // SFTP status 3 is PERMISSION_DENIED.
  if (code === 3) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /permission denied|access denied/i.test(message);
}

export function isSudoRejected(stderr: string): boolean {
  return /sorry, try again|incorrect password|no password was provided/i.test(
    stderr,
  );
}

/**
 * Streams a command's stdout as the download. Headers wait for the first
 * byte or a clean exit, so a command that fails at once (cat on a file the
 * user can't read, a wrong sudo password) still gets a real error answer
 * instead of an empty file.
 */
export function pipeCommandDownload(
  stream: ClientChannel,
  res: Response,
  options: { stdin?: string; size?: number; onClose?: () => void } = {},
): void {
  let started = false;
  let stderr = "";
  const start = () => {
    if (started) return;
    started = true;
    if (options.size !== undefined)
      res.setHeader("Content-Length", String(options.size));
  };

  stream.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8");
  });
  stream.on("data", (chunk: Buffer) => {
    start();
    if (!res.write(chunk)) {
      stream.pause();
      res.once("drain", () => stream.resume());
    }
  });
  stream.on("close", (code: number | null) => {
    options.onClose?.();
    if (started) {
      res.end();
      return;
    }
    if (code === 0 || code == null) {
      start();
      res.end();
      return;
    }
    const clean = stderr.replace(/\[sudo\] password for .+?:\s*/g, "").trim();
    if (isSudoRejected(clean)) {
      res.status(403).json({
        error: "Sudo authentication failed. Please try again.",
        needsSudo: true,
        sudoFailed: true,
      });
    } else if (/permission denied/i.test(clean)) {
      res.status(403).json({ error: "Permission denied", needsSudo: true });
    } else if (/no such file/i.test(clean)) {
      res.status(404).json({ error: clean, fileNotFound: true });
    } else {
      res.status(500).json({ error: `Download failed: ${clean || code}` });
    }
  });
  stream.on("error", (err: Error) => {
    if (!started && !res.headersSent)
      res.status(500).json({ error: `Download failed: ${err.message}` });
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
  if (options.stdin !== undefined) stream.write(options.stdin);
}
