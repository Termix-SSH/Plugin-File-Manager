import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { LocalWalkResult } from "../../../src/frontend/local-types";

const mocks = vi.hoisted(() => ({
  walk: vi.fn(),
  createFolder: vi.fn(async () => ({})),
  upload: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => {
  const toast = {
    loading: vi.fn(() => "t"),
    dismiss: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  };
  return { toast };
});
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  useSettings: () => ({ values: {}, loaded: false, save: vi.fn() }),
}));
vi.mock("../../../src/frontend/lib/local-files", () => ({
  walkLocalPaths: mocks.walk,
  ensureLocalDirectory: vi.fn(),
  getLocalHome: vi.fn(),
  localPathsExist: vi.fn(),
}));
vi.mock("../../../src/frontend/api/ssh-file-operations-api", () => ({
  createSSHFolder: mocks.createFolder,
  listSSHFiles: vi.fn(),
}));
vi.mock("../../../src/frontend/api/local-transfer-api", () => ({
  cancelLocalTransfer: vi.fn(),
  createLocalTransferId: () => "id",
  downloadSessionFileToLocal: vi.fn(),
  uploadLocalFileToSession: mocks.upload,
}));

import { useLocalTransfers } from "../../../src/frontend/hooks/useLocalTransfers";

const walked: LocalWalkResult = {
  files: [
    { localPath: "C:\\src\\dir\\a.txt", relativePath: "dir/a.txt", size: 4 },
  ],
  emptyDirs: [],
  totalBytes: 4,
};

function setup() {
  const onRemoteChanged = vi.fn();
  const { result } = renderHook(() =>
    useLocalTransfers({
      sshSessionId: "s",
      hostId: 7,
      ensureSSHConnection: async () => undefined,
      onRemoteChanged,
      onLocalChanged: vi.fn(),
    }),
  );
  return { upload: result.current.uploadLocalPaths, onRemoteChanged };
}

describe("uploadLocalPaths resolveConflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.walk.mockResolvedValue(walked);
  });

  it("writes nothing when the conflict prompt is cancelled", async () => {
    const { upload, onRemoteChanged } = setup();
    await upload(["C:\\src\\dir"], "/remote", async () => null);
    expect(mocks.createFolder).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(onRemoteChanged).not.toHaveBeenCalled();
  });

  it("writes nothing when every item is skipped", async () => {
    const { upload } = setup();
    await upload(["C:\\src\\dir"], "/remote", async () => ({
      files: [],
      emptyDirs: [],
    }));
    expect(mocks.createFolder).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("remaps keep-both paths and forwards overwrite=false with the upload root", async () => {
    const { upload } = setup();
    await upload(["C:\\src\\dir"], "/remote", async (batch) => ({
      files: batch.files.map((f) => ({
        ...f,
        relativePath: f.relativePath.replace(/^dir/, "dir (1)"),
        overwrite: false,
      })),
      emptyDirs: [],
    }));
    expect(mocks.createFolder).toHaveBeenCalledWith(
      "s",
      "/remote",
      "dir (1)",
      7,
      undefined,
      "/remote",
    );
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteDir: "/remote/dir (1)",
        localPath: "C:\\src\\dir\\a.txt",
        fileName: "a.txt",
        overwrite: false,
        uploadRoot: "/remote",
      }),
    );
  });

  it("keeps the legacy overwrite behaviour when no resolver is given", async () => {
    const { upload } = setup();
    await upload(["C:\\src\\dir"], "/remote");
    const [call] = mocks.upload.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(call).not.toHaveProperty("overwrite");
    expect(call).not.toHaveProperty("uploadRoot");
    expect(mocks.createFolder).toHaveBeenCalledWith(
      "s",
      "/remote",
      "dir",
      7,
      undefined,
      undefined,
    );
  });
});
