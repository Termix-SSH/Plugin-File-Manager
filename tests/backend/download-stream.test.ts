import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { createDownloadStream } from "../../src/backend/download-stream.js";

function source(
  data: Buffer,
  options: { shortRead?: number; failAt?: number; maxReadLen?: number } = {},
) {
  let pending = 0;
  let peak = 0;
  const closedWithPending: number[] = [];
  const sftp = {
    _maxReadLen: options.maxReadLen,
    open: vi.fn((_path, _flags, _mode, cb) =>
      cb(undefined, Buffer.from("handle")),
    ),
    close: vi.fn((_handle, cb) => {
      closedWithPending.push(pending);
      cb();
    }),
    read: vi.fn((_handle, buffer, offset, length, position, cb) => {
      peak = Math.max(peak, ++pending);
      // Later file offsets can finish first.
      setTimeout(
        () => {
          pending--;
          if (position === options.failAt) return cb(new Error("read failed"));
          const bytes = Math.min(
            length,
            options.shortRead ?? length,
            Math.max(0, data.length - position),
          );
          if (bytes > 0) data.copy(buffer, offset, position, position + bytes);
          cb(undefined, bytes);
        },
        position === 0 ? 10 : 0,
      );
    }),
  };
  return {
    sftp: sftp as unknown as SFTPWrapper,
    close: sftp.close,
    read: sftp.read,
    peak: () => peak,
    closedWithPending,
  };
}

async function contents(stream: ReturnType<typeof createDownloadStream>) {
  const buffers: Buffer[] = [];
  for await (const buffer of stream) buffers.push(buffer);
  return Buffer.concat(buffers);
}

describe("SFTP download stream", () => {
  it("pipelines bounded reads and preserves bytes despite out-of-order replies", async () => {
    const data = Buffer.alloc(1024 * 1024 + 123);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13 + (i >>> 8)) % 256;
    const remote = source(data);
    const received = await contents(
      createDownloadStream(remote.sftp, "/file", data.length),
    );
    // toEqual walks a 1 MB buffer byte by byte, slow enough to time out
    // when every plugin suite runs at once.
    expect(received.length).toBe(data.length);
    expect(received.equals(data)).toBe(true);
    expect(remote.peak()).toBe(32);
    expect(remote.closedWithPending).toEqual([0]);
  });

  it("sizes reads to the negotiated SFTP read limit, capped at 256 KiB", async () => {
    const negotiated = source(Buffer.alloc(4 * 1024 * 1024), {
      maxReadLen: 254 * 1024,
    });
    await contents(
      createDownloadStream(negotiated.sftp, "/file", 4 * 1024 * 1024),
    );
    expect(negotiated.read.mock.calls[0][3]).toBe(254 * 1024);

    const oversized = source(Buffer.alloc(1024 * 1024), {
      maxReadLen: 4 * 1024 * 1024,
    });
    await contents(createDownloadStream(oversized.sftp, "/file", 1024 * 1024));
    expect(oversized.read.mock.calls[0][3]).toBe(256 * 1024);
  });

  it("refills the read window as soon as the oldest read completes", async () => {
    const remote = source(Buffer.alloc(4 * 1024 * 1024));
    const replies = new Map<number, () => void>();
    remote.read.mockImplementation(
      (_handle, _buffer, _offset, length, position, cb) => {
        replies.set(position, () => cb(undefined, length));
      },
    );
    const stream = createDownloadStream(remote.sftp, "/file", 4 * 1024 * 1024);
    stream.resume();
    await nextTurn();
    expect(remote.read).toHaveBeenCalledTimes(32);
    // Only the oldest read replies; the other 31 are still in flight.
    replies.get(0)!();
    await nextTurn();
    await nextTurn();
    expect(remote.read).toHaveBeenCalledTimes(33);
    const closed = once(stream, "close");
    stream.destroy();
    for (const [position, reply] of replies) if (position !== 0) reply();
    await closed;
    expect(remote.closedWithPending).toEqual([0]);
  });

  it("fills short server reads without losing or repeating bytes", async () => {
    const data = Buffer.from("short reads ".repeat(10000));
    const remote = source(data, { shortRead: 4096 });
    expect(
      await contents(createDownloadStream(remote.sftp, "/file", data.length)),
    ).toEqual(data);
    expect(remote.closedWithPending).toEqual([0]);
  });

  it("handles empty files without issuing reads", async () => {
    const remote = source(Buffer.alloc(0));
    expect(
      await contents(createDownloadStream(remote.sftp, "/empty", 0)),
    ).toEqual(Buffer.alloc(0));
    expect(remote.read).not.toHaveBeenCalled();
    expect(remote.close).toHaveBeenCalledOnce();
  });

  it("fails on premature EOF instead of returning uninitialized bytes", async () => {
    const remote = source(Buffer.from("truncated"));
    await expect(
      contents(createDownloadStream(remote.sftp, "/file", 100000)),
    ).rejects.toThrow("File ended");
    expect(remote.closedWithPending).toEqual([0]);
  });

  it("stops scheduling and settles outstanding reads before closing on a read failure", async () => {
    const remote = source(Buffer.alloc(4 * 1024 * 1024), { failAt: 32768 });
    await expect(
      contents(createDownloadStream(remote.sftp, "/file", 4 * 1024 * 1024)),
    ).rejects.toThrow("read failed");
    expect(remote.read).toHaveBeenCalledTimes(32);
    expect(remote.closedWithPending).toEqual([0]);
  });

  it("stops scheduling reads and closes the handle when destroyed mid-window", async () => {
    const remote = source(Buffer.alloc(1024 * 1024), { shortRead: 4096 });
    const replies: Array<() => void> = [];
    remote.read.mockImplementation(
      (_handle, _buffer, _offset, _length, _position, cb) => {
        replies.push(() => cb(undefined, 4096));
      },
    );
    const stream = createDownloadStream(remote.sftp, "/file", 1024 * 1024);
    stream.resume();
    await nextTurn();
    const closed = once(stream, "close");
    stream.destroy();
    for (const reply of replies) reply();
    await closed;
    expect(remote.read).toHaveBeenCalledTimes(32);
    expect(remote.closedWithPending).toEqual([0]);
  });

  it("bounds read-ahead while the consumer is paused", async () => {
    const remote = source(Buffer.alloc(8 * 1024 * 1024));
    const stream = createDownloadStream(remote.sftp, "/file", 8 * 1024 * 1024);
    stream.read(0);
    await once(stream, "readable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A full window in flight plus the one chunk handed to the paused consumer.
    expect(remote.read).toHaveBeenCalledTimes(33);
    const closed = once(stream, "close");
    stream.destroy();
    await closed;
    expect(remote.closedWithPending).toEqual([0]);
  });
});
