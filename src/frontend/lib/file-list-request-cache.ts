import type { FileItem } from "../host-types";
import { createKeyedRequestCache } from "./keyed-request-cache";

export interface FileListResult {
  files: FileItem[];
  path: string;
}

const cache = createKeyedRequestCache<FileListResult>(5_000, 150);
const epochs = new Map<string, number>();
let epochCounter = 0;
const MAX_EPOCH_SESSIONS = 200;

export function getFileListEpoch(sessionId: string): number {
  return epochs.get(sessionId) ?? 0;
}

const keyFor = (sessionId: string, path: string) => `${sessionId}\0${path}`;

export function getCachedFileList(
  sessionId: string,
  path: string,
  loader: () => Promise<FileListResult>,
  force = false,
): Promise<FileListResult> {
  return cache.get(keyFor(sessionId, path), loader, { force });
}

export function peekCachedFileList(
  sessionId: string,
  path: string,
  // Stale entries are fine: callers repaint instantly, then force a refresh.
  maxAgeMs = 300_000,
): FileListResult | null {
  return cache.peek(keyFor(sessionId, path), maxAgeMs);
}

export function invalidateCachedFileList(
  sessionId: string,
  _path: string,
): void {
  // Globally monotonic, so evicting an old session's entry can never reuse a value.
  epochs.delete(sessionId);
  epochs.set(sessionId, ++epochCounter);
  if (epochs.size > MAX_EPOCH_SESSIONS) {
    epochs.delete(epochs.keys().next().value as string);
  }
  // A move or directory deletion can invalidate prefetched descendants too.
  cache.invalidateMatching((key) => key.startsWith(`${sessionId}\0`));
}

export function updateCachedFileList(
  sessionId: string,
  path: string,
  files: FileItem[],
): void {
  cache.set(keyFor(sessionId, path), { files, path });
}
