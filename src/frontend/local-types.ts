export type LocalFsResult<T> =
  ({ success: true } & T) | { success: false; error: string; code?: string };

export interface LocalFsHomeInfo {
  home: string;
  separator: string;
  platform: string;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "link" | "other";
  created?: string;
  modified?: string;
  permissions?: string;
  owner?: string;
  group?: string;
  size: number;
  modifiedTimestamp?: number;
  linkTarget?: string;
  hidden: boolean;
}

export interface LocalDirectoryListing {
  path: string;
  parent: string | null;
  entries: LocalFileEntry[];
}

export interface LocalTrashResult {
  trashed: number;
  failed: Array<{ path: string; error: string }>;
}

export interface LocalWalkFile {
  localPath: string;
  /** Path relative to the drop root; "/"-separated and includes the root's own name. */
  relativePath: string;
  size: number;
}

export interface LocalWalkResult {
  files: LocalWalkFile[];
  emptyDirs: string[];
  totalBytes: number;
}

/** Which Termix backend a transfer talks to. */
export type LocalTransferOrigin = "local" | "remote";

export interface LocalTransferProgress {
  transferId: string;
  transferred: number;
  total?: number;
}
