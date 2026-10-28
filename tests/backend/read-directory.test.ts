import type { FileEntry, SFTPWrapper } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { readDirectory } from "../../src/backend/read-directory.js";

type ReadCallback = (
  error: Error | null,
  entries?: FileEntry[] | false,
) => void;
const eof = () => Object.assign(new Error("EOF"), { code: 1 });
const entry = (index: number): FileEntry => ({
  filename: `file-${index}`,
  longname: "",
  attrs: {} as FileEntry["attrs"],
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const handle = Buffer.from("directory");
  const replies: ReadCallback[] = [];
  let active = 0;
  let maximum = 0;
  const sftp = {
    opendir: vi.fn(
      (_path: string, done: (error: Error | null, handle?: Buffer) => void) =>
        done(null, handle),
    ),
    readdir: vi.fn(
      (_handle: Buffer, _options: { full: boolean }, done: ReadCallback) => {
        active++;
        maximum = Math.max(maximum, active);
        replies.push((error, entries) => {
          active--;
          done(error, entries);
        });
      },
    ),
    // Deliberately leave CLOSE unanswered: successful data must not wait for it.
    close: vi.fn((_handle: Buffer, _done: (error?: Error) => void) => {
      expect(active).toBe(0);
    }),
  };
  const done = vi.fn();
  const onCloseError = vi.fn();
  return {
    sftp,
    handle,
    replies,
    done,
    onCloseError,
    maximum: () => maximum,
    start: async () => {
      readDirectory(
        sftp as unknown as SFTPWrapper,
        "/data",
        done,
        onCloseError,
      );
      await flush();
    },
  };
}

describe("pipelined SFTP directory reads", () => {
  it("deduplicates filenames across concurrent replies, keeping the first issued entry", async () => {
    const f = setup();
    const first = entry(0);
    const duplicate = { ...first, longname: "later version" };
    await f.start();
    f.replies[1](null, [duplicate, entry(1), duplicate]);
    await flush();
    f.replies[0](null, [first]);
    await flush();
    f.replies[2](eof());
    f.replies[3](eof());
    await flush();
    expect(f.done).toHaveBeenCalledExactlyOnceWith(null, [first, entry(1)]);
    expect(f.done.mock.calls[0][1][0]).toBe(first);
    expect(f.maximum()).toBe(2);
    expect(f.sftp.close).toHaveBeenCalledTimes(1);
  });

  it("collects all 484 entries in issued batch order with at most two pending reads", async () => {
    const f = setup();
    const entries = Array.from({ length: 484 }, (_, index) => entry(index));
    await f.start();
    expect(f.replies).toHaveLength(2);
    f.replies[1](null, entries.slice(120, 240));
    await flush();
    f.replies[0](null, entries.slice(0, 120));
    await flush();
    f.replies[3](null, entries.slice(360));
    await flush();
    f.replies[2](null, entries.slice(240, 360));
    await flush();
    f.replies[5](eof());
    await flush();
    expect(f.done).not.toHaveBeenCalled();
    expect(f.sftp.close).not.toHaveBeenCalled();
    f.replies[4](eof());
    await flush();
    expect(f.done).toHaveBeenCalledExactlyOnceWith(null, entries);
    expect(f.maximum()).toBe(2);
    expect(f.sftp.readdir).toHaveBeenCalledTimes(6);
    expect(f.sftp.readdir).toHaveBeenCalledWith(
      f.handle,
      { full: true },
      expect.any(Function),
    );
    expect(f.sftp.close).toHaveBeenCalledExactlyOnceWith(
      f.handle,
      expect.any(Function),
    );
  });

  it.each(["status", "false"])(
    "drains late data after %s EOF without issuing more reads",
    async (kind) => {
      const f = setup();
      await f.start();
      if (kind === "status") f.replies[1](eof());
      else f.replies[1](null, false);
      await flush();
      expect(f.done).not.toHaveBeenCalled();
      expect(f.sftp.close).not.toHaveBeenCalled();
      expect(f.replies).toHaveLength(2);
      f.replies[0](null, [entry(0)]);
      await flush();
      expect(f.done).toHaveBeenCalledExactlyOnceWith(null, [entry(0)]);
      expect(f.sftp.close).toHaveBeenCalledTimes(1);
      expect(f.replies).toHaveLength(2);
    },
  );

  it.each(["status", "false"])(
    "lists an empty directory terminated by %s EOF",
    async (kind) => {
      const f = setup();
      await f.start();
      for (const reply of f.replies) {
        if (kind === "status") reply(eof());
        else reply(null, false);
      }
      await flush();
      expect(f.done).toHaveBeenCalledExactlyOnceWith(null, []);
      expect(f.sftp.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["status", "false"])(
    "does not swallow an error arriving after %s EOF",
    async (kind) => {
      const f = setup();
      const error = new Error("late read failure");
      await f.start();
      if (kind === "status") f.replies[1](eof());
      else f.replies[1](null, false);
      await flush();
      f.replies[0](error);
      await flush();
      expect(f.done).toHaveBeenCalledExactlyOnceWith(error, []);
      expect(f.sftp.close).toHaveBeenCalledTimes(1);
    },
  );

  it("discards partial data on error and drains the outstanding read before closing", async () => {
    const f = setup();
    const error = new Error("read failure");
    await f.start();
    f.replies[0](null, [entry(0)]);
    await flush();
    f.replies[2](error);
    await flush();
    expect(f.done).not.toHaveBeenCalled();
    expect(f.sftp.close).not.toHaveBeenCalled();
    f.replies[1](null, [entry(1)]);
    await flush();
    expect(f.done).toHaveBeenCalledExactlyOnceWith(error, []);
    expect(f.replies).toHaveLength(3);
    expect(f.sftp.close).toHaveBeenCalledTimes(1);
  });

  it.each(["callback", "throw"])(
    "reports opendir %s failure without reading or closing",
    async (kind) => {
      const f = setup();
      const error = new Error("open failure");
      f.sftp.opendir.mockImplementation((_path, done) => {
        if (kind === "throw") throw error;
        done(error);
      });
      await f.start();
      expect(f.done).toHaveBeenCalledExactlyOnceWith(error, []);
      expect(f.sftp.readdir).not.toHaveBeenCalled();
      expect(f.sftp.close).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])(
    "drains the other read when read %s throws synchronously",
    async (throwIndex) => {
      const f = setup();
      const error = new Error("synchronous read failure");
      const queueRead = f.sftp.readdir.getMockImplementation()!;
      if (throwIndex === 1) f.sftp.readdir.mockImplementationOnce(queueRead);
      f.sftp.readdir.mockImplementationOnce(() => {
        throw error;
      });
      await f.start();
      expect(f.replies).toHaveLength(1);
      expect(f.sftp.close).not.toHaveBeenCalled();
      f.replies[0](eof());
      await flush();
      expect(f.done).toHaveBeenCalledExactlyOnceWith(error, []);
      expect(f.sftp.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["success", "read failure"])(
    "logs an asynchronous close failure after %s without delaying the result",
    async (kind) => {
      const f = setup();
      const readError = new Error("read failure");
      const closeError = new Error("close failure");
      await f.start();
      f.replies[0](kind === "success" ? eof() : readError);
      f.replies[1](eof());
      await flush();
      expect(f.done).toHaveBeenCalledExactlyOnceWith(
        kind === "success" ? null : readError,
        [],
      );
      f.sftp.close.mock.calls[0][1](closeError);
      expect(f.onCloseError).toHaveBeenCalledExactlyOnceWith(closeError);
      expect(f.sftp.close).toHaveBeenCalledTimes(1);
      expect(f.done).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["success", "read failure"])(
    "logs a synchronous close throw after %s without replacing the result",
    async (kind) => {
      const f = setup();
      const readError = new Error("read failure");
      const closeError = new Error("close throw");
      f.sftp.close.mockImplementation(() => {
        throw closeError;
      });
      await f.start();
      f.replies[0](kind === "success" ? eof() : readError);
      f.replies[1](eof());
      await flush();
      expect(f.onCloseError).toHaveBeenCalledExactlyOnceWith(closeError);
      expect(f.done).toHaveBeenCalledExactlyOnceWith(
        kind === "success" ? null : readError,
        [],
      );
      expect(f.sftp.close).toHaveBeenCalledTimes(1);
    },
  );

  it("fails an empty successful batch instead of spinning or treating it as EOF", async () => {
    const f = setup();
    await f.start();
    f.replies[0](null, []);
    await flush();
    expect(f.replies).toHaveLength(2);
    expect(f.sftp.close).not.toHaveBeenCalled();
    f.replies[1](null, [entry(0)]);
    await flush();
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      new Error("SFTP readdir returned an empty batch without EOF"),
      [],
    );
    expect(f.sftp.close).toHaveBeenCalledTimes(1);
  });

  it("continues through dot-only batches and filters them from the result", async () => {
    const f = setup();
    await f.start();
    f.replies[0](null, [
      { ...entry(0), filename: "." },
      { ...entry(0), filename: ".." },
    ]);
    await flush();
    f.replies[2](eof());
    await flush();
    f.replies[1](null, [entry(0)]);
    await flush();
    expect(f.done).toHaveBeenCalledExactlyOnceWith(null, [entry(0)]);
    expect(f.sftp.close).toHaveBeenCalledTimes(1);
  });

  it("handles synchronously delivered batches without recursive callbacks", async () => {
    const f = setup();
    let batch = 0;
    f.sftp.readdir.mockImplementation((_handle, _options, done) => {
      if (batch < 484) done(null, [entry(batch++)]);
      else done(eof());
    });
    await f.start();
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      null,
      Array.from({ length: 484 }, (_, index) => entry(index)),
    );
    expect(f.sftp.close).toHaveBeenCalledTimes(1);
  });
});
