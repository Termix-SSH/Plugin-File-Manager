import { pipeline } from "node:stream/promises";
import smb2 from "node-smb2";
import { skipBytes } from "./webdav.js";
import {
  joinPath,
  type RemoteFs,
  type RemoteItem,
  type RemoteProtocol,
} from "./types.js";

export interface SmbSettings {
  port: number;
  share: string;
  domain: string;
}

type Client = InstanceType<typeof smb2.Client>;
type Session = Awaited<ReturnType<Client["authenticate"]>>;
type Tree = Awaited<ReturnType<Session["connectTree"]>>;
type Entry = Awaited<ReturnType<Tree["readDirectory"]>>[number];

const SHARE = /^[^\\/:*?"<>|\u0000-\u001f]{1,80}$/;

/** NT status codes worth a plain sentence. */
const STATUS: Record<number, string> = {
  0xc0000022: "permission denied",
  0xc0000034: "not found",
  0xc000003a: "the folder does not exist",
  0xc0000035: "something with that name is already there",
  0xc000006d: "the login was refused",
  0xc0000072: "the account is disabled",
  0xc00000cc: "the share does not exist",
  0xc0000101: "the folder is not empty",
  0xc0000043: "the file is in use",
  0xc000007f: "the share is out of space",
  0xc00000ba: "it is a folder",
};

/** node-smb2 rejects with its Response object, so make it a readable error. */
export function smbError(error: unknown, what: string): Error {
  if (error instanceof Error) return error;
  const status = (error as { header?: { status?: number } } | null)?.header
    ?.status;
  if (typeof status === "number") {
    const reason =
      STATUS[status] ?? `status 0x${status.toString(16).padStart(8, "0")}`;
    return Object.assign(new Error(`Could not ${what}: ${reason}`), {
      status,
    });
  }
  return new Error(`Could not ${what}`);
}

const statusOf = (error: unknown) =>
  (error as { status?: number }).status ??
  (error as { header?: { status?: number } } | null)?.header?.status;

/** Just the name: node-smb2 prefixes names with ./ */
export function entryName(filename: string): string {
  return filename.replace(/^\.\//, "").split("/").pop() ?? filename;
}

export function toItem(entry: Entry, dir: string): RemoteItem {
  const name = entryName(entry.filename);
  const isDirectory = entry.type === "Directory";
  const modified =
    entry.lastWriteTime instanceof Date &&
    !Number.isNaN(entry.lastWriteTime.getTime())
      ? entry.lastWriteTime
      : null;
  const readOnly = entry.fileAttributes?.includes("ReadOnly");
  return {
    name,
    type: isDirectory ? "directory" : "file",
    size: isDirectory ? undefined : Number(entry.fileSize),
    modified: modified ? modified.toISOString() : "",
    modifiedTimestamp: modified ? Math.floor(modified.getTime() / 1000) : 0,
    permissions: isDirectory
      ? "drwxr-xr-x"
      : readOnly
        ? "-r--r--r--"
        : "-rw-r--r--",
    owner: "",
    group: "",
    path: joinPath(dir, name),
    executable: false,
  };
}

export function smbFs(client: Client, session: Session, tree: Tree): RemoteFs {
  let closed = false;
  const guard = async <T>(what: string, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      throw smbError(error, what);
    }
  };

  const entries = async (dir: string) =>
    (await tree.readDirectory(dir)).filter((e) => {
      const name = entryName(e.filename);
      return name !== "." && name !== "..";
    });

  const find = async (path: string) => {
    const cut = path.lastIndexOf("/");
    const dir = cut <= 0 ? "/" : path.slice(0, cut);
    const name = path.slice(cut + 1);
    return (await entries(dir)).find((e) => entryName(e.filename) === name);
  };

  const removeTree = async (path: string): Promise<void> => {
    for (const entry of await entries(path)) {
      const child = joinPath(path, entryName(entry.filename));
      if (entry.type === "Directory") await removeTree(child);
      else await tree.removeFile(child);
    }
    await tree.removeDirectory(path);
  };

  return {
    get closed() {
      return closed || !client.connected;
    },
    close() {
      if (closed) return;
      closed = true;
      void tree
        .disconnect()
        .catch(() => {})
        .then(() => session.logoff())
        .catch(() => {})
        .then(() => client.close())
        .catch(() => {});
    },
    home: async () => "/",
    ping: () =>
      guard("reach the share", async () => {
        await tree.readDirectory("/");
      }),
    list: (dir) =>
      guard(`list ${dir}`, async () =>
        (await entries(dir)).map((e) => toItem(e, dir)),
      ),
    downloadTo: (sink, path, start) =>
      guard(`read ${path}`, async () => {
        const stream = await tree.createFileReadStream(path);
        // SMB reads start at the beginning, so skip to the offset.
        if (start > 0) await pipeline(stream, skipBytes(start), sink);
        else await pipeline(stream, sink);
      }),
    size: (path) =>
      guard(`read ${path}`, async () => {
        const entry = await find(path);
        return entry ? Number(entry.fileSize) : 0;
      }),
    uploadFrom: (source, path) =>
      guard(`write ${path}`, async () => {
        // Creating fails on an existing file, so replace it.
        if (await tree.exists(path)) await tree.removeFile(path);
        const sink = await tree.createFileWriteStream(path);
        await pipeline(source, sink);
      }),
    mkdir: (path) =>
      guard(`create ${path}`, async () => {
        let current = "";
        for (const part of path.split("/").filter(Boolean)) {
          current = joinPath(current || "/", part);
          try {
            await tree.createDirectory(current);
          } catch (error) {
            // Already there is fine for a parent.
            if (statusOf(error) !== 0xc0000035) throw error;
          }
        }
      }),
    remove: (path, isDirectory) =>
      guard(`delete ${path}`, async () => {
        if (isDirectory) await removeTree(path);
        else await tree.removeFile(path);
      }),
    rename: (from, to) =>
      guard(`rename ${from}`, async () => {
        const entry = await find(from);
        if (entry?.type === "Directory") await tree.renameDirectory(from, to);
        else await tree.renameFile(from, to);
      }),
  };
}

export const smbProtocol: RemoteProtocol<SmbSettings> = {
  id: "smb",
  label: "SMB",
  async readSettings(ctx, hostId) {
    const get = <T>(key: string) => ctx.settings.getHost<T>(hostId, key);
    const port = Number(await get<number>("smbPort"));
    return {
      port: port > 0 ? port : 445,
      share: String((await get<string>("smbShare")) ?? "").trim(),
      domain:
        String((await get<string>("smbDomain")) ?? "").trim() || "WORKGROUP",
    };
  },
  port: (settings) => settings.port,
  async connect(target, settings) {
    if (!SHARE.test(settings.share)) {
      throw new Error("Set the share name in the host's File Manager settings");
    }
    const client = new smb2.Client(target.host.ip, {
      port: settings.port,
      connectTimeout: 15_000,
      requestTimeout: 30_000,
    });
    // A dropped connection must not crash the plugin process.
    client.on("error", () => {});
    try {
      const anonymous = target.auth.authType === "none";
      const session = await client.authenticate({
        domain: settings.domain,
        username: anonymous ? "" : (target.auth.username ?? ""),
        password: anonymous ? "" : (target.auth.password ?? ""),
        forceNtlmVersion: "v2",
      });
      const tree = await session.connectTree(settings.share);
      return smbFs(client, session, tree);
    } catch (error) {
      void client.close().catch(() => {});
      throw smbError(error, "connect to the share");
    }
  },
};
