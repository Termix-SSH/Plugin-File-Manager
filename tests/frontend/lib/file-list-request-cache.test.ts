import { describe, expect, it } from "vitest";
import {
  getCachedFileList,
  getFileListEpoch,
  invalidateCachedFileList,
  peekCachedFileList,
  updateCachedFileList,
} from "../../../src/frontend/lib/file-list-request-cache";

describe("directory snapshot invalidation", () => {
  it("increments the session epoch even when no paths have been cached", () => {
    expect(getFileListEpoch("epoch-host")).toBe(0);
    expect(getFileListEpoch("other-epoch-host")).toBe(0);
    invalidateCachedFileList("epoch-host", "/parent");
    expect(getFileListEpoch("epoch-host")).toBe(1);
    invalidateCachedFileList("epoch-host", "/unrelated");
    expect(getFileListEpoch("epoch-host")).toBe(2);
    expect(getFileListEpoch("other-epoch-host")).toBe(0);
  });

  it("clears prefetched descendants and prevents old requests from restoring them", async () => {
    updateCachedFileList("mutation-host", "/parent", []);
    updateCachedFileList("other-host", "/parent", []);
    let finish!: (value: { files: []; path: string }) => void;
    const pending = getCachedFileList(
      "mutation-host",
      "/parent/child",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    invalidateCachedFileList("mutation-host", "/parent");
    finish({ files: [], path: "/parent/child" });
    await pending;
    expect(peekCachedFileList("mutation-host", "/parent")).toBeNull();
    expect(peekCachedFileList("mutation-host", "/parent/child")).toBeNull();
    expect(peekCachedFileList("other-host", "/parent")).not.toBeNull();
  });

  it("does not overwrite a new epoch's listing when an old read finishes last", async () => {
    let finish!: (value: { files: []; path: string }) => void;
    const old = getCachedFileList(
      "epoch-race-host",
      "/alias",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    invalidateCachedFileList("epoch-race-host", "/alias");
    const fresh = { files: [], path: "/new" };
    await getCachedFileList("epoch-race-host", "/alias", async () => fresh);
    finish({ files: [], path: "/old" });
    await old;
    expect(peekCachedFileList("epoch-race-host", "/alias", 5_000)).toBe(fresh);
  });
});
