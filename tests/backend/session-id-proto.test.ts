import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import { registerFtpRoutes } from "../../src/backend/ftp-routes.js";
import { manifest } from "./helpers.js";

let server: http.Server;
let base: string;

const KEYS = ["isConnected", "timeout", "client", "userId"];

beforeAll(async () => {
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    sandbox: true,
    capabilities: manifest.capabilities,
  });
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  registerFtpRoutes(app, mock.ctx);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ftp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of KEYS) {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
});

describe("session ids that name Object.prototype", () => {
  it.each(["__proto__", "constructor", "toString"])(
    "keeps %j a missing session",
    async (sessionId) => {
      const query = await fetch(
        `${base}/listFiles?sessionId=${sessionId}&path=/`,
      );
      expect(query.status).toBe(400);
      for (const path of ["/keepalive", "/disconnect"]) {
        const body = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        expect(body.status).toBeLessThan(500);
      }
      for (const key of KEYS) {
        expect(Object.prototype.hasOwnProperty(key), key).toBe(false);
      }
    },
  );

  it("keeps the SSH session stores without a prototype", () => {
    const source = fs.readFileSync(
      new URL("../../src/backend/index.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /const sshSessions: Record<string, SSHSession> = Object\.create\(null\)/,
    );
    expect(source).toMatch(
      /pendingTOTPSessions[^=]*=\s*Object\.create\(null\)/,
    );
  });
});
