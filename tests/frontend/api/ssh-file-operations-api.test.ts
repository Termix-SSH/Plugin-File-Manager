import { beforeEach, describe, expect, it, vi } from "vitest";

const fileManagerApiMock = vi.hoisted(() => ({
  get: vi.fn(async () => ({ data: { files: [], path: "/data" } })),
  post: vi.fn(async () => ({ data: { complete: false } })),
  postForm: vi.fn(
    async (_path?: string, _form?: FormData, _config?: unknown) => ({
      data: {},
    }),
  ),
  put: vi.fn(async () => ({ data: {} })),
  delete: vi.fn(async () => ({ data: {} })),
}));

vi.mock("../../../src/frontend/api/client", () => ({
  fileManagerApi: () => ({ defaults: {} }),
  getFileManagerApiForSession: () => fileManagerApiMock,
  handleApiError: (error: unknown) => {
    throw error;
  },
  setSessionOrigin: vi.fn(),
  clearSessionOrigin: vi.fn(),
  setSessionFtp: vi.fn(),
  listHosts: async () => [],
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveConnectionOrigin: vi.fn(),
  createFrontendLogger: () => ({
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("../../../src/frontend/lib/file-list-request-cache", () => ({
  getCachedFileList: vi.fn(),
  getFileListEpoch: vi.fn(() => 0),
}));
vi.mock("../../../src/frontend/lib/file-content-request-cache", () => ({
  getCachedFileContent: vi.fn(),
  invalidateCachedFileContent: vi.fn(),
}));

import {
  connectSSH,
  downloadSSHFileStream,
  uploadSSHFile,
  listSSHFiles,
  copySSHItem,
  moveSSHItem,
} from "../../../src/frontend/api/ssh-file-operations-api";
import {
  getCachedFileList,
  getFileListEpoch,
} from "../../../src/frontend/lib/file-list-request-cache";
import { setSessionOrigin } from "../../../src/frontend/api/client";
import { resolveConnectionOrigin } from "@termix-ssh/plugin-sdk/ui";

it("passes an explicit refresh through to the backend", async () => {
  vi.mocked(getCachedFileList).mockImplementationOnce(
    (_session, _path, loader) => loader(),
  );
  await listSSHFiles("session-refresh", "/data", { force: true });
  expect(getCachedFileList).toHaveBeenCalledWith(
    "session-refresh",
    "/data",
    expect.any(Function),
    true,
  );
  expect(fileManagerApiMock.get).toHaveBeenCalledWith("/listFiles", {
    params: {
      sessionId: "session-refresh",
      path: "/data",
      epoch: "0",
      force: true,
    },
  });
});

it("forwards the current session epoch and marks only speculative reads", async () => {
  vi.mocked(getFileListEpoch).mockReturnValueOnce(3);
  vi.mocked(getCachedFileList).mockImplementationOnce(
    (_session, _path, loader) => loader(),
  );
  await listSSHFiles("session-prefetch", "/data", { prefetch: true });
  expect(getFileListEpoch).toHaveBeenLastCalledWith("session-prefetch");
  expect(fileManagerApiMock.get).toHaveBeenLastCalledWith("/listFiles", {
    params: {
      sessionId: "session-prefetch",
      path: "/data",
      epoch: "3",
      prefetch: "true",
    },
  });

  vi.mocked(getCachedFileList).mockImplementationOnce(
    (_session, _path, loader) => loader(),
  );
  await listSSHFiles("session-navigation", "/data", { prefetch: false });
  expect(fileManagerApiMock.get).toHaveBeenLastCalledWith("/listFiles", {
    params: { sessionId: "session-navigation", path: "/data", epoch: "0" },
  });
});

it("retries once as a forced read when a joined prefetch skipped sudo", async () => {
  const skipped = { response: { data: { prefetchSkippedSudo: true } } };
  vi.mocked(getCachedFileList)
    .mockRejectedValueOnce(skipped)
    .mockImplementationOnce((_s, _p, loader) => loader());
  await listSSHFiles("session-sudo", "/root");
  expect(getCachedFileList).toHaveBeenLastCalledWith(
    "session-sudo",
    "/root",
    expect.any(Function),
    true,
  );
  vi.mocked(getCachedFileList).mockRejectedValueOnce(skipped);
  await expect(
    listSSHFiles("session-sudo", "/root", { prefetch: true }),
  ).rejects.toBe(skipped);
});

describe("connectSSH origin", () => {
  it("connects where the host or the desktop default says", async () => {
    vi.mocked(resolveConnectionOrigin).mockResolvedValueOnce("remote");
    fileManagerApiMock.post.mockClear();

    await connectSSH("7", {
      hostId: 7,
      syncId: "sync-7",
      ip: "10.0.0.7",
      port: 22,
      username: "root",
      connectionOrigin: null,
    });

    expect(resolveConnectionOrigin).toHaveBeenCalledWith({
      connectionOrigin: null,
    });
    expect(setSessionOrigin).toHaveBeenCalledWith("7", "remote");
    const body = (
      fileManagerApiMock.post.mock.calls[0] as unknown[]
    )[1] as Record<string, unknown>;
    expect(body.syncId).toBe("sync-7");
    expect(body).not.toHaveProperty("connectionOrigin");
  });
});

describe("chunked SSH file uploads", () => {
  beforeEach(() => {
    fileManagerApiMock.post.mockClear();
    fileManagerApiMock.postForm.mockClear();
  });

  it("removes the partial remote file when cancelled between chunks", async () => {
    const controller = new AbortController();
    const file = {
      size: 1.5 * 1024 * 1024 * 1024 + 1,
      slice: vi.fn(() => new Blob(["chunk"])),
    } as unknown as File;

    await expect(
      uploadSSHFile(
        "session-1",
        "/uploads",
        "archive.img",
        file,
        undefined,
        undefined,
        () => controller.abort(),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fileManagerApiMock.delete).toHaveBeenCalledWith("/deleteItem", {
      data: expect.objectContaining({
        path: "/uploads/archive.img",
        permanent: true,
      }),
    });
  });

  it("sends raw chunks with the byte offset expected by the server", async () => {
    const fileSize = 1.5 * 1024 * 1024 * 1024 + 1;
    const file = {
      size: fileSize,
      slice: vi.fn(() => new Blob(["chunk"])),
    } as unknown as File;

    await uploadSSHFile("session-1", "/uploads", "archive.img", file);

    expect(fileManagerApiMock.post).toHaveBeenCalledTimes(193);
    expect(fileManagerApiMock.post).toHaveBeenNthCalledWith(
      1,
      "/uploadFileChunk",
      expect.any(Blob),
      {
        params: {
          sessionId: "session-1",
          path: "/uploads",
          fileName: "archive.img",
          offset: 0,
          totalSize: fileSize,
          overwrite: true,
        },
        headers: { "Content-Type": "application/octet-stream" },
        timeout: 0,
        signal: undefined,
      },
    );
    expect(fileManagerApiMock.post).toHaveBeenLastCalledWith(
      "/uploadFileChunk",
      expect.any(Blob),
      expect.objectContaining({
        params: expect.objectContaining({ offset: 1.5 * 1024 * 1024 * 1024 }),
      }),
    );
  });
});

describe("upload cancellation", () => {
  it("passes the protected overwrite decision before the multipart file", async () => {
    await uploadSSHFile(
      "s",
      "/",
      "renamed.txt",
      new File(["data"], "original.txt"),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    const form = fileManagerApiMock.postForm.mock.calls.at(-1)![1] as FormData;
    expect(form.get("overwrite")).toBe("false");
    expect((form.get("file") as File).name).toBe("renamed.txt");
    expect([...form.keys()].indexOf("overwrite")).toBeLessThan(
      [...form.keys()].indexOf("file"),
    );
  });

  it("does not delete an existing file if the first exclusive chunk is rejected", async () => {
    const controller = new AbortController();
    fileManagerApiMock.delete.mockClear();
    fileManagerApiMock.post.mockRejectedValueOnce(new Error("File exists"));
    const file = {
      size: 2 * 1024 ** 3,
      slice: () => new Blob(["chunk"]),
    } as unknown as File;
    await expect(
      uploadSSHFile(
        "s",
        "/",
        "exists",
        file,
        undefined,
        undefined,
        undefined,
        controller.signal,
        false,
      ),
    ).rejects.toThrow("File exists");
    controller.abort();
    expect(fileManagerApiMock.delete).not.toHaveBeenCalled();
    expect(fileManagerApiMock.post).toHaveBeenLastCalledWith(
      "/uploadFileChunk",
      expect.any(Blob),
      expect.objectContaining({
        params: expect.objectContaining({ overwrite: false, offset: 0 }),
      }),
    );
  });

  it("passes the signal to multipart uploads", async () => {
    const controller = new AbortController();
    await uploadSSHFile(
      "s",
      "/",
      "a.txt",
      new File(["data"], "a.txt"),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    expect(fileManagerApiMock.postForm).toHaveBeenLastCalledWith(
      "/uploadFileStream",
      expect.any(FormData),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("does not start an already cancelled upload", async () => {
    const controller = new AbortController();
    controller.abort();
    fileManagerApiMock.postForm.mockClear();
    await expect(
      uploadSSHFile(
        "s",
        "/",
        "a.txt",
        new File(["data"], "a.txt"),
        undefined,
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fileManagerApiMock.postForm).not.toHaveBeenCalled();
  });

  it("stops scheduling chunks after cancellation", async () => {
    const controller = new AbortController();
    fileManagerApiMock.post.mockClear();
    const file = {
      size: 2 * 1024 ** 3,
      slice: vi.fn(() => new Blob(["chunk"])),
    } as unknown as File;
    await expect(
      uploadSSHFile(
        "s",
        "/",
        "large.bin",
        file,
        undefined,
        undefined,
        () => controller.abort(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fileManagerApiMock.post).toHaveBeenCalledOnce();
    expect(fileManagerApiMock.post).toHaveBeenCalledWith(
      "/uploadFileChunk",
      expect.any(Blob),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(file.slice).toHaveBeenCalledOnce();
  });
});

describe("download cancellation", () => {
  it("passes the signal to streamed downloads", async () => {
    const controller = new AbortController();
    fileManagerApiMock.post.mockResolvedValueOnce({
      data: new Blob(["x"]),
    } as never);
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    await downloadSSHFileStream("s", "/a.txt", undefined, controller.signal);
    expect(fileManagerApiMock.post).toHaveBeenLastCalledWith(
      "/downloadFileStream",
      { sessionId: "s", path: "/a.txt" },
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("copy/move destination decisions", () => {
  it("sends a resolved copy name and explicit overwrite without changing older callers", async () => {
    await copySSHItem("s", "/source/a", "/target", undefined, undefined, {
      name: "a (1)",
      overwrite: false,
    });
    expect(fileManagerApiMock.post).toHaveBeenLastCalledWith(
      "/copyItem",
      expect.objectContaining({ targetName: "a (1)", overwrite: false }),
      { timeout: 0 },
    );
    await copySSHItem("s", "/source/a", "/target", undefined, undefined, {
      name: "a",
      overwrite: true,
    });
    expect(fileManagerApiMock.post).toHaveBeenLastCalledWith(
      "/copyItem",
      expect.objectContaining({ targetName: "a", overwrite: true }),
      { timeout: 0 },
    );
  });
  it("makes move/undo no-clobber by default and overwrite opt-in", async () => {
    await moveSSHItem("s", "/a", "/b");
    expect(fileManagerApiMock.put).toHaveBeenLastCalledWith(
      "/moveItem",
      expect.objectContaining({ overwrite: false }),
      { timeout: 60000 },
    );
    await moveSSHItem("s", "/a", "/b", undefined, undefined, true);
    expect(fileManagerApiMock.put).toHaveBeenLastCalledWith(
      "/moveItem",
      expect.objectContaining({ overwrite: true }),
      { timeout: 60000 },
    );
  });
});
