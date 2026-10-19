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

/** At or above the route's threshold a download gets its own channel. */
const BIG = 8 * 1024 * 1024;

/**
 * Three channels: `shared` is the session's browsing channel (never used by
 * downloads); `bulk` is the per-session download channel small files share
 * (the first channel the client opens); `dedicated` is what a big file opens
 * for itself (every later channel).
 */
function setup(
  owned = true,
  {
    size = 5,
    dedicatedFails = false,
    bulkFails = false,
  }: { size?: number; dedicatedFails?: boolean; bulkFails?: boolean } = {},
) {
  const shared = source(size);
  const bulk = source(size);
  const dedicated = source(size);
  let opened = 0;
  const client = {
    sftp: vi.fn((cb) => {
      opened++;
      if (opened === 1)
        return bulkFails
          ? cb(new Error("Channel open failure"), undefined)
          : cb(undefined, bulk);
      return dedicatedFails
        ? cb(new Error("Channel open failure"), undefined)
        : cb(undefined, dedicated);
    }),
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
  const makeRes = () =>
    Object.assign(new PassThrough(), {
      headersSent: false,
      setHeader: (name: string, value: string) => headers.set(name, value),
      removeHeader: (name: string) => headers.delete(name),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });
  const res = makeRes();
  const start = (target = res) =>
    routes.get("/downloadFileStream")!(
      { body: { sessionId: "s", path: "/file" } } as Request,
      target as unknown as Response,
    );
  return { res, makeRes, start, headers, shared, bulk, dedicated, client, log };
}

function source(size = 5) {
  return Object.assign(new EventEmitter(), {
    stat: vi.fn((_path, cb) => cb(undefined, { size, isFile: () => true })),
    open: vi.fn((_path, _flags, _mode, cb) =>
      cb(undefined, Buffer.from("handle")),
    ),
    read: vi.fn((_handle, buffer, offset, length, position, cb) => {
      const bytes = Math.min(length, size - position);
      for (let i = 0; i < bytes; i++)
        buffer[offset + i] = "hello".charCodeAt((position + i) % 5);
      cb(undefined, bytes);
    }),
    close: vi.fn((_handle, cb) => cb()),
    end: vi.fn(),
  });
}

/** Reads of `channel` stay unanswered until the returned function is called. */
function holdReads(channel: ReturnType<typeof source>) {
  const pending: Array<() => void> = [];
  channel.read.mockImplementation((_h, _b, _o, _l, _p, cb) => {
    pending.push(() => cb(undefined, 0));
  });
  return () => pending.forEach((reply) => reply());
}

async function drain(res: PassThrough) {
  let received = 0;
  for await (const chunk of res) received += chunk.length;
  return received;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stream download route", () => {
  it("streams a small file over the shared download channel, not browsing's", async () => {
    const { res, start, headers, shared, bulk, dedicated, client } = setup();
    await start();
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(headers.get("Content-Length")).toBe("5");
    expect(client.sftp).toHaveBeenCalledOnce();
    expect(bulk.close).toHaveBeenCalledOnce();
    expect(bulk.end).not.toHaveBeenCalled();
    expect(dedicated.stat).not.toHaveBeenCalled();
    expect(shared.stat).not.toHaveBeenCalled();
    expect(shared.open).not.toHaveBeenCalled();
  });

  it("reuses one download channel for several small files", async () => {
    const { res, makeRes, start, client, bulk } = setup();
    const second = makeRes();
    await start();
    await start(second);
    expect(await drain(res)).toBe(5);
    expect(await drain(second)).toBe(5);
    expect(client.sftp).toHaveBeenCalledOnce();
    expect(bulk.open).toHaveBeenCalledTimes(2);
    expect(bulk.end).not.toHaveBeenCalled();
  });

  it("keeps the shared channel and closes the handle when a small download is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { res, start, bulk, shared, client } = setup();
    const finishRead = holdReads(bulk);
    await start();
    await vi.waitFor(() => expect(bulk.read).toHaveBeenCalled());
    res.destroy();
    await once(res, "close");
    finishRead();
    await vi.waitFor(() => expect(bulk.close).toHaveBeenCalledOnce());
    vi.advanceTimersByTime(2000);
    expect(bulk.end).not.toHaveBeenCalled();
    expect(shared.end).not.toHaveBeenCalled();
    expect(client.sftp).toHaveBeenCalledOnce();
  });

  it("retires the shared channel when a cancelled small file's close is never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { res, makeRes, start, bulk, shared, client } = setup();
    const finishRead = holdReads(bulk);
    // Some servers only answer CLOSE after reading the rest of the file.
    bulk.close.mockImplementation(() => {});
    await start();
    await vi.waitFor(() => expect(bulk.read).toHaveBeenCalled());
    res.destroy();
    await once(res, "close");
    finishRead();
    await vi.waitFor(() => expect(bulk.close).toHaveBeenCalledOnce());
    expect(bulk.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(bulk.end).toHaveBeenCalledOnce();
    expect(shared.end).not.toHaveBeenCalled();
    // The next download gets a fresh channel instead of the jammed one.
    const next = makeRes();
    await start(next);
    expect(await drain(next)).toBe(5);
    expect(client.sftp).toHaveBeenCalledTimes(2);
  });

  it("a late retirement timer does not drop a newer shared channel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { res, makeRes, start, bulk, client } = setup();
    const finishRead = holdReads(bulk);
    bulk.close.mockImplementation(() => {});
    const second = makeRes();
    await start();
    await start(second);
    await vi.waitFor(() => expect(bulk.read).toHaveBeenCalled());
    // First cancellation: its timer retires channel 1.
    res.destroy();
    await once(res, "close");
    vi.advanceTimersByTime(1000);
    // Second cancellation, 1 s later, so its timer fires after a replacement.
    second.destroy();
    await once(second, "close");
    finishRead();
    await vi.waitFor(() => expect(bulk.close).toHaveBeenCalledTimes(2));
    vi.advanceTimersByTime(1000);
    expect(bulk.end).toHaveBeenCalledOnce();
    // A new download opens channel 2 and caches it.
    const third = makeRes();
    await start(third);
    expect(client.sftp).toHaveBeenCalledTimes(2);
    // Channel 1's second timer fires now; it must not uncache channel 2.
    vi.advanceTimersByTime(2000);
    const fourth = makeRes();
    await start(fourth);
    expect(client.sftp).toHaveBeenCalledTimes(2);
    third.destroy();
    fourth.destroy();
  });

  it("does not open a file or a dedicated channel after the client left during stat", async () => {
    const { res, start, bulk, dedicated, client } = setup(true, { size: BIG });
    let finishStat!: () => void;
    bulk.stat.mockImplementation((_path, cb) => {
      finishStat = () => cb(undefined, { size: BIG, isFile: () => true });
    });
    const started = start();
    await vi.waitFor(() => expect(bulk.stat).toHaveBeenCalledOnce());
    res.destroy();
    finishStat();
    await started;
    expect(bulk.open).not.toHaveBeenCalled();
    expect(dedicated.open).not.toHaveBeenCalled();
    expect(client.sftp).toHaveBeenCalledOnce();
  });

  it("uses the shared channel just below the threshold and a dedicated one at it", async () => {
    const below = setup(true, { size: BIG - 1 });
    await below.start();
    await drain(below.res);
    expect(below.client.sftp).toHaveBeenCalledOnce();
    expect(below.dedicated.open).not.toHaveBeenCalled();

    const at = setup(true, { size: BIG });
    await at.start();
    await drain(at.res);
    expect(at.client.sftp).toHaveBeenCalledTimes(2);
    expect(at.dedicated.open).toHaveBeenCalledOnce();
    expect(at.bulk.open).not.toHaveBeenCalled();
  });

  it("closes the dedicated handle after disconnect during a big read", async () => {
    const { res, start, dedicated } = setup(true, { size: BIG });
    const finishRead = holdReads(dedicated);
    await start();
    await vi.waitFor(() => expect(dedicated.read).toHaveBeenCalled());
    res.destroy();
    await once(res, "close");
    finishRead();
    await vi.waitFor(() => expect(dedicated.close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(dedicated.end).toHaveBeenCalledOnce());
  });

  it("survives an error event on a download channel", async () => {
    const { res, start, dedicated, bulk } = setup(true, { size: BIG });
    await start();
    expect(() =>
      dedicated.emit("error", new Error("channel reset")),
    ).not.toThrow();
    expect(() => bulk.emit("error", new Error("channel reset"))).not.toThrow();
    res.destroy();
  });

  it("downloads a big file over its own channel and ends only that channel", async () => {
    const { res, start, shared, bulk, dedicated, client } = setup(true, {
      size: BIG,
    });
    await start();
    expect(await drain(res)).toBe(BIG);
    expect(client.sftp).toHaveBeenCalledTimes(2);
    expect(dedicated.open).toHaveBeenCalledOnce();
    expect(bulk.open).not.toHaveBeenCalled();
    expect(shared.stat).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(dedicated.end).toHaveBeenCalledOnce());
    expect(bulk.end).not.toHaveBeenCalled();
  });

  it("falls back to the shared download channel when a big file's own cannot be opened", async () => {
    const { res, start, bulk, log } = setup(true, {
      dedicatedFails: true,
      size: BIG,
    });
    await start();
    expect(await drain(res)).toBe(BIG);
    expect(bulk.open).toHaveBeenCalledOnce();
    expect(bulk.end).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Channel open failure"),
    );
  });

  it("falls back to the session channel when no download channel can be opened", async () => {
    const { res, start, shared, log } = setup(true, { bulkFails: true });
    await start();
    expect(await drain(res)).toBe(5);
    expect(shared.open).toHaveBeenCalledOnce();
    expect(shared.end).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Channel open failure"),
    );
  });

  it("ends a big file's channel when the server does not answer the cancelled file's close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { res, start, bulk, dedicated } = setup(true, { size: BIG });
    const finishRead = holdReads(dedicated);
    dedicated.close.mockImplementation(() => {});
    await start();
    await vi.waitFor(() => expect(dedicated.read).toHaveBeenCalled());
    res.destroy();
    await once(res, "close");
    finishRead();
    await vi.waitFor(() => expect(dedicated.close).toHaveBeenCalledOnce());
    expect(dedicated.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(dedicated.end).toHaveBeenCalledOnce();
    expect(bulk.end).not.toHaveBeenCalled();
  });

  it("removes the file length before returning an early stream error as JSON, keeping the channel", async () => {
    const { res, start, headers, bulk } = setup();
    bulk.open.mockImplementation((_p, _f, _m, cb) =>
      cb(new Error("permission denied"), undefined),
    );
    await start();
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(500));
    expect(headers.has("Content-Length")).toBe(false);
    expect(res.json).toHaveBeenCalledWith({
      error: "Download failed: permission denied",
    });
    expect(bulk.end).not.toHaveBeenCalled();
    res.destroy();
  });

  it("refuses another user's SSH session before reading a file", async () => {
    const { res, start, bulk, client } = setup(false);
    await start();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(bulk.stat).not.toHaveBeenCalled();
    expect(client.sftp).not.toHaveBeenCalled();
    res.destroy();
  });
});
