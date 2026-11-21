import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginProtocolTarget } from "@termix-ssh/plugin-sdk/backend";
import { registerRemoteRoutes } from "../../src/backend/remote-fs/routes.js";
import {
  cleanBase,
  encodePath,
  parseMultistatus,
  webdavProtocol,
} from "../../src/backend/remote-fs/webdav.js";
import { manifest } from "./helpers.js";

/** A small WebDAV server over a Map, enough for the routes. */
function fakeDav(base: string) {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(["/"]);
  const auth = `Basic ${Buffer.from("box:secret").toString("base64")}`;
  const local = (url: string) => {
    let path = decodeURIComponent(new URL(url, "http://x").pathname);
    if (!path.startsWith(base)) return null;
    path = path.slice(base.length) || "/";
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  };
  const href = (path: string, dir: boolean) =>
    `${base}${encodePath(path)}${dir && path !== "/" ? "/" : ""}`;
  const entry = (path: string) => {
    const dir = dirs.has(path);
    const size = files.get(path)?.length ?? 0;
    return (
      `<D:response><D:href>${href(path, dir)}</D:href><D:propstat><D:prop>` +
      `<D:resourcetype>${dir ? "<D:collection/>" : ""}</D:resourcetype>` +
      (dir ? "" : `<D:getcontentlength>${size}</D:getcontentlength>`) +
      "<D:getlastmodified>Fri, 20 Nov 2026 10:00:00 GMT</D:getlastmodified>" +
      "</D:prop></D:propstat></D:response>"
    );
  };
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== auth) {
      res.writeHead(401).end();
      return;
    }
    const path = local(req.url ?? "/");
    if (path === null) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      switch (req.method) {
        case "PROPFIND": {
          if (!dirs.has(path) && !files.has(path)) {
            res.writeHead(404).end();
            return;
          }
          const list = [path];
          if (req.headers.depth === "1" && dirs.has(path)) {
            for (const p of [...dirs, ...files.keys()]) {
              if (p !== path && parent(p) === path) list.push(p);
            }
          }
          res.writeHead(207, { "Content-Type": "application/xml" });
          res.end(
            `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${list.map(entry).join("")}</D:multistatus>`,
          );
          return;
        }
        case "GET": {
          const data = files.get(path);
          if (!data) {
            res.writeHead(404).end();
            return;
          }
          const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
          if (range) {
            res.writeHead(206).end(data.subarray(Number(range[1])));
          } else res.writeHead(200).end(data);
          return;
        }
        case "PUT":
          if (!dirs.has(parent(path))) {
            res.writeHead(409).end();
            return;
          }
          files.set(path, body);
          res.writeHead(201).end();
          return;
        case "MKCOL":
          if (dirs.has(path)) {
            res.writeHead(405).end();
            return;
          }
          dirs.add(path);
          res.writeHead(201).end();
          return;
        case "DELETE":
          for (const p of [...dirs, ...files.keys()]) {
            if (p === path || p.startsWith(`${path}/`)) {
              dirs.delete(p);
              files.delete(p);
            }
          }
          res.writeHead(204).end();
          return;
        case "MOVE": {
          const to = local(String(req.headers.destination));
          if (!to || dirs.has(to) || files.has(to)) {
            res.writeHead(412).end();
            return;
          }
          const data = files.get(path);
          if (data) {
            files.delete(path);
            files.set(to, data);
          }
          res.writeHead(201).end();
          return;
        }
        default:
          res.writeHead(405).end();
      }
    });
  });
  return { server, files, dirs };
}

function target(password: string, port: number): PluginProtocolTarget {
  return {
    host: {
      id: 7,
      name: "nas",
      ip: "127.0.0.1",
      port,
      ownerUserId: "user-1",
      jumpHosts: [],
    },
    shared: false,
    auth: { authType: "direct", username: "box", password, fields: {} },
  };
}

let dav: ReturnType<typeof fakeDav>;
let app: http.Server;
let base = "";

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

