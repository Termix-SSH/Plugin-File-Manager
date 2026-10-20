// Access to the desktop app's own disk, served by this plugin's backend on
// the embedded backend (/local/* routes). Everything here is refused outside
// the desktop app so callers can feature-detect cheaply.

import { isElectron } from "@termix-ssh/plugin-sdk/ui";
import { fileManagerApi } from "../api/client";
import type {
  LocalDirectoryListing,
  LocalFsHomeInfo,
  LocalFsResult,
  LocalTrashResult,
  LocalWalkResult,
} from "../local-types";

export function isLocalFileBrowserAvailable(): boolean {
  return isElectron();
}

function unwrap<T>(result: LocalFsResult<T>): T {
  if (!result || result.success !== true) {
    const message =
      result && "error" in result && result.error
        ? result.error
        : "Local file operation failed";
    const error = new Error(message) as Error & { code?: string };
    if (result && "code" in result) error.code = result.code;
    throw error;
  }
  return result;
}

async function call<T>(
  route: string,
  body?: Record<string, unknown>,
): Promise<T> {
  if (!isLocalFileBrowserAvailable()) {
    throw new Error("Local file access is only available in the desktop app");
  }
  const api = fileManagerApi();
  const response = body
    ? await api.post<LocalFsResult<T>>(`/local/${route}`, body)
    : await api.get<LocalFsResult<T>>(`/local/${route}`);
  return unwrap(response.data);
}

export async function getLocalHome(): Promise<LocalFsHomeInfo> {
  return call("home");
}

export async function listLocalDirectory(
  dirPath: string,
): Promise<LocalDirectoryListing> {
  return call("list", { path: dirPath });
}

export async function createLocalFolder(
  parentPath: string,
  name: string,
): Promise<string> {
  return (await call<{ path: string }>("mkdir", { parent: parentPath, name }))
    .path;
}

export async function createLocalFile(
  parentPath: string,
  name: string,
): Promise<string> {
  return (
    await call<{ path: string }>("create-file", { parent: parentPath, name })
  ).path;
}

export async function renameLocalEntry(
  oldPath: string,
  newName: string,
): Promise<string> {
  return (
    await call<{ path: string }>("rename", { path: oldPath, name: newName })
  ).path;
}

/** Moves entries to the OS trash; resolves with per-path failures, if any. */
export async function trashLocalPaths(
  paths: string[],
): Promise<LocalTrashResult> {
  return call("trash", { paths });
}

/** Subset of `paths` that already exist on disk. */
export async function localPathsExist(paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  return (await call<{ existing: string[] }>("exists", { paths })).existing;
}

/** Creates `dirPath` (and parents). With `rootPath`, refuses anything outside it. */
export async function ensureLocalDirectory(
  dirPath: string,
  rootPath?: string,
): Promise<string> {
  return (
    await call<{ path: string }>("ensure-dir", {
      path: dirPath,
      root: rootPath,
    })
  ).path;
}

export async function walkLocalPaths(
  paths: string[],
): Promise<LocalWalkResult> {
  return call("walk", { paths });
}

export async function revealLocalPath(targetPath: string): Promise<void> {
  await call("reveal", { path: targetPath });
}

export async function openLocalPath(targetPath: string): Promise<void> {
  await call("open", { path: targetPath });
}
