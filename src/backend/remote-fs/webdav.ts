import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type Writable } from "node:stream";
import {
  joinPath,
  parentOf,
  type RemoteFs,
  type RemoteItem,
  type RemoteProtocol,
} from "./types.js";

export interface WebdavSettings {
  port: number;
  https: boolean;
  /** Where the WebDAV root is on the server, like /remote.php/dav/files/me. */
  basePath: string;
  allowSelfSigned: boolean;
}

const TIMEOUT_MS = 30_000;

/** "/a b/c" -> "/a%20b/c", one segment at a time. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function cleanBase(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text === "/") return "";
  const withSlash = text.startsWith("/") ? text : `/${text}`;
  return withSlash.replace(/\/+$/, "");
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text of the first element with this local name, any namespace prefix. */
function tag(block: string, name: string): string | null {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    "i",
  );
  const found = re.exec(block);
  return found ? xmlText(found[1].trim()) : null;
}

function hasTag(block: string, name: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${name}[\\s/>]`, "i").test(block);
}

export interface DavEntry {
  /** The path below the WebDAV root, starting with /. */
  path: string;
  isDirectory: boolean;
  size: number | undefined;
  modified: Date | null;
}

/** Reads a PROPFIND multistatus answer. */
export function parseMultistatus(xml: string, basePath: string): DavEntry[] {
  const out: DavEntry[] = [];
  const responses = xml.match(
    /<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/gi,
  );
  for (const block of responses ?? []) {
    const href = tag(block, "href");
    if (!href) continue;
    let path = decode(href.replace(/^https?:\/\/[^/]+/i, ""));
    if (basePath && path.startsWith(basePath))
      path = path.slice(basePath.length);
    if (!path.startsWith("/")) path = `/${path}`;
    const isDirectory = hasTag(block, "collection");
    if (path.length > 1) path = path.replace(/\/+$/, "");
    const length = tag(block, "getcontentlength");
    const modified = tag(block, "getlastmodified");
    const date = modified ? new Date(modified) : null;
    out.push({
      path,
      isDirectory,
      size: !isDirectory && length !== null ? Number(length) : undefined,
      modified: date && !Number.isNaN(date.getTime()) ? date : null,
    });
  }
  return out;
}

export function toItem(entry: DavEntry): RemoteItem {
  const name = entry.path.split("/").pop() || entry.path;
  return {
    name,
    type: entry.isDirectory ? "directory" : "file",
    size: entry.size,
    modified: entry.modified ? entry.modified.toISOString() : "",
    modifiedTimestamp: entry.modified
      ? Math.floor(entry.modified.getTime() / 1000)
      : 0,
    permissions: entry.isDirectory ? "drwxr-xr-x" : "-rw-r--r--",
    owner: "",
    group: "",
    path: entry.path,
    executable: false,
  };
}

interface DavClient {
  request(
    method: string,
    path: string,
    options?: {
      headers?: Record<string, string>;
      body?: string | Readable;
      sink?: Writable;
      /** Bytes to drop when the server sent the whole file, not the range. */
      skip?: number;
    },
  ): Promise<{ status: number; text: string }>;
  /** The full URL of a path, for the Destination header. */
  url(path: string): string;
  close(): void;
  readonly closed: boolean;
}

function createClient(
  host: string,
  username: string,
  password: string,
  settings: WebdavSettings,
): DavClient {
  const lib = settings.https ? https : http;
  const agent = new lib.Agent({
    keepAlive: true,
    maxSockets: 4,
    ...(settings.https
      ? { rejectUnauthorized: !settings.allowSelfSigned }
      : {}),
  });
  const auth = username
    ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    : undefined;
  let closed = false;
  const hostname =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const origin = `${settings.https ? "https" : "http"}://${hostname}:${settings.port}`;

  return {
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      agent.destroy();
    },
    url: (path) => new URL(origin + settings.basePath + encodePath(path)).href,
    request(method, path, options = {}) {
      return new Promise((resolve, reject) => {
        const url = new URL(origin + settings.basePath + encodePath(path));
        const req = lib.request(
          url,
          {
            method,
            agent,
            timeout: TIMEOUT_MS,
            headers: {
              ...(auth ? { Authorization: auth } : {}),
              ...options.headers,
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (options.sink && status >= 200 && status < 300) {
              const skip = status === 200 ? (options.skip ?? 0) : 0;
              (skip > 0
                ? pipeline(res, skipBytes(skip), options.sink)
                : pipeline(res, options.sink)
              ).then(() => resolve({ status, text: "" }), reject);
              return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => {
              if (chunks.length < 4096) chunks.push(chunk);
            });
            res.on("end", () =>
              resolve({ status, text: Buffer.concat(chunks).toString("utf8") }),
            );
            res.on("error", reject);
          },
        );
        req.on("timeout", () =>
          req.destroy(new Error("The WebDAV server took too long")),
        );
        req.on("error", reject);
        const body = options.body;
        if (body === undefined) req.end();
        else if (typeof body === "string") req.end(body);
        else pipeline(body, req).catch(reject);
      });
    },
  };
}

