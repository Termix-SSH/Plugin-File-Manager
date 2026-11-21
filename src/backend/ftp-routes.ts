import type { Express } from "express";
import { Client as FtpClient, type FileInfo } from "basic-ftp";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { parseLsDateToTimestamp } from "./utils.js";
import { registerRemoteRoutes } from "./remote-fs/routes.js";
import {
  joinPath,
  type RemoteFs,
  type RemoteItem,
  type RemoteProtocol,
} from "./remote-fs/types.js";

export type FtpSecure = "none" | "explicit" | "implicit";

interface FtpSettings {
  port: number;
  secure: FtpSecure;
  allowSelfSigned: boolean;
}

function permissionsOf(info: FileInfo): string {
  const p = info.permissions;
  if (!p) return info.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
  const bit = (n: number) =>
    `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
  const kind = info.isDirectory ? "d" : info.isSymbolicLink ? "l" : "-";
  return `${kind}${bit(p.user)}${bit(p.group)}${bit(p.world)}`;
}

export function toItem(info: FileInfo, dir: string): RemoteItem {
  const type = info.isDirectory
    ? "directory"
    : info.isSymbolicLink
      ? "link"
      : "file";
  // Servers without MLSD (like vsftpd) only send the ls style date text.
  const mtime = info.modifiedAt
    ? Math.floor(info.modifiedAt.getTime() / 1000)
    : info.rawModifiedAt
      ? parseLsDateToTimestamp(info.rawModifiedAt)
      : 0;
  const permissions = permissionsOf(info);
  return {
    name: info.name,
    type,
    size: info.isDirectory ? undefined : info.size,
    modified: info.modifiedAt
      ? info.modifiedAt.toISOString()
      : (info.rawModifiedAt ?? ""),
    modifiedTimestamp: mtime,
    permissions,
    owner: info.user ?? "",
    group: info.group ?? "",
    linkTarget: info.link,
    path: joinPath(dir, info.name),
    executable: type === "file" && /x/.test(permissions),
  };
}

function ftpFs(client: FtpClient): RemoteFs {
  return {
    get closed() {
      return client.closed;
    },
    close: () => client.close(),
    home: () => client.pwd(),
    ping: async () => {
      await client.pwd();
    },
    list: async (dir) =>
      (await client.list(dir))
        .filter((i) => i.name !== "." && i.name !== "..")
        .map((i) => toItem(i, dir)),
    downloadTo: async (sink, path, start) => {
      await client.downloadTo(sink, path, start);
    },
    size: (path) => client.size(path),
    uploadFrom: async (source, path) => {
      await client.uploadFrom(source, path);
    },
    mkdir: async (path) => {
      const here = await client.pwd();
      try {
        await client.ensureDir(path);
      } finally {
        await client.cd(here);
      }
    },
    remove: async (path, isDirectory) => {
      if (isDirectory) await client.removeDir(path);
      else await client.remove(path);
    },
    rename: async (from, to) => {
      await client.rename(from, to);
    },
  };
}

export const ftpProtocol: RemoteProtocol<FtpSettings> = {
  id: "ftp",
  label: "FTP",
  async readSettings(ctx, hostId) {
    const port = await ctx.settings.getHost<number>(hostId, "ftpPort");
    const secure = await ctx.settings.getHost<string>(hostId, "ftpSecure");
    const self = await ctx.settings.getHost<boolean>(
      hostId,
      "ftpAllowSelfSigned",
    );
    return {
      port: Number(port) > 0 ? Number(port) : 21,
      secure: secure === "explicit" || secure === "implicit" ? secure : "none",
      allowSelfSigned: self === true,
    };
  },
  port: (settings) => settings.port,
  async connect(target, settings) {
    const login =
      target.auth.authType === "none"
        ? { username: "anonymous", password: "anonymous@" }
        : { username: target.auth.username, password: target.auth.password };
    const client = new FtpClient(30_000);
    try {
      await client.access({
        host: target.host.ip,
        port: settings.port,
        user: login.username || "anonymous",
        password: login.password,
        secure:
          settings.secure === "none"
            ? false
            : settings.secure === "implicit"
              ? "implicit"
              : true,
        secureOptions:
          settings.secure === "none"
            ? undefined
            : { rejectUnauthorized: !settings.allowSelfSigned },
      });
    } catch (error) {
      client.close();
      throw error;
    }
    return ftpFs(client);
  },
};

export function registerFtpRoutes(app: Express, ctx: PluginContext): void {
  registerRemoteRoutes(app, ctx, ftpProtocol);
}
