import type { Client as SSHClient } from "ssh2";

const CHANNEL_OPEN_TIMEOUT_MS = 20_000;
const SESSION_PROBE_TIMEOUT_MS = 5_000;

/** ssh2 never calls back once the connection is gone without a FIN or RST. */
export class SftpTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = "SftpTimeoutError";
  }
}

export class SessionLostError extends Error {
  constructor() {
    super("SSH connection not established");
    this.name = "SessionLostError";
  }
}

export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SftpTimeoutError(what)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Serializes SSH channel open requests so only one channel negotiation is
// in-flight at a time per session. Once the channel is established the slot
// is released immediately so the next open can proceed; the channels
// themselves remain open concurrently.
export class ChannelOpenSerializer {
  private tail: Promise<void> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    // A deadline here means one dead open cannot hold up the whole queue.
    const bounded = () =>
      withDeadline(action(), CHANNEL_OPEN_TIMEOUT_MS, "Opening an SSH channel");
    const next = this.tail.then(bounded, bounded);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

export interface SSHSession {
  client: SSHClient;
  isConnected: boolean;
  lastActive: number;
  timeout?: NodeJS.Timeout;
  activeOperations: number;
  sudoPassword?: string;
  sftp?: import("ssh2").SFTPWrapper;
  sftpPending?: Promise<import("ssh2").SFTPWrapper>;
  channelOpener: ChannelOpenSerializer;
  poolKey?: string;
  userId?: string;
  hostId?: number;
  ip?: string;
  port?: number;
  username?: string;
  transferDedicated?: boolean;
  transferId?: string;
  browseSessionId?: string;
  scpLegacy?: boolean;
}

export interface PendingTOTPSession {
  client: SSHClient;
  finish: (responses: string[]) => void;
  config: import("ssh2").ConnectConfig;
  createdAt: number;
  sessionId: string;
  hostId?: number;
  ip?: string;
  port?: number;
  username?: string;
  userId?: string;
  prompts?: Array<{ prompt: string; echo: boolean }>;
  totpPromptIndex?: number;
  resolvedPassword?: string;
  sudoPassword?: string;
  scpLegacy?: boolean;
  totpAttempts: number;
  isBrowserSignIn?: boolean;
}

/** A session id held by someone else, live or waiting on a login step. */
export function isSessionHeldByOther(
  live: Pick<SSHSession, "userId"> | undefined,
  pending: Pick<PendingTOTPSession, "userId"> | undefined,
  userId: string,
): boolean {
  if (live?.userId && live.userId !== userId) return true;
  return !!pending?.userId && pending.userId !== userId;
}

export function execWithSudo(
  session: SSHSession,
  command: string,
  sudoPassword: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execWithSudoBuffer(session, command, sudoPassword).then((result) => ({
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr,
    code: result.code,
  }));
}

export function execWithSudoBuffer(
  session: SSHSession,
  command: string,
  sudoPassword: string,
  maxStdoutBytes?: number,
): Promise<{
  stdout: Buffer;
  stderr: string;
  code: number;
  exceededLimit?: boolean;
}> {
  return new Promise((resolve) => {
    const sudoCommand = `sudo -S -p '' ${command} 2>&1`;

    execChannel(session, sudoCommand, (err, stream) => {
      if (err) {
        resolve({ stdout: Buffer.alloc(0), stderr: err.message, code: 1 });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;

      const finish = (
        code: number,
        extra: { exceededLimit?: boolean } = {},
      ) => {
        if (settled) return;
        settled = true;
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr,
          code,
          ...extra,
        });
      };

      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) {
          stderr = `Command output exceeds ${maxStdoutBytes} bytes`;
          finish(1, { exceededLimit: true });
          stream.close();
          return;
        }
        stdoutChunks.push(chunk);
      });

      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      stream.on("close", (code: number) => {
        if (settled) return;
        let stdout = Buffer.concat(stdoutChunks);
        const sudoPromptMatch = stdout
          .toString("utf8", 0, Math.min(stdout.length, 256))
          .match(/^\[sudo\] password for .+?:\s*/);
        if (sudoPromptMatch) {
          stdout = stdout.subarray(Buffer.byteLength(sudoPromptMatch[0]));
        }
        settled = true;
        resolve({ stdout, stderr, code: code || 0 });
      });

      stream.on("error", (streamErr: Error) => {
        stderr = streamErr.message;
        finish(1);
      });

      stream.write(`${sudoPassword}\n`);
    });
  });
}

