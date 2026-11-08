import type { FileItem } from "../host-types";
import { createKeyedRequestCache } from "./keyed-request-cache";

export interface FileContentResult {
  content: string;
  path: string;
  encoding?: "base64" | "utf8";
}

const cache = createKeyedRequestCache<FileContentResult>(30_000, 24);
const keyFor = (sessionId: string, path: string) => `${sessionId}\0${path}`;

export function getCachedFileContent(
  sessionId: string,
  path: string,
  loader: () => Promise<FileContentResult>,
  force = false,
): Promise<FileContentResult> {
  return cache.get(keyFor(sessionId, path), loader, { force });
}

export function invalidateCachedFileContent(
  sessionId: string,
  path: string,
): void {
  const key = keyFor(sessionId, path);
  cache.invalidateMatching(
    (candidate) => candidate === key || candidate.startsWith(`${key}/`),
  );
}

export function shouldPrefetchFileContent(
  file: FileItem,
  maxPrefetchBytes: number,
): boolean {
  return (
    file.type === "file" &&
    typeof file.size === "number" &&
    file.size <= maxPrefetchBytes
  );
}