/** Drops the first n bytes of a stream. */
export function skipBytes(n: number): Transform {
  let left = n;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (left <= 0) return done(null, chunk);
      if (chunk.length <= left) {
        left -= chunk.length;
        return done();
      }
      const rest = chunk.subarray(left);
      left = 0;
      done(null, rest);
    },
  });
}

function fail(status: number, what: string): Error {
  const reason =
    status === 401
      ? "the login was refused"
      : status === 403
        ? "permission denied"
        : status === 404
          ? "not found"
          : status === 405
            ? "the server does not allow it"
            : status === 409
              ? "the parent folder does not exist"
              : status === 412
                ? "something with that name is already there"
                : status === 507
                  ? "the server is out of space"
                  : `HTTP ${status}`;
  return new Error(`Could not ${what}: ${reason}`);
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>";

export function webdavFs(client: DavClient, basePath: string): RemoteFs {
  const propfind = async (path: string, depth: "0" | "1") => {
    const res = await client.request("PROPFIND", path, {
      headers: {
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: PROPFIND_BODY,
    });
    if (res.status !== 207) throw fail(res.status, `read ${path}`);
    return parseMultistatus(res.text, basePath);
  };

  const mkdirOne = async (path: string) => {
    const res = await client.request("MKCOL", path);
    // 405 means it is already there.
    if (res.status !== 201 && res.status !== 405) {
      throw fail(res.status, `create ${path}`);
    }
  };

  return {
    get closed() {
      return client.closed;
    },
    close: () => client.close(),
    home: async () => "/",
    ping: async () => {
      await propfind("/", "0");
    },
    list: async (dir) => {
      const self = dir.length > 1 ? dir.replace(/\/+$/, "") : "/";
      return (await propfind(self.endsWith("/") ? self : `${self}/`, "1"))
        .filter((entry) => entry.path !== self)
        .map(toItem);
    },
    downloadTo: async (sink, path, start) => {
      const res = await client.request("GET", path, {
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
        sink,
        skip: start,
      });
      if (res.status < 200 || res.status >= 300) {
        throw fail(res.status, `read ${path}`);
      }
    },
    size: async (path) => (await propfind(path, "0"))[0]?.size ?? 0,
    uploadFrom: async (source, path) => {
      const res = await client.request("PUT", path, {
        headers: { "Content-Type": "application/octet-stream" },
        body: source,
      });
      if (res.status < 200 || res.status >= 300) {
        throw fail(res.status, `write ${path}`);
      }
    },
    mkdir: async (path) => {
      const parts = path.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current = joinPath(current || "/", part);
        await mkdirOne(`${current}/`);
      }
    },
    remove: async (path, isDirectory) => {
      const res = await client.request(
        "DELETE",
        isDirectory ? `${path}/` : path,
      );
      if (res.status < 200 || res.status >= 300) {
        throw fail(res.status, `delete ${path}`);
      }
    },
    rename: async (from, to) => {
      const move = (source: string, target: string) =>
        client.request("MOVE", source, {
          headers: { Destination: client.url(target), Overwrite: "F" },
        });
      let res = await move(from, to);
      // Servers redirect a folder without its trailing slash.
      if (res.status === 301 || res.status === 308) {
        res = await move(`${from}/`, `${to}/`);
      }
      if (res.status !== 201 && res.status !== 204) {
        throw fail(res.status, `move ${from} to ${parentOf(to)}`);
      }
    },
  };
}

export const webdavProtocol: RemoteProtocol<WebdavSettings> = {
  id: "webdav",
  label: "WebDAV",
  async readSettings(ctx, hostId) {
    const get = <T>(key: string) => ctx.settings.getHost<T>(hostId, key);
    const secure = (await get<boolean>("webdavHttps")) !== false;
    const port = Number(await get<number>("webdavPort"));
    return {
      https: secure,
      port: port > 0 ? port : secure ? 443 : 80,
      basePath: cleanBase(await get<string>("webdavPath")),
      allowSelfSigned: (await get<boolean>("webdavAllowSelfSigned")) === true,
    };
  },
  port: (settings) => settings.port,
  async connect(target, settings) {
    const login =
      target.auth.authType === "none"
        ? { username: "", password: "" }
        : { username: target.auth.username, password: target.auth.password };
    const client = createClient(
      target.host.ip,
      login.username ?? "",
      login.password ?? "",
      settings,
    );
    const fs = webdavFs(client, settings.basePath);
    try {
      await fs.ping();
    } catch (error) {
      client.close();
      throw error;
    }
    return fs;
  },
};
