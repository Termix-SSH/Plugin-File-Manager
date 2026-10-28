import { EventEmitter } from "node:events";
import type { Express, Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFileListingRoutes } from "../../src/backend/list-routes.js";
import { readDirectory } from "../../src/backend/read-directory.js";
import { resolveHomeDirectory } from "../../src/backend/home-directory.js";
import {
  execChannel,
  getSessionSftp,
  type SSHSession,
} from "../../src/backend/session.js";

vi.mock("../../src/backend/read-directory.js", () => ({
  readDirectory: vi.fn(),
}));
vi.mock("../../src/backend/home-directory.js", () => ({
  resolveHomeDirectory: vi.fn(),
}));
vi.mock("../../src/backend/session.js", () => ({
  getSessionSftp: vi.fn(),
  execChannel: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSessionSftp).mockResolvedValue({} as never);
  vi.mocked(resolveHomeDirectory).mockResolvedValue("/home/user");
});

const session = () =>
  ({ isConnected: true, activeOperations: 0 }) as SSHSession;

function setup(sshSessions = { s: session() }) {
  let actor = "user";
  let handler!: (req: Request, res: Response) => Promise<unknown>;
  const verifySessionOwnership = vi.fn(() => true);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  registerFileListingRoutes(
    {
      get: (_path, cb) => {
        handler = cb;
      },
    } as Express,
    {
      ctx: {
        currentActor: () => actor,
        log,
      } as unknown as PluginContext,
      sshSessions,
      verifySessionOwnership,
    },
  );
  return {
    sshSessions,
    log,
    verifySessionOwnership,
    setActor: (next: string) => {
      actor = next;
    },
    request(
      path = "/data",
      force?: unknown,
      query: { epoch?: unknown; prefetch?: unknown } = {},
    ) {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        status: vi.fn(function (code: number) {
          this.statusCode = code;
          return this;
        }),
        json: vi.fn(function () {
          this.headersSent = true;
          this.writableEnded = true;
          return this;
        }),
      });
      const done = handler(
        {
          query: { sessionId: "s", path, force, ...query },
        } as unknown as Request,
        res as unknown as Response,
      );
      return { res, done };
    },
  };
}

const complete = (index: number, error: Error | null = null) => {
  vi.mocked(readDirectory).mock.calls[index][2](error, []);
};
const reads = async (count: number) => {
  await vi.waitFor(() => expect(readDirectory).toHaveBeenCalledTimes(count));
};

