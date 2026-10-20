// Local disk <-> remote SFTP transfers for the desktop app's dual-pane file
// manager. The bytes never pass through the renderer: this plugin's backend on
// the embedded backend streams them between disk and the existing
// `uploadFileStream` / `downloadFileStream` routes (see local-desktop.ts), and
// we only orchestrate and relay progress here.
//
// The renderer deliberately does not choose the URL or the auth headers. It
// names the origin that owns the SSH session ("local" embedded backend or the
// linked server) and the backend resolves the rest, so a compromised renderer
// cannot turn the transfer bridge into an HTTP client.

import { getSessionOrigin, fileManagerApi } from "./client";
import { getDeviceId } from "@termix-ssh/plugin-sdk/ui";
import { subscribeLocalEvents } from "../lib/local-events";
import type { LocalFsResult, LocalTransferOrigin } from "../local-types";

interface LocalTransferProgressEvent {
  transferred: number;
  total?: number;
}

type ProgressListener = (event: LocalTransferProgressEvent) => void;

/** Error from the backend; `code` is e.g. "EEXIST" or "EBUSY". */
class LocalTransferError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "LocalTransferError";
    this.code = code;
  }
}

const progressListeners = new Map<string, ProgressListener>();
let unsubscribeProgress: (() => void) | null = null;

function ensureProgressSubscription() {
  if (unsubscribeProgress) return;
  unsubscribeProgress = subscribeLocalEvents((event) => {
    if (event.type !== "progress") return;
    const listener = progressListeners.get(String(event.transferId));
    listener?.({
      transferred: Number(event.transferred),
      total: typeof event.total === "number" ? event.total : undefined,
    });
  });
}

function releaseProgressSubscription() {
  if (progressListeners.size > 0 || !unsubscribeProgress) return;
  unsubscribeProgress();
  unsubscribeProgress = null;
}

function transferOriginFor(sessionId: string): LocalTransferOrigin {
  return getSessionOrigin(sessionId);
}

export function createLocalTransferId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function post<T>(
  route: string,
  body: Record<string, unknown>,
): Promise<LocalFsResult<T>> {
  const response = await fileManagerApi().post<LocalFsResult<T>>(
    `/local/${route}`,
    body,
    { timeout: 0 },
  );
  return response.data;
}

/**
 * Streams a file from the local disk into `remoteDir` on the SSH session,
 * using the same multipart route the in-browser upload uses.
 */
export async function uploadLocalFileToSession(options: {
  sessionId: string;
  remoteDir: string;
  localPath: string;
  fileName: string;
  hostId?: number;
  transferId?: string;
  onProgress?: ProgressListener;
}): Promise<void> {
  const transferId =
    options.transferId ?? createLocalTransferId("local-upload");

  const fields: Record<string, string> = {
    sessionId: options.sessionId,
    path: options.remoteDir,
  };
  if (options.hostId !== undefined) fields.hostId = String(options.hostId);

  if (options.onProgress) {
    progressListeners.set(transferId, options.onProgress);
    ensureProgressSubscription();
  }
  try {
    const result = await post<{ bytes: number }>("upload", {
      transferId,
      origin: transferOriginFor(options.sessionId),
      deviceId: getDeviceId() ?? undefined,
      fields,
      localPath: options.localPath,
      fileName: options.fileName,
    });
    if (result.success !== true) {
      throw new LocalTransferError(
        result.error || "Upload failed",
        result.code,
      );
    }
  } finally {
    progressListeners.delete(transferId);
    releaseProgressSubscription();
  }
}

/**
 * Streams a remote file from the SSH session straight to `destPath` on the
 * local disk. Refuses to replace an existing file (code "EEXIST") unless
 * `overwrite` is set.
 */
export async function downloadSessionFileToLocal(options: {
  sessionId: string;
  remotePath: string;
  destPath: string;
  /** The folder the user picked; the backend refuses any destination outside it. */
  rootPath: string;
  expectedSize?: number;
  overwrite?: boolean;
  transferId?: string;
  onProgress?: ProgressListener;
}): Promise<void> {
  const transferId =
    options.transferId ?? createLocalTransferId("local-download");

  if (options.onProgress) {
    progressListeners.set(transferId, options.onProgress);
    ensureProgressSubscription();
  }
  try {
    const result = await post<{ path: string }>("download", {
      transferId,
      origin: transferOriginFor(options.sessionId),
      deviceId: getDeviceId() ?? undefined,
      body: { sessionId: options.sessionId, path: options.remotePath },
      destPath: options.destPath,
      rootPath: options.rootPath,
      expectedSize: options.expectedSize,
      overwrite: options.overwrite === true,
    });
    if (result.success !== true) {
      throw new LocalTransferError(
        result.error || "Download failed",
        result.code,
      );
    }
  } finally {
    progressListeners.delete(transferId);
    releaseProgressSubscription();
  }
}

export async function cancelLocalTransfer(transferId: string): Promise<void> {
  await post("cancel", { transferId }).catch(() => {});
}
