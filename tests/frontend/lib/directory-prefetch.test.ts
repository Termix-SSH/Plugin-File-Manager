import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectoryPrefetch } from "../../../src/frontend/lib/directory-prefetch";
import {
  peekCachedFileList,
  updateCachedFileList,
} from "../../../src/frontend/lib/file-list-request-cache";
import type { FileItem } from "../../../src/frontend/host-types";

const directory = (path: string): FileItem => ({
  path,
  name: path.split("/").pop()!,
  type: "directory",
});

function setup() {
  const pending: {
    resolve: (value?: unknown) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const read = vi.fn(
    (_path: string): Promise<unknown> =>
      new Promise((resolve, reject) => pending.push({ resolve, reject })),
  );
  const run = vi.fn((task: () => Promise<unknown>) => {
    void Promise.resolve()
      .then(task)
      .catch(() => {});
    return true;
  });
  const isCached = vi.fn((_path: string) => false);
  const scheduler = createDirectoryPrefetch({ read, run, isCached });
  return { scheduler, read, run, isCached, pending };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bounded directory prefetch", () => {
  it("cancels a fast hover sweep and admits deliberate hover after 100 ms", async () => {
    const { scheduler, read } = setup();
    for (const path of ["/a", "/b", "/c"]) {
      scheduler.hover(path);
      await vi.advanceTimersByTimeAsync(50);
      scheduler.cancelIntent(path);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(read).not.toHaveBeenCalled();
    scheduler.hover("/deliberate");
    await vi.advanceTimersByTimeAsync(99);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledExactlyOnceWith("/deliberate");
    scheduler.dispose();
  });

  it("predicts at most two uncached direct children, never recurses into results", async () => {
    const { scheduler, read, pending, isCached } = setup();
    isCached.mockImplementation((path) => path === "/parent/cached");
    scheduler.predict("/parent", [
      directory("/other/not-a-child"),
      directory("/parent/a/grandchild"),
      directory("/parent/.."),
      { ...directory("/parent/link"), type: "link" },
      directory("/parent/cached"),
      directory("/parent/a"),
      directory("/parent/a"),
      directory("/parent/b"),
      directory("/parent/c"),
    ]);
    await vi.advanceTimersByTimeAsync(199);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read.mock.calls).toEqual([["/parent/a"]]);
    pending[0].resolve({ files: [directory("/parent/a/nested")] });
    await vi.runAllTimersAsync();
    expect(read.mock.calls).toEqual([["/parent/a"], ["/parent/b"]]);
    pending[1].resolve();
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("keeps one read active and at most two queued, with intent ahead of predictions", async () => {
    const { scheduler, read, pending } = setup();
    scheduler.predict("/", [directory("/a"), directory("/b")]);
    await vi.advanceTimersByTimeAsync(200);
    scheduler.intent("/c");
    scheduler.intent("/d");
    expect(read.mock.calls).toEqual([["/a"]]);
    pending[0].resolve();
    await vi.runAllTimersAsync();
    expect(read.mock.calls).toEqual([["/a"], ["/d"]]);
    pending[1].resolve();
    await vi.runAllTimersAsync();
    expect(read.mock.calls).toEqual([["/a"], ["/d"], ["/c"]]);
    pending[2].resolve();
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it("foreground clears pending work, blocks admission, and leaves the shared active read intact", async () => {
    const { scheduler, read, pending } = setup();
    scheduler.intent("/active");
    await vi.advanceTimersByTimeAsync(0);
    scheduler.intent("/queued");
    scheduler.hover("/hover");
    scheduler.predict("/", [directory("/predicted")]);
    scheduler.setForeground(true);
    scheduler.intent("/blocked");
    scheduler.hover("/blocked-hover");
    scheduler.predict("/", [directory("/blocked-prediction")]);
    await vi.runAllTimersAsync();
    expect(read.mock.calls).toEqual([["/active"]]);
    pending[0].resolve();
    await vi.runAllTimersAsync();
    scheduler.setForeground(false);
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(1);
    scheduler.intent("/next");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenLastCalledWith("/next");
    scheduler.dispose();
  });

  it("does not get stuck when the adaptive budget denies admission", async () => {
    const { scheduler, run, read } = setup();
    run.mockReturnValueOnce(false);
    scheduler.intent("/denied");
    scheduler.intent("/allowed");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledExactlyOnceWith("/allowed");
    scheduler.dispose();
  });

  it("rechecks foreground priority after SDK admission but before the deferred task runs", async () => {
    const { scheduler, read } = setup();
    scheduler.intent("/deferred");
    scheduler.setForeground(true);
    await vi.runAllTimersAsync();
    expect(read).not.toHaveBeenCalled();
    scheduler.setForeground(false);
    scheduler.intent("/allowed");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledExactlyOnceWith("/allowed");
    scheduler.dispose();
  });

  it("releases the slot after failures and permits a later retry", async () => {
    const { scheduler, read, pending } = setup();
    scheduler.intent("/failure");
    scheduler.intent("/next");
    await vi.advanceTimersByTimeAsync(0);
    pending[0].reject(new Error("offline"));
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenLastCalledWith("/next");
    pending[1].resolve();
    await vi.runAllTimersAsync();
    scheduler.intent("/failure");
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls).toEqual([["/failure"], ["/next"], ["/failure"]]);
    scheduler.dispose();
  });

  it("disposes timers and queued work for a previous session without aborting its read", async () => {
    const { scheduler, read, pending } = setup();
    scheduler.intent("/active");
    await vi.advanceTimersByTimeAsync(0);
    scheduler.intent("/queued");
    scheduler.hover("/hover");
    scheduler.predict("/", [directory("/predicted")]);
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    pending[0].resolve();
    scheduler.intent("/after-dispose");
    scheduler.hover("/after-dispose");
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledExactlyOnceWith("/active");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses 5-second freshness rather than the cache's 5-minute stale paint window", async () => {
    const read = vi.fn(async (_path: string) => undefined);
    const sessionId = "prefetch-freshness";
    updateCachedFileList(sessionId, "/cached", []);
    const scheduler = createDirectoryPrefetch({
      read,
      isCached: (path) => peekCachedFileList(sessionId, path, 5_000) !== null,
      run: (task) => {
        void task();
        return true;
      },
    });
    scheduler.intent("/cached");
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(peekCachedFileList(sessionId, "/cached")).not.toBeNull();
    scheduler.intent("/cached");
    expect(read).toHaveBeenCalledExactlyOnceWith("/cached");
    scheduler.dispose();
  });
});