describe("list request sharing", () => {
  it("isolates epochs while sharing requests in the same epoch", async () => {
    const { request, sshSessions } = setup();
    const old = request("/data", undefined, { epoch: "1" });
    const fresh = request("/data", undefined, { epoch: "2" });
    const waiter = request("/data", undefined, { epoch: "2" });
    await reads(2);
    complete(1);
    await Promise.all([fresh.done, waiter.done]);
    expect(old.res.json).not.toHaveBeenCalled();
    complete(0);
    await old.done;
    expect(sshSessions.s.activeOperations).toBe(0);
  });

  it("times out a hung read so joined requests are released", async () => {
    vi.useFakeTimers();
    try {
      const { request, sshSessions } = setup();
      const first = request("/data");
      const joined = request("/data");
      await reads(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([first.done, joined.done]);
      expect(first.res.status).toHaveBeenCalledWith(504);
      expect(joined.res.status).toHaveBeenCalledWith(504);
      expect(sshSessions.s.activeOperations).toBe(0);
      complete(0);
      expect(sshSessions.s.activeOperations).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, "", "-1", "1.5", "1e2", " 1", "1\n", true, 1, ["1"], {}])(
    "treats invalid or missing epoch %j as zero",
    async (epoch) => {
      const { request } = setup();
      const first = request("/data", undefined, { epoch: "0" });
      const second = request("/data", undefined, { epoch });
      await reads(1);
      complete(0);
      await Promise.all([first.done, second.done]);
      expect(second.res.json).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    "isolates speculative and navigation reads (prefetch first: %s)",
    async (prefetchFirst) => {
      const { request, sshSessions } = setup();
      sshSessions.s.sudoPassword = "stored-password";
      const first = request("/data", undefined, {
        prefetch: prefetchFirst ? "true" : undefined,
      });
      const second = request("/data", undefined, {
        prefetch: prefetchFirst ? undefined : "true",
      });
      const speculative = prefetchFirst ? first : second;
      const navigation = prefetchFirst ? second : first;
      await reads(2);
      complete(
        prefetchFirst ? 0 : 1,
        Object.assign(new Error("Permission denied"), { code: 3 }),
      );
      await speculative.done;
      expect(speculative.res.statusCode).toBe(403);
      expect(speculative.res.json).toHaveBeenCalledExactlyOnceWith({
        needsSudo: true,
        prefetchSkippedSudo: true,
        path: "/data",
      });
      expect(execChannel).not.toHaveBeenCalled();
      expect(navigation.res.json).not.toHaveBeenCalled();
      complete(prefetchFirst ? 1 : 0);
      await navigation.done;
      expect(navigation.res.statusCode).toBe(200);
      expect(sshSessions.s.activeOperations).toBe(0);
      expect(sshSessions.s.sudoPassword).toBe("stored-password");
    },
  );

  it.each(["false", "TRUE", true, ["true"]])(
    "only the exact string true marks prefetch (%j is navigation)",
    async (prefetch) => {
      const { request } = setup();
      const first = request();
      const second = request("/data", undefined, { prefetch });
      await reads(1);
      complete(0);
      await Promise.all([first.done, second.done]);
      expect(second.res.json).toHaveBeenCalledTimes(1);
    },
  );

  it("shares prefetch reads and skips sudo after shell permission denial too", async () => {
    const { request, sshSessions } = setup();
    sshSessions.s.sudoPassword = "stored-password";
    const first = request("/data", undefined, { prefetch: "true" });
    const waiter = request("/data", undefined, { prefetch: "true" });
    const stream = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      write: vi.fn(),
    });
    vi.mocked(execChannel).mockImplementation((_session, _command, done) => {
      done(null, stream as never);
    });
    await reads(1);
    complete(0, new Error("SFTP unavailable"));
    stream.stderr.emit("data", Buffer.from("Permission denied"));
    stream.emit("close", 1);
    await Promise.all([first.done, waiter.done]);
    expect(execChannel).toHaveBeenCalledExactlyOnceWith(
      sshSessions.s,
      "command ls -la --color=never '/data'",
      expect.any(Function),
    );
    expect(stream.write).not.toHaveBeenCalled();
    for (const { res } of [first, waiter]) {
      expect(res.statusCode).toBe(403);
      expect(res.json).toHaveBeenCalledExactlyOnceWith({
        needsSudo: true,
        prefetchSkippedSudo: true,
        path: "/data",
      });
    }
    expect(sshSessions.s.activeOperations).toBe(0);
  });

  it("retains original info events without paths or per-listing timing", async () => {
    const { request, log } = setup();
    const listing = request("/private/path");
    await reads(1);
    complete(0);
    await listing.done;
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      "Opening SFTP channel for listFiles: s",
    );
  });

  it.each(["timeout", "resolved"])(
    "waits up to 5000ms for symlink targets (%s)",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const { request, sshSessions } = setup();
        const readlink = vi.fn();
        vi.mocked(getSessionSftp).mockResolvedValue({ readlink } as never);
        const listing = request();
        await Promise.resolve();
        vi.mocked(readDirectory).mock.calls[0][2](null, [
          {
            filename: "link",
            attrs: {
              mode: 0o120777,
              size: 1,
              mtime: 1,
              uid: 1,
              gid: 1,
              isDirectory: () => false,
              isSymbolicLink: () => true,
            },
          } as never,
        ]);
        await vi.advanceTimersByTimeAsync(kind === "timeout" ? 4999 : 1000);
        expect(listing.res.json).not.toHaveBeenCalled();
        if (kind === "timeout") await vi.advanceTimersByTimeAsync(1);
        else readlink.mock.calls[0][1](null, "/target");
        await listing.done;
        expect(listing.res.json).toHaveBeenCalledExactlyOnceWith({
          files: [
            expect.objectContaining({
              linkTarget: kind === "timeout" ? undefined : "/target",
            }),
          ],
          path: "/data",
        });
        readlink.mock.calls[0][1](null, "/late-target");
        await vi.advanceTimersByTimeAsync(5000);
        expect(listing.res.json).toHaveBeenCalledTimes(1);
        expect(sshSessions.s.activeOperations).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("shares concurrent reads, but never stores a settled result", async () => {
    const { request, sshSessions } = setup();
    const first = request();
    const second = request();
    await reads(1);
    expect(sshSessions.s.activeOperations).toBe(1);
    complete(0);
    await Promise.all([first.done, second.done]);
    for (const { res } of [first, second]) {
      expect(res.json).toHaveBeenCalledExactlyOnceWith({
        files: [],
        path: "/data",
      });
      expect(res.statusCode).toBe(200);
    }
    expect(sshSessions.s.activeOperations).toBe(0);
    const next = request();
    await reads(2);
    complete(1);
    await next.done;
  });

  it("keeps the real result for waiters after the first client disconnects", async () => {
    const { request, sshSessions } = setup();
    const first = request();
    const waiter = request();
    await reads(1);
    first.res.destroyed = true;
    first.res.emit("close");
    await Promise.resolve();
    expect(waiter.res.json).not.toHaveBeenCalled();
    const laterWaiter = request();
    vi.mocked(readDirectory).mock.calls[0][2](null, [
      {
        filename: "visible.txt",
        attrs: {
          mode: 0o100644,
          size: 7,
          mtime: 1,
          uid: 1,
          gid: 1,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        },
      } as never,
    ]);
    await Promise.all([first.done, waiter.done, laterWaiter.done]);
    expect(first.res.json).not.toHaveBeenCalled();
    for (const { res } of [waiter, laterWaiter]) {
      expect(res.statusCode).toBe(200);
      expect(res.json).toHaveBeenCalledExactlyOnceWith({
        files: [
          expect.objectContaining({
            name: "visible.txt",
            path: "/data/visible.txt",
          }),
        ],
        path: "/data",
      });
    }
    expect(readDirectory).toHaveBeenCalledTimes(1);
    expect(sshSessions.s.activeOperations).toBe(0);
  });

  it("does not write to a closed waiter or an already ended response", async () => {
    const { request } = setup();
    const first = request();
    const closed = request();
    const ended = request();
    closed.res.emit("close");
    ended.res.writableEnded = true;
    await reads(1);
    complete(0);
    await Promise.all([first.done, closed.done, ended.done]);
    expect(first.res.json).toHaveBeenCalledTimes(1);
    expect(closed.res.json).not.toHaveBeenCalled();
    expect(ended.res.json).not.toHaveBeenCalled();
  });

  it("isolates a replacement session under the same session id", async () => {
    const { request, sshSessions } = setup();
    const oldSession = sshSessions.s;
    const first = request();
    await reads(1);
    sshSessions.s = session();
    const second = request();
    await reads(2);
    complete(1);
    await second.done;
    expect(first.res.json).not.toHaveBeenCalled();
    complete(0);
    await first.done;
    expect(getSessionSftp).toHaveBeenNthCalledWith(1, oldSession);
    expect(getSessionSftp).toHaveBeenNthCalledWith(2, sshSessions.s);
  });

  it("isolates route registrations even with the same actual session", async () => {
    const sharedSessions = { s: session() };
    const first = setup(sharedSessions).request();
    const second = setup(sharedSessions).request();
    await reads(2);
    complete(0);
    complete(1);
    await Promise.all([first.done, second.done]);
  });

  it("isolates actors and exact paths without delimiter collisions", async () => {
    const { request, setActor, verifySessionOwnership } = setup();
    setActor("user:/a");
    const first = request("/data");
    setActor("user");
    const second = request("/a:/data");
    const third = request("/data");
    const fourth = request("/data/");
    await reads(4);
    expect(verifySessionOwnership).toHaveBeenCalledTimes(4);
    for (let index = 0; index < 4; index++) complete(index);
    await Promise.all([first.done, second.done, third.done, fourth.done]);
  });

  it.each(["ownership", "connection"])(
    "validates each waiter's %s before joining",
    async (kind) => {
      const { request, verifySessionOwnership, sshSessions } = setup();
      const first = request();
      await reads(1);
      if (kind === "ownership") verifySessionOwnership.mockReturnValue(false);
      else sshSessions.s.isConnected = false;
      const denied = request();
      await denied.done;
      expect(denied.res.statusCode).toBe(kind === "ownership" ? 403 : 400);
      expect(readDirectory).toHaveBeenCalledTimes(1);
      complete(0);
      await first.done;
    },
  );

  it.each(["ownership", "connection", "session"])(
    "rechecks %s after home resolution before joining",
    async (kind) => {
      const { request, verifySessionOwnership, sshSessions } = setup();
      const first = request("/home/user");
      await reads(1);
      let resolve!: (path: string) => void;
      vi.mocked(resolveHomeDirectory).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const waiter = request(".");
      if (kind === "ownership") verifySessionOwnership.mockReturnValue(false);
      else if (kind === "connection") sshSessions.s.isConnected = false;
      else sshSessions.s = session();
      resolve("/home/user");
      await waiter.done;
      expect(waiter.res.statusCode).toBe(kind === "ownership" ? 403 : 400);
      expect(readDirectory).toHaveBeenCalledTimes(1);
      complete(0);
      await first.done;
    },
  );

  it("shares home and explicit paths after resolution", async () => {
    const { request } = setup();
    const first = request("/home/user");
    const second = request(".");
    await reads(1);
    // Let home resolution finish before completing the shared listing.
    await Promise.resolve();
    complete(0);
    await Promise.all([first.done, second.done]);
    expect(readDirectory).toHaveBeenCalledTimes(1);
    expect(second.res.json).toHaveBeenCalledWith({
      files: [],
      path: "/home/user",
    });
  });

  it.each([true, false])(
    "force bypass never replaces or deletes normal pending work (force finishes first: %s)",
    async (forceFirst) => {
      const { request } = setup();
      const normal = request();
      const forced = request("/data", "true");
      const normalWaiter = request();
      await reads(2);
      if (forceFirst) {
        complete(1);
        await forced.done;
        expect(normal.res.json).not.toHaveBeenCalled();
        const laterWaiter = request();
        expect(getSessionSftp).toHaveBeenCalledTimes(2);
        complete(0);
        await Promise.all([normal.done, normalWaiter.done, laterWaiter.done]);
      } else {
        complete(0);
        await Promise.all([normal.done, normalWaiter.done]);
        const newer = request();
        await reads(3);
        complete(1);
        await forced.done;
        const newerWaiter = request();
        expect(getSessionSftp).toHaveBeenCalledTimes(3);
        complete(2);
        await Promise.all([newer.done, newerWaiter.done]);
      }
      expect(forced.res.json).toHaveBeenCalledTimes(1);
    },
  );

  it("only the exact string true forces a separate read", async () => {
    const { request } = setup();
    const requests = [
      request(),
      request("/data", "false"),
      request("/data", true),
      request("/data", ["true"]),
    ];
    await reads(1);
    complete(0);
    await Promise.all(requests.map(({ done }) => done));
  });

  it("isolates privilege changes and old settlement/close cannot delete newer work", async () => {
    const { request, sshSessions } = setup();
    const first = request();
    await reads(1);
    sshSessions.s.sudoPassword = "first-password";
    const second = request();
    await reads(2);
    sshSessions.s.sudoPassword = "replacement-password";
    const third = request();
    await reads(3);
    complete(0);
    complete(1);
    await Promise.all([first.done, second.done]);
    first.res.emit("close");
    second.res.emit("close");
    const waiter = request();
    expect(getSessionSftp).toHaveBeenCalledTimes(3);
    complete(2);
    await Promise.all([third.done, waiter.done]);
    expect(waiter.res.json).toHaveBeenCalledExactlyOnceWith({
      files: [],
      path: "/data",
    });
  });

  it("uses captured sudo credentials and does not clear newer credentials on old auth failure", async () => {
    const { request, sshSessions } = setup();
    sshSessions.s.sudoPassword = "captured-password";
    const first = request();
    const waiter = request();
    await reads(1);
    sshSessions.s.sudoPassword = "replacement-password";
    const streams: Array<
      EventEmitter & { stderr: EventEmitter; write: ReturnType<typeof vi.fn> }
    > = [];
    vi.mocked(execChannel).mockImplementation((_session, _command, done) => {
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        write: vi.fn(),
      });
      streams.push(stream);
      done(null, stream as never);
    });
    complete(0, new Error("Permission denied"));
    streams[0].stderr.emit("data", Buffer.from("Permission denied"));
    streams[0].emit("close", 1);
    expect(streams[1].write).toHaveBeenCalledExactlyOnceWith(
      "captured-password\n",
    );
    streams[1].emit("data", Buffer.from("Sorry, try again"));
    streams[1].emit("close", 1);
    await Promise.all([first.done, waiter.done]);
    expect(sshSessions.s.sudoPassword).toBe("replacement-password");
    expect(first.res.statusCode).toBe(403);
    expect(waiter.res.statusCode).toBe(403);
    expect(waiter.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ sudoFailed: true }),
    );
  });

  it("does not adopt sudo credentials enabled while an unprivileged listing is pending", async () => {
    const { request, sshSessions } = setup();
    const first = request();
    await reads(1);
    sshSessions.s.sudoPassword = "new-password";
    vi.mocked(execChannel).mockImplementation((_session, _command, done) => {
      const stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
      });
      done(null, stream as never);
      queueMicrotask(() => {
        stream.stderr.emit("data", Buffer.from("Permission denied"));
        stream.emit("close", 1);
      });
    });
    complete(0, new Error("Permission denied"));
    await first.done;
    expect(execChannel).toHaveBeenCalledTimes(1);
    expect(first.res.statusCode).toBe(403);
    expect(first.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ needsSudo: true }),
    );
  });

  it("settles a shared fallback error once and releases its pending entry", async () => {
    const { request, sshSessions } = setup();
    const first = request();
    const waiter = request();
    await reads(1);
    vi.mocked(execChannel).mockImplementation((_session, _command, done) => {
      done(new Error("fallback failed"), undefined as never);
    });
    complete(0, new Error("SFTP failed"));
    await Promise.all([first.done, waiter.done]);
    for (const { res } of [first, waiter]) {
      expect(res.statusCode).toBe(500);
      expect(res.json).toHaveBeenCalledExactlyOnceWith({
        error: "fallback failed",
      });
    }
    expect(sshSessions.s.activeOperations).toBe(0);
    const next = request();
    await reads(2);
    complete(1);
    await next.done;
  });
});
