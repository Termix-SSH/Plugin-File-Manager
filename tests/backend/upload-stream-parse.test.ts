import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Express, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerFileContentRoutes } from "../../src/backend/content-routes";
import type { SSHSession } from "../../src/backend/session";

vi.mock("../../src/backend/session.js", () => ({
  getSessionSftp: vi.fn(),
  getLiveSessionSftp: vi.fn(),
  execChannel: vi.fn(),
  SessionLostError: class extends Error {},
}));

const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => uncaught.push(error);

afterEach(() => {
  process.off("uncaughtException", onUncaught);
  uncaught.length = 0;
});

function start(body: string) {
  const routes = new Map<string, (req: Request, res: Response) => void>();
  const app = {
    get: vi.fn(),
    post: (path: string, handler: (req: Request, res: Response) => void) =>
      routes.set(path, handler),
  } as unknown as Express;
  registerFileContentRoutes(app, {
    ctx: {
      currentActor: () => "user-1",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext,
    sshSessions: { s: { isConnected: true } as SSHSession },
    verifySessionOwnership: () => true,
  });
  const req = Object.assign(new PassThrough(), {
    query: {},
    headers: { "content-type": "multipart/form-data; boundary=b" },
    complete: true,
  });
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    headersSent: false,
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  });
  routes.get("/uploadFileStream")!(
    req as unknown as Request,
    res as unknown as Response,
  );
  req.end(body);
  return res;
}

describe("stream upload with a cut short body", () => {
  it("answers 400 and throws nothing", async () => {
    process.on("uncaughtException", onUncaught);
    const res = start(
      '--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\npartial',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uncaught).toEqual([]);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
