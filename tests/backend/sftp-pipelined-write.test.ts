import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { pipelineWriteToSftp } from "../../src/backend/sftp-pipelined-write";

type Ack = (err?: Error) => void;

function fakeSftp(opts: { openDelay?: boolean; failWriteAt?: number } = {}) {
  const file = Buffer.alloc(8 * 1024 * 1024);
  const pending: Ack[] = [];
  let writes = 0;
  let maxInFlight = 0;
  let openCb: ((e: Error | undefined, h: Buffer) => void) | undefined;
  const close = vi.fn((_h: Buffer, cb: (e?: Error) => void) => cb());
  const sftp = {
    open: vi.fn((_p: string, _f: string, cb: typeof openCb) => {
      if (opts.openDelay) openCb = cb;
      else cb!(undefined, Buffer.from("h"));
    }),
    write: vi.fn(
      (
        _h: Buffer,
        buf: Buffer,
        off: number,
        len: number,
        pos: number,
        cb: Ack,
      ) => {
        buf.copy(file, pos, off, off + len);
        const failing = opts.failWriteAt === writes++;
        pending.push(() => cb(failing ? new Error("write failed") : undefined));
        maxInFlight = Math.max(maxInFlight, pending.length);
      },
    ),
    close,
  };
  // Acknowledge in reverse order to prove offsets do not depend on ack order.
  const flush = () => {
    while (pending.length) pending.pop()!();
  };
  return {
    sftp: sftp as never,
    close,
    file,
    flush,
    finishOpen: () => openCb!(undefined, Buffer.from("h")),
    maxInFlight: () => maxInFlight,
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("pipelineWriteToSftp", () => {
  it("writes exact bytes with out-of-order acks and bounded concurrency", async () => {
    const f = fakeSftp();
    const src = new PassThrough();
    const data = Buffer.from(
      Array.from({ length: 6_000_000 }, (_, i) => i % 251),
    );
    const { done } = pipelineWriteToSftp(f.sftp, "/x", src);
    src.end(data);
    for (let i = 0; i < 200 && f.close.mock.calls.length === 0; i++) {
      await tick();
      f.flush();
    }
    await expect(done).resolves.toBe(data.length);
    expect(f.file.subarray(0, data.length).equals(data)).toBe(true);
    expect(f.maxInFlight()).toBeLessThanOrEqual(64);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("rejects, drains the source and closes once on a write error", async () => {
    const f = fakeSftp({ failWriteAt: 2 });
    const src = new PassThrough();
    const { done } = pipelineWriteToSftp(f.sftp, "/x", src);
    src.write(Buffer.alloc(512 * 1024));
    await tick();
    f.flush();
    await expect(done).rejects.toThrow("write failed");
    expect(src.isPaused()).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of throwing when the source errors before open finishes", async () => {
    const f = fakeSftp({ openDelay: true });
    const src = new PassThrough();
    const { done } = pipelineWriteToSftp(f.sftp, "/x", src);
    src.destroy(new Error("truncated"));
    await expect(done).rejects.toThrow("truncated");
    f.finishOpen();
    expect(f.close).toHaveBeenCalledTimes(1); // late handle is not leaked
  });

  it("aborts before open without leaking the handle", async () => {
    const f = fakeSftp({ openDelay: true });
    const src = new PassThrough();
    const { done, abort } = pipelineWriteToSftp(f.sftp, "/x", src);
    abort();
    await expect(done).rejects.toThrow("aborted");
    f.finishOpen();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
