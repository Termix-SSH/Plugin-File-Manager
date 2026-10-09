import { beforeEach, describe, expect, it, vi } from "vitest";

const fileManagerApiMock = vi.hoisted(() => ({
  post: vi.fn(async () => ({ data: { complete: false } })),
  postForm: vi.fn(async () => ({ data: {} })),
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
}));
vi.mock("../../../src/frontend/lib/file-content-request-cache", () => ({
  getCachedFileContent: vi.fn(),
  invalidateCachedFileContent: vi.fn(),
}));

import {
  downloadSSHFileStream,
  uploadSSHFile,
} from "../../../src/frontend/api/ssh-file-operations-api";

describe("chunked SSH file uploads", () => {
  beforeEach(() => {
    fileManagerApiMock.post.mockClear();
    fileManagerApiMock.postForm.mockClear();
  });

  it("removes the partial remote file when cancelled between chunks", async () => {
    const controller = new AbortController();
    fileManagerApiMock.post.mockImplementationOnce(async () => {
      controller.abort();
      return { data: { complete: false } };
    });
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
        undefined,
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
