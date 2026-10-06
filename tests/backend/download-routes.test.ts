import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { Express, Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileDownloadRoutes } from "../../src/backend/download-routes.js";
import {
  ChannelOpenSerializer,
  type SSHSession,
} from "../../src/backend/session.js";

/**
 * `remote` is the channel a download opens for itself; `shared` is the
 * session's browsing channel, which a download must leave alone.
 */
function setup(
  remote: object,
  owned = true,
  { dedicatedFails = false }: { dedicatedFails?: boolean } = {},
) {
  const shared = source();
  const client = {
    sftp: vi.fn((cb) =>
      dedicatedFails
        ? cb(new Error("Channel open failure"), undefined)
        : cb(undefined, remote),
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const routes = new Map<
    string,
    (req: Request, res: Response) => Promise<unknown>
  >();
  registerFileDownloadRoutes(
    {
      post: (path, handler) => routes.set(path, handler),
    } as unknown as Express,
    {
      ctx: {
        currentActor: () => "user",
        log,
      } as unknown as PluginContext,
      sshSessions: {
        s: {
          isConnected: true,
          sftp: shared,
          client,
          channelOpener: new ChannelOpenSerializer(),
        } as unknown as SSHSession,
      },
      scheduleSessionCleanup: vi.fn(),
      verifySessionOwnership: () => owned,
    },
  );
  const headers = new Map<string, string>();
  const res = Object.assign(new PassThrough(), {
    headersSent: false,
    setHeader: (name: string, value: string) => headers.set(name, value),
    removeHeader: (name: string) => headers.delete(name),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  });
  const start = () =>
    routes.get("/downloadFileStream")!(
      { body: { sessionId: "s", path: "/file" } } as Request,
      res as unknown as Response,
    );
  return { res, start, headers, shared, client, log };
}

function source() {
  return Object.assign(new EventEmitter(), {
    stat: vi.fn((_path, cb) => cb(undefined, { size: 5, isFile: () => true })),
    open: vi.fn((_path, _flags, _mode, cb) =>
      cb(undefined, Buffer.from("handle")),
    ),
    read: vi.fn((_handle, buffer, offset, _length, _position, cb) => {
      Buffer.from("hello").copy(buffer, offset);
      cb(undefined, 5);
    }),
    close: vi.fn((_handle, cb) => cb()),
    end: vi.fn(),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stream download route", () => {
  it("streams the file content with its advertised length", async () => {
    const remote = source();
    const { res, start, headers } = setup(remote);
    await start();
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(headers.get("Content-Length")).toBe("5");
    expect(remote.close).toHaveBeenCalledOnce();
  });

  it("does not open a file after the HTTP client disconnected during stat", async () => {
    const remote = source();
    let finishStat!: () => void;
    remote.stat.mockImplementation((_path, cb) => {
      finishStat = () => cb(undefined, { size: 5, isFile: () => true });
    });
    const { res, start } = setup(remote);
    const started = start();
    await vi.waitFor(() => expect(remote.stat).toHaveBeenCalledOnce());
    res.destroy();
    finishStat();
    await started;
    expect(remote.open).not.toHaveBeenCalled();
    expect(remote.end).toHaveBeenCalledOnce();
  });

  it("closes the SFTP handle after HTTP disconnect during a read", async () => {
    const remote = source();
    let finishRead!: () => void;
    remote.read.mockImplementation(
      (_h, buffer, offset, length, position, cb) => {
        finishRead = () => cb(undefined, 0);
      },
    );
    const { res, start } = setup(remote);
    await start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    res.destroy();
    await once(res, "close");
    finishRead();
    await vi.waitFor(() => expect(remote.close).toHaveBeenCalledOnce());
    expect(remote.read).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(remote.end).toHaveBeenCalledOnce());
  });

  it("survives an error event on its own SFTP channel", async () => {
    const remote = source();
    const { res, start } = setup(remote);
    await start();
    expect(() =>
      remote.emit("error", new Error("channel reset")),
    ).not.toThrow();
    res.destroy();
  });

  it("downloads over its own SFTP channel and ends it afterwards", async () => {
    const remote = source();
    const { res, start, shared, client } = setup(remote);
    await start();
    for await (const _chunk of res);
    expect(client.sftp).toHaveBeenCalledOnce();
    expect(remote.stat).toHaveBeenCalledOnce();
    expect(shared.stat).not.toHaveBeenCalled();
    expect(shared.open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(remote.end).toHaveBeenCalledOnce());
    expect(shared.end).not.toHaveBeenCalled();
  });

  it("falls back to the session channel when its own cannot be opened", async () => {
    const remote = source();
    const { res, start, shared, log } = setup(remote, true, {
      dedicatedFails: true,
    });
    await start();
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(shared.stat).toHaveBeenCalledOnce();
    expect(shared.end).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Channel open failure"),
    );
  });

  it("ends its channel when the server does not answer the cancelled file's close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remote = source();
    let finishRead!: () => void;
    remote.read.mockImplementation((_h, _b, _o, _l, _p, cb) => {
      finishRead = () => cb(undefined, 0);
    });
    // Some servers only answer CLOSE after reading the rest of the file.
    remote.close.mockImplementation(() => {});
    const { res, start } = setup(remote);
    await start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    res.destroy();
    await once(res, "close");
    finishRead();
    await vi.waitFor(() => expect(remote.close).toHaveBeenCalledOnce());
    expect(remote.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(remote.end).toHaveBeenCalledOnce();
  });

  it("removes the file length before returning an early stream error as JSON", async () => {
    const remote = source();
    remote.open.mockImplementation((_p, _f, _m, cb) =>
      cb(new Error("permission denied"), undefined),
    );
    const { res, start, headers } = setup(remote);
    await start();
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(500));
    expect(headers.has("Content-Length")).toBe(false);
    expect(res.json).toHaveBeenCalledWith({
      error: "Download failed: permission denied",
    });
    res.destroy();
  });

  it("refuses another user's SSH session before reading a file", async () => {
    const remote = source();
    const { res, start } = setup(remote, false);
    await start();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(remote.stat).not.toHaveBeenCalled();
    res.destroy();
  });
});