beforeAll(async () => {
  dav = fakeDav("/dav");
  await new Promise<void>((resolve) =>
    dav.server.listen(0, "127.0.0.1", resolve),
  );
  const davPort = (dav.server.address() as AddressInfo).port;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
    protocolTargets: {
      "7:webdav": target("secret", davPort),
      "8:webdav": target("wrong", davPort),
    },
  });
  for (const id of [7, 8]) {
    await mock.ctx.settings.setHost(id, "webdavPort", davPort);
    await mock.ctx.settings.setHost(id, "webdavHttps", false);
    await mock.ctx.settings.setHost(id, "webdavPath", "/dav/");
  }
  const express_ = express();
  express_.use(express.json());
  express_.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  registerRemoteRoutes(express_, mock.ctx, webdavProtocol);
  app = http.createServer(express_);
  await new Promise<void>((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/webdav`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => dav.server.close(() => resolve()));
});

describe("webdav parsing", () => {
  it("reads a multistatus with any namespace prefix and encoded names", () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://nas/dav/a%20b/</d:href>' +
      "<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>" +
      "<d:response><d:href>/dav/a%20b/f%C3%BC.txt</d:href><d:propstat><d:prop><d:resourcetype/>" +
      "<d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Fri, 20 Nov 2026 10:00:00 GMT</d:getlastmodified>" +
      "</d:prop></d:propstat></d:response></d:multistatus>";
    expect(parseMultistatus(xml, "/dav")).toEqual([
      { path: "/a b", isDirectory: true, size: undefined, modified: null },
      {
        path: "/a b/fü.txt",
        isDirectory: false,
        size: 12,
        modified: new Date("2026-11-20T10:00:00Z"),
      },
    ]);
  });

  it("cleans the base path", () => {
    expect(cleanBase("")).toBe("");
    expect(cleanBase("/")).toBe("");
    expect(cleanBase("remote.php/dav/")).toBe("/remote.php/dav");
    expect(encodePath("/a b/#c")).toBe("/a%20b/%23c");
  });
});

describe("webdav routes", () => {
  it("refuses a wrong password", async () => {
    const res = await call("POST", "/connect", { sessionId: "bad", hostId: 8 });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/login was refused/);
  });

  it("creates, lists, reads, renames and deletes", async () => {
    expect(
      (await call("POST", "/connect", { sessionId: "w1", hostId: 7 })).status,
    ).toBe(200);
    const folder = await call("POST", "/createFolder", {
      sessionId: "w1",
      path: "/",
      folderName: "docs",
    });
    expect(folder.status).toBe(200);
    expect(dav.dirs.has("/docs")).toBe(true);
    const created = await call("POST", "/createFile", {
      sessionId: "w1",
      path: "/docs",
      fileName: "a b.txt",
      content: "hello",
    });
    expect(created.status).toBe(200);
    const list = await call("GET", "/listFiles?sessionId=w1&path=/docs");
    expect(list.body.files).toEqual([
      expect.objectContaining({ name: "a b.txt", type: "file", size: 5 }),
    ]);
    const home = await call("GET", "/listFiles?sessionId=w1&path=.");
    expect(home.body.path).toBe("/");
    const read = await call(
      "GET",
      `/readFile?sessionId=w1&path=${encodeURIComponent("/docs/a b.txt")}`,
    );
    expect(read.body).toMatchObject({ content: "hello", encoding: "utf8" });
    const renamed = await call("PUT", "/renameItem", {
      sessionId: "w1",
      oldPath: "/docs/a b.txt",
      newName: "c.txt",
    });
    expect(renamed.status).toBe(200);
    expect([...dav.files.keys()]).toEqual(["/docs/c.txt"]);
    const removed = await call("DELETE", "/deleteItem", {
      sessionId: "w1",
      path: "/docs",
      isDirectory: true,
    });
    expect(removed.status).toBe(200);
    expect(dav.dirs.has("/docs")).toBe(false);
  });

  it("streams a download from an offset", async () => {
    dav.files.set("/big.bin", Buffer.from("0123456789"));
    await call("POST", "/connect", { sessionId: "w2", hostId: 7 });
    const response = await fetch(`${base}/downloadFileStream`, {
      method: "POST",
      headers: { "content-type": "application/json", range: "bytes=6-" },
      body: JSON.stringify({ sessionId: "w2", path: "/big.bin" }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-9/10");
    expect(await response.text()).toBe("6789");
  });

  it("keeps sessions to their owner", async () => {
    const res = await call("GET", "/listFiles?sessionId=nobody&path=/");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("WebDAV connection not established");
  });
});