export function execBuffer(
  session: SSHSession,
  command: string,
  maxStdoutBytes?: number,
): Promise<{
  stdout: Buffer;
  stderr: string;
  code: number;
  exceededLimit?: boolean;
}> {
  return new Promise((resolve) => {
    execChannel(session, command, (err, stream) => {
      if (err) {
        resolve({ stdout: Buffer.alloc(0), stderr: err.message, code: 1 });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;

      const finish = (
        code: number,
        extra: { exceededLimit?: boolean } = {},
      ) => {
        if (settled) return;
        settled = true;
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr,
          code,
          ...extra,
        });
      };

      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) {
          stderr = `Command output exceeds ${maxStdoutBytes} bytes`;
          finish(1, { exceededLimit: true });
          stream.close();
          return;
        }
        stdoutChunks.push(chunk);
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      stream.on("close", (code: number) => finish(code || 0));
      stream.on("error", (streamErr: Error) => {
        stderr = stderr || streamErr.message;
        finish(1);
      });
    });
  });
}

export function getSessionSftp(
  session: SSHSession,
): Promise<import("ssh2").SFTPWrapper> {
  if (session.sftp) {
    return Promise.resolve(session.sftp);
  }

  if (session.sftpPending) {
    return session.sftpPending;
  }

  const openOnce = (): Promise<import("ssh2").SFTPWrapper> =>
    session.channelOpener.run(
      () =>
        new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
          session.client.sftp((err, sftp) => {
            if (err) return reject(err);
            session.sftp = sftp;
            sftp.on("error", () => {
              session.sftp = undefined;
            });
            sftp.on("close", () => {
              session.sftp = undefined;
            });
            resolve(sftp);
          });
        }),
    );

  session.sftpPending = openOnce()
    .catch((err: Error) => {
      const isChannelFailure =
        err.message.toLowerCase().includes("channel open failure") ||
        err.message.toLowerCase().includes("open failed");
      if (isChannelFailure) {
        return new Promise<import("ssh2").SFTPWrapper>((resolve, reject) =>
          setTimeout(() => openOnce().then(resolve, reject), 500),
        );
      }
      return Promise.reject(err);
    })
    .finally(() => {
      session.sftpPending = undefined;
    });

  return session.sftpPending;
}

/** Closes a session whose transport stopped answering, so the next call reconnects. */
export function markSessionLost(session: SSHSession): void {
  session.isConnected = false;
  session.sftp = undefined;
  session.sftpPending = undefined;
  try {
    session.client.destroy();
  } catch {
    // Already gone.
  }
}

/**
 * Checks the transport really answers, since isConnected only changes when a
 * close reaches ssh2. Rejects with SessionLostError when it does not. Any other
 * failure, like a host with no SFTP server, is left for the caller's own path.
 */
export async function ensureSessionAlive(
  session: SSHSession,
  timeoutMs = SESSION_PROBE_TIMEOUT_MS,
): Promise<void> {
  try {
    const sftp = await withDeadline(
      getSessionSftp(session),
      timeoutMs,
      "Opening SFTP",
    );
    await withDeadline(
      new Promise<void>((resolve, reject) => {
        sftp.realpath(".", (err) => (err ? reject(err) : resolve()));
      }),
      timeoutMs,
      "SFTP check",
    );
  } catch (error) {
    if (error instanceof SftpTimeoutError) {
      markSessionLost(session);
      throw new SessionLostError();
    }
  }
}

/** The session's SFTP channel, after checking the connection still answers. */
export async function getLiveSessionSftp(
  session: SSHSession,
): Promise<import("ssh2").SFTPWrapper> {
  await ensureSessionAlive(session);
  return getSessionSftp(session);
}

export function execChannel(
  session: SSHSession,
  command: string,
  callback: (
    err: Error | undefined,
    stream: import("ssh2").ClientChannel,
  ) => void,
): void {
  session.channelOpener
    .run(
      () =>
        new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
          session.client.exec(command, (err, stream) => {
            if (err) return reject(err);
            resolve(stream);
          });
        }),
    )
    .then(
      (stream) => callback(undefined, stream),
      (err: Error) => callback(err, undefined as never),
    );
}

/**
 * Opens an SFTP channel owned by the caller, separate from `session.sftp`.
 * The caller must `end()` it.
 */
export function openDedicatedSftp(
  session: SSHSession,
): Promise<import("ssh2").SFTPWrapper> {
  return session.channelOpener.run(
    () =>
      new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
        session.client.sftp((err, sftp) => {
          if (err) return reject(err);
          // Failures reach the pending requests' callbacks; an unhandled
          // "error" event would take the whole backend down instead.
          sftp.on("error", () => {});
          resolve(sftp);
        });
      }),
  );
}
