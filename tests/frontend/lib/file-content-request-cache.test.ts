import { describe, expect, it, vi } from "vitest";
import {
  getCachedFileContent,
  invalidateCachedFileContent,
  shouldPrefetchFileContent,
} from "../../../src/frontend/lib/file-content-request-cache";

describe("file content request cache", () => {
  it("invalidates overwritten folder contents without flushing siblings or other sessions", async () => {
    const loader = vi.fn(async () => ({ content: "old", path: "/folder/a" }));
    for (const [session, path] of [
      ["copy", "/folder/a"],
      ["copy", "/folder-b/a"],
      ["other", "/folder/a"],
    ]) {
      await getCachedFileContent(session, path, loader);
    }
    invalidateCachedFileContent("copy", "/folder");
    for (const [session, path] of [
      ["copy", "/folder/a"],
      ["copy", "/folder-b/a"],
      ["other", "/folder/a"],
    ]) {
      await getCachedFileContent(session, path, loader);
    }
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("coalesces reads and reloads after invalidation", async () => {
    const loader = vi.fn(async () => ({ content: "hello", path: "/note" }));

    await Promise.all([
      getCachedFileContent("session", "/note", loader),
      getCachedFileContent("session", "/note", loader),
    ]);
    expect(loader).toHaveBeenCalledOnce();

    invalidateCachedFileContent("session", "/note");
    await getCachedFileContent("session", "/note", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("only prefetches known small files on an unconstrained network", () => {
    expect(
      shouldPrefetchFileContent(
        { name: "note", path: "/note", type: "file", size: 512 * 1024 },
        512 * 1024,
      ),
    ).toBe(true);
    expect(
      shouldPrefetchFileContent(
        { name: "large", path: "/large", type: "file", size: 512 * 1024 + 1 },
        512 * 1024,
      ),
    ).toBe(false);
    expect(
      shouldPrefetchFileContent(
        { name: "unknown", path: "/unknown", type: "file" },
        512 * 1024,
      ),
    ).toBe(false);
    expect(
      shouldPrefetchFileContent(
        { name: "note", path: "/note", type: "file", size: 100 },
        0,
      ),
    ).toBe(false);
  });
});
