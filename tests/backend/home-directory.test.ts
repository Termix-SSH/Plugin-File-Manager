import { EventEmitter } from "node:events";
import type { Express, Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFileListingRoutes } from "../../src/backend/list-routes.js";
import {
  execChannel,
  getSessionSftp,
  type SSHSession,
} from "../../src/backend/session.js";
import { resolveHomeDirectory } from "../../src/backend/home-directory.js";

vi.mock("../../src/backend/session.js", () => ({
  getSessionSftp: vi.fn(),
  execChannel: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

function setup(home: string, owned = true) {
  const sftp = {
    realpath: vi.fn((_path, done) => done(null, home)),
    opendir: vi.fn((_path, done) => done(null, Buffer.from("directory"))),
    readdir: vi.fn((_handle, _options, done) =>
      done(Object.assign(new Error("EOF"), { code: 1 })),
    ),
    close: vi.fn((_handle, done) => done(null)),
  };
  vi.mocked(getSessionSftp).mockResolvedValue(sftp as never);
  let handler!: (req: Request, res: Response) => Promise<unknown>;
  registerFileListingRoutes(
    {
      get: (_path, cb) => {
        handler = cb;
      },
    } as Express,
    {
      ctx: {
        currentActor: () => "user",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as PluginContext,
      sshSessions: {
        s: { isConnected: true, activeOperations: 0 } as SSHSession,
      },
      verifySessionOwnership: () => owned,
    },
  );
  const json = vi.fn();
  const res = { on: vi.fn(), status: vi.fn().mockReturnThis(), json };
  return {
    sftp,
    res,
    json,
    list: (path?: string, response = res) =>
      handler(
        { query: { sessionId: "s", path } } as unknown as Request,
        response as unknown as Response,
      ),
  };
}

describe("remote login directory", () => {
  it.each(["/root", "/srv/users/alice", "/"])(
    "lists the actual SFTP directory %s",
    async (home) => {
      const { sftp, res, json, list } = setup(home);
      await list(".");
      await vi.waitFor(() =>
        expect(json).toHaveBeenCalledWith({ files: [], path: home }),
      );
      expect(sftp.realpath).toHaveBeenCalledWith(".", expect.any(Function));
      expect(sftp.opendir).toHaveBeenCalledWith(home, expect.any(Function));
      expect(execChannel).not.toHaveBeenCalled();
    },
  );
  it("preserves an explicit root instead of replacing it with home", async () => {
    const { sftp, res, json, list } = setup("/home/alice");
    await list("/");
    await vi.waitFor(() =>
      expect(json).toHaveBeenCalledWith({ files: [], path: "/" }),
    );
    expect(sftp.realpath).not.toHaveBeenCalled();
  });
  it("shares one listing between concurrent requests for the same path", async () => {
    const { sftp, res, json, list } = setup("/home/alice");
    const second = { ...res, json: vi.fn() };
    await Promise.all([list("/data"), list("/data", second)]);
    expect(sftp.opendir).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledExactlyOnceWith({ files: [], path: "/data" });
    expect(second.json).toHaveBeenCalledExactlyOnceWith({
      files: [],
      path: "/data",
    });
  });
  it("checks ownership before discovering the home directory", async () => {
    // placeholder-anchor
    const { res, list } = setup("/home/alice", false);
    await list(".");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(getSessionSftp).not.toHaveBeenCalled();
  });
  it("uses the existing shell fallback when a handle read fails", async () => {
    const { sftp, json, list } = setup("/home/alice");
    sftp.readdir.mockImplementation((_handle, _options, done) =>
      done(new Error("read failed")),
    );
    vi.mocked(execChannel).mockImplementation((_session, command, done) => {
      expect(command).toBe("command ls -la --color=never '/data'");
      done(new Error("fallback reached"), undefined as never);
    });
    await list("/data");
    await vi.waitFor(() =>
      expect(json).toHaveBeenCalledWith({ error: "fallback reached" }),
    );
    expect(execChannel).toHaveBeenCalledTimes(1);
    expect(sftp.close).toHaveBeenCalledTimes(1);
  });
  it("falls back to the shell login directory when SFTP is unavailable", async () => {
    vi.mocked(getSessionSftp).mockRejectedValue(new Error("SFTP unavailable"));
    vi.mocked(execChannel).mockImplementation((_session, command, done) => {
      expect(command).toBe("pwd -P");
      const stream = new EventEmitter();
      done(undefined as never, stream as never);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from("/srv/alice\n"));
        stream.emit("close", 0);
      });
    });
    await expect(resolveHomeDirectory({} as SSHSession)).resolves.toBe(
      "/srv/alice",
    );
  });
});
