import type { Readable, Writable } from "node:stream";
import type {
  PluginContext,
  PluginProtocolTarget,
} from "@termix-ssh/plugin-sdk/backend";

/** One row of a listing, in the shape the File Manager shows. */
export interface RemoteItem {
  name: string;
  type: "file" | "directory" | "link";
  size?: number;
  modified: string;
  modifiedTimestamp: number;
  permissions: string;
  owner: string;
  group: string;
  linkTarget?: string;
  path: string;
  executable: boolean;
}

/** A file system reached without SSH, like FTP, WebDAV or an SMB share. */
export interface RemoteFs {
  readonly closed: boolean;
  close(): void;
  /** The folder to open first. */
  home(): Promise<string>;
  list(dir: string): Promise<RemoteItem[]>;
  /** Writes the file into sink from byte start, and resolves when done. */
  downloadTo(sink: Writable, path: string, start: number): Promise<void>;
  /** Size in bytes, or 0 when the server won't say. */
  size(path: string): Promise<number>;
  uploadFrom(source: Readable, path: string): Promise<void>;
  /** Creates the folder and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Folders are removed with everything in them. */
  remove(path: string, isDirectory: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** A cheap call that fails when the connection is gone. */
  ping(): Promise<void>;
}

/** Everything the shared routes need to know about one protocol. */
export interface RemoteProtocol<S = unknown> {
  /** Route prefix and the id in manifest contributes.protocols. */
  id: string;
  /** Shown in messages, like "FTP connection not established". */
  label: string;
  readSettings(ctx: PluginContext, hostId: number): Promise<S>;
  port(settings: S): number;
  connect(target: PluginProtocolTarget, settings: S): Promise<RemoteFs>;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
