import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import FtpSrv from "ftp-srv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginProtocolTarget } from "@termix-ssh/plugin-sdk/backend";
import { registerFtpRoutes } from "../../src/backend/ftp-routes.js";
import { manifest } from "./helpers.js";

const FTP_PORT = 2121;
let root: string;
let ftp: FtpSrv;
let server: http.Server;
let base: string;
let actor: string | undefined = "user-1";

function target(password: string): PluginProtocolTarget {
  return {
    host: {
      id: 7,
      name: "console",
      ip: "127.0.0.1",
      port: 22,
      ownerUserId: "user-1",
      jumpHosts: [],
    },
    shared: false,
    auth: { authType: "direct", username: "box", password, fields: {} },
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  raw?: BodyInit,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json, text };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ftp-fm-"));
  writeFileSync(join(root, "hello.txt"), "hello world");
  ftp = new FtpSrv({
    url: `ftp://127.0.0.1:${FTP_PORT}`,
    pasv_url: "127.0.0.1",
    pasv_min: 2200,
    pasv_max: 2300,
    anonymous: false,
  });
  ftp.on("login", ({ username, password }, resolve, reject) => {
    if (username === "box" && password === "secret") {
      resolve({ root });
    } else {
      reject(new Error("bad login"));
    }
  });
  await ftp.listen();

  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    protocolTargets: { "7:ftp": target("secret"), "8:ftp": target("wrong") },
  });
  await mock.ctx.settings.setHost(7, "ftpPort", FTP_PORT);
  await mock.ctx.settings.setHost(8, "ftpPort", FTP_PORT);
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor(actor);
    next();
  });
  registerFtpRoutes(app, mock.ctx);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ftp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ftp.close();
  rmSync(root, { recursive: true, force: true });
});

describe("ftp routes", () => {
  it("rejects a wrong password", async () => {
    const res = await call("POST", "/connect", { sessionId: "bad", hostId: 8 });
    expect(res.status).toBe(502);
  });

  it("needs a connection before any file call", async () => {
    const res = await call("GET", "/listFiles?sessionId=none&path=/");
    expect(res.status).toBe(400);
  });

  it("connects, lists, reads, writes and removes", async () => {
    const connect = await call("POST", "/connect", {
      sessionId: "s1",
      hostId: 7,
    });
    expect(connect.status).toBe(200);

    const status = await call("GET", "/status?sessionId=s1");
    expect(status.body.connected).toBe(true);

    const list = await call("GET", "/listFiles?sessionId=s1&path=/");
    expect(list.status).toBe(200);
    expect(list.body.files.map((f: { name: string }) => f.name)).toContain(
      "hello.txt",
    );

    const read = await call("GET", "/readFile?sessionId=s1&path=/hello.txt");
    expect(read.body).toMatchObject({
      content: "hello world",
      encoding: "utf8",
    });

    const write = await call("POST", "/writeFile", {
      sessionId: "s1",
      path: "/note.txt",
      content: "saved",
    });
    expect(write.status).toBe(200);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("saved");

    const folder = await call("POST", "/createFolder", {
      sessionId: "s1",
      path: "/",
      folderName: "games",
    });
    expect(folder.status).toBe(200);
    expect(existsSync(join(root, "games"))).toBe(true);

    const rename = await call("PUT", "/renameItem", {
      sessionId: "s1",
      oldPath: "/note.txt",
      newName: "renamed.txt",
    });
    expect(rename.status).toBe(200);
    expect(existsSync(join(root, "renamed.txt"))).toBe(true);

    const move = await call("PUT", "/moveItem", {
      sessionId: "s1",
      oldPath: "/renamed.txt",
      newPath: "/games/renamed.txt",
    });
    expect(move.status).toBe(200);
    expect(existsSync(join(root, "games", "renamed.txt"))).toBe(true);

    const download = await call("POST", "/downloadFile", {
      sessionId: "s1",
      path: "/hello.txt",
    });
    expect(Buffer.from(download.body.content, "base64").toString()).toBe(
      "hello world",
    );

    const ranged = await call(
      "POST",
      "/downloadFileStream",
      { sessionId: "s1", path: "/hello.txt" },
      undefined,
      { range: "bytes=6-" },
    );
    expect(ranged.text).toBe("world");

    const upload = new FormData();
    upload.append("sessionId", "s1");
    upload.append("path", "/");
    upload.append("file", new Blob(["from browser"]), "up.txt");
    const sent = await call("POST", "/uploadFileStream", undefined, upload);
    expect(sent.status).toBe(200);
    expect(readFileSync(join(root, "up.txt"), "utf8")).toBe("from browser");

    const removed = await call("POST", "/deleteItems", {
      sessionId: "s1",
      paths: ["/up.txt", "/games"],
      directories: ["/games"],
    });
    expect(
      removed.body.results.every((r: { error?: string }) => !r.error),
    ).toBe(true);
    expect(existsSync(join(root, "up.txt"))).toBe(false);
    expect(existsSync(join(root, "games"))).toBe(false);

    await call("POST", "/disconnect", { sessionId: "s1" });
    const after = await call("GET", "/status?sessionId=s1");
    expect(after.body.connected).toBe(false);
  });

  it("keeps a session private to its owner", async () => {
    await call("POST", "/connect", { sessionId: "s2", hostId: 7 });
    actor = "user-2";
    const res = await call("GET", "/listFiles?sessionId=s2&path=/");
    expect(res.status).toBe(403);
    actor = "user-1";
    await call("POST", "/disconnect", { sessionId: "s2" });
  });
});
