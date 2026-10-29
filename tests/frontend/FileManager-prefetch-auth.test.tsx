import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { FileItem, SSHHost } from "../../src/frontend/host-types";

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  get: vi.fn(),
  connect: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBrowser: vi.fn(),
  grid: vi.fn(
    (
      _props: React.ComponentProps<
        typeof import("../../src/frontend/FileManagerGrid").FileManagerGrid
      >,
    ) => null,
  ),
  toolbar: vi.fn(
    (
      _props: React.ComponentProps<
        typeof import("../../src/frontend/FileManagerToolbar").FileManagerToolbar
      >,
    ) => null,
  ),
  dialogs: vi.fn(
    (
      _props: React.ComponentProps<
        typeof import("../../src/frontend/FileManagerDialogs").FileManagerDialogs
      >,
    ) => null,
  ),
  passphrase: vi.fn(
    (_props: { onSubmit: (value: string) => Promise<void> }) => null,
  ),
}));

vi.mock("../../src/frontend/api/client", () => ({
  fileManagerApi: () => ({ get: mocks.get }),
  getFileManagerApiForSession: () => ({ get: mocks.get }),
  handleApiError: (error: unknown) => {
    throw error;
  },
}));
vi.mock(
  "../../src/frontend/api/ssh-file-operations-api",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    connectSSH: mocks.connect,
    verifySSHTOTP: mocks.verifyTotp,
    verifySSHBrowserSignIn: mocks.verifyBrowser,
  }),
);
vi.mock("../../src/frontend/api/file-manager-data-api", () => ({
  getPinnedFiles: async () => [],
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: mocks.t }),
  usePluginUiPreferences: () => ({ values: {}, set: vi.fn() }),
  useConnectionRetry: ({ connect }: { connect: () => void }) => ({
    retryNow: connect,
    reset: vi.fn(),
    markConnected: vi.fn(),
  }),
  invokeAction: async () => undefined,
  logActivity: vi.fn(),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PanelShell: ({ children }: React.PropsWithChildren) => children,
  ConnectionLogProvider: ({ children }: React.PropsWithChildren) => children,
  ConnectionLogPanel: () => null,
  ConnectionScreen: () => null,
  useConfirm: () => vi.fn(),
  useConnectionLog: () => ({ addLog: vi.fn(), clearLogs: vi.fn() }),
  PassphraseDialog: mocks.passphrase,
  runAdaptiveBackgroundTask: (
    _kind: string,
    _key: string,
    task: () => Promise<unknown>,
  ) => {
    void Promise.resolve()
      .then(task)
      .catch(() => {});
    return true;
  },
}));
vi.mock("../../src/frontend/components/WindowManager", () => ({
  WindowManager: ({ children }: React.PropsWithChildren) => children,
  useWindowManager: () => ({ openWindow: vi.fn() }),
}));
vi.mock("../../src/frontend/FileManagerGrid", () => ({
  FileManagerGrid: mocks.grid,
}));
vi.mock("../../src/frontend/FileManagerToolbar", () => ({
  FileManagerToolbar: mocks.toolbar,
}));
vi.mock("../../src/frontend/FileManagerDialogs", () => ({
  FileManagerDialogs: mocks.dialogs,
}));
vi.mock("../../src/frontend/FileManagerSidebar", () => ({
  FileManagerSidebar: () => null,
}));
vi.mock("../../src/frontend/FileManagerContextMenu", () => ({
  FileManagerContextMenu: () => null,
}));
vi.mock("../../src/frontend/LocalFilePane", () => ({
  LocalFilePane: () => null,
}));
vi.mock("../../src/frontend/FileManagerTrashDialog", () => ({
  FileManagerTrashDialog: () => null,
}));
vi.mock("../../src/frontend/components/TransferToHostDialog", () => ({
  TransferToHostDialog: () => null,
}));
vi.mock("../../src/frontend/components/FileWindow", () => ({
  FileWindow: () => null,
}));
vi.mock("../../src/frontend/components/DiffWindow", () => ({
  DiffWindow: () => null,
}));
vi.mock("../../src/frontend/components/TerminalWindow", () => ({
  TerminalWindow: () => null,
}));
vi.mock("../../src/frontend/hooks/useLocalTransfers", () => ({
  useLocalTransfers: () => ({}),
}));

import { FileManager } from "../../src/frontend/FileManager";
import { invalidateCachedFileList } from "../../src/frontend/lib/file-list-request-cache";

const host = {
  id: 901,
  ip: "test-host",
  port: 22,
  username: "alice",
} as SSHHost;
const child: FileItem = {
  name: "child",
  path: "/home/alice/child",
  type: "directory",
};
const grid = () => mocks.grid.mock.calls.at(-1)![0];
const dialogs = () => mocks.dialogs.mock.calls.at(-1)![0];
const toolbar = () => mocks.toolbar.mock.calls.at(-1)![0];
const listCalls = (path: string) =>
  mocks.get.mock.calls.filter(
    ([url, config]) => url === "/listFiles" && config.params.path === path,
  );
const tick = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  invalidateCachedFileList(String(host.id), "/");
  mocks.connect.mockResolvedValue({ status: "success" });
  mocks.verifyTotp.mockResolvedValue({ status: "success" });
  mocks.verifyBrowser.mockResolvedValue({ status: "success" });
  mocks.get.mockImplementation(async (_url, { params }) => ({
    data:
      params.path === "." || params.path === "/home/alice"
        ? { path: "/home/alice", files: [child] }
        : { path: params.path, files: [] },
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FileManager post-auth directory prefetch", () => {
  it.each(["initial", "totp", "browser", "password", "key", "passphrase"])(
    "resumes prefetch with the resolved listing after %s authentication",
    async (mode) => {
      if (mode === "totp")
        mocks.connect.mockResolvedValueOnce({ requires_totp: true });
      if (mode === "browser")
        mocks.connect.mockResolvedValueOnce({ requires_browser_sign_in: true });
      if (mode === "password" || mode === "key")
        mocks.connect.mockResolvedValueOnce({ status: "auth_required" });
      if (mode === "passphrase")
        mocks.connect.mockResolvedValueOnce({ status: "passphrase_required" });
      render(<FileManager initialHost={host} compact />);
      await tick();
      if (mode !== "initial") {
        expect(listCalls(".")).toHaveLength(0);
        await act(async () => {
          if (mode === "totp") await dialogs().handleTotpSubmit("123456");
          if (mode === "browser") await dialogs().handleBrowserSignInContinue();
          if (mode === "password")
            await dialogs().handleAuthDialogSubmit({
              password: "test-password",
            });
          if (mode === "key")
            await dialogs().handleAuthDialogSubmit({ sshKey: "test-key" });
          if (mode === "passphrase")
            await mocks.passphrase.mock.calls
              .at(-1)![0]
              .onSubmit("test-passphrase");
        });
      }
      await tick();
      await tick(201);
      expect(grid().files).toEqual([child]);
      expect(toolbar().currentPath).toBe("/home/alice");
      expect(listCalls(child.path)).toHaveLength(1);
      expect(listCalls(child.path)[0][1].params).toMatchObject({
        sessionId: String(host.id),
        prefetch: "true",
      });
      expect(dialogs().sudoDialogOpen).toBe(false);
    },
  );

  it("keeps prefetch paused while the pane is hidden, then resumes on visibility", async () => {
    const { rerender } = render(
      <FileManager initialHost={host} compact isVisible={false} />,
    );
    await tick(300);
    await tick();
    expect(listCalls(child.path)).toHaveLength(0);
    rerender(<FileManager initialHost={host} compact isVisible />);
    await tick(201);
    expect(listCalls(child.path)).toHaveLength(1);
  });
});

describe("FileManager navigation joining a speculative listing", () => {
  async function joinPrefetch() {
    let reject!: (error: unknown) => void;
    mocks.get.mockImplementation(async (_url, { params }) => {
      if (params.path === child.path && params.prefetch) {
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      }
      return {
        data: {
          path: params.path,
          files: params.path === child.path ? [] : [child],
        },
      };
    });
    render(
      <FileManager initialHost={host} initialPath="/home/alice" compact />,
    );
    await tick();
    await tick();
    await tick(201);
    expect(listCalls(child.path)[0][1].params.prefetch).toBe("true");
    await act(async () => {
      await grid().onFileOpen(child);
    });
    await tick();
    expect(listCalls(child.path)).toHaveLength(1);
    return { reject };
  }

  const skippedSudo = {
    response: {
      status: 403,
      data: { needsSudo: true, prefetchSkippedSudo: true },
    },
  };

  it("retries a skipped speculative sudo read once as forced normal navigation", async () => {
    const { reject } = await joinPrefetch();
    await act(async () => {
      reject(skippedSudo);
    });
    expect(listCalls(child.path)).toHaveLength(2);
    expect(listCalls(child.path)[1][1].params).toMatchObject({ force: true });
    expect(listCalls(child.path)[1][1].params).not.toHaveProperty("prefetch");
    expect(toolbar().currentPath).toBe(child.path);
    expect(grid().files).toEqual([]);
    expect(dialogs().sudoDialogOpen).toBe(false);
  });

  it("opens sudo only after the normal retry still requires it, without looping", async () => {
    const { reject } = await joinPrefetch();
    mocks.get.mockRejectedValueOnce(skippedSudo);
    await act(async () => {
      reject(skippedSudo);
    });
    expect(listCalls(child.path)).toHaveLength(2);
    expect(dialogs().sudoDialogOpen).toBe(true);
    expect(toolbar().currentPath).toBe("/home/alice");
  });

  it("does not retry an ordinary sudo error as a speculative skip", async () => {
    const { reject } = await joinPrefetch();
    await act(async () => {
      reject({ response: { status: 403, data: { needsSudo: true } } });
    });
    expect(listCalls(child.path)).toHaveLength(1);
    expect(dialogs().sudoDialogOpen).toBe(true);
  });

  it("does not retry or publish a speculative failure after navigation moves on", async () => {
    const { reject } = await joinPrefetch();
    await act(async () => {
      await grid().onFileOpen({ ...child, path: "/elsewhere" });
    });
    await tick();
    await act(async () => {
      reject(skippedSudo);
    });
    // The API layer makes its one forced retry; the stale result is still ignored.
    expect(toolbar().currentPath).toBe("/elsewhere");
    expect(dialogs().sudoDialogOpen).toBe(false);
  });

  it("keeps prefetch paused until every overlapping foreground read finishes", async () => {
    const finish = new Map<string, (value: unknown) => void>();
    const next = { ...child, name: "next", path: "/next" };
    const predicted = { ...child, name: "predicted", path: "/next/predicted" };
    mocks.get.mockImplementation(async (_url, { params }) => {
      if (params.path === child.path || params.path === next.path) {
        return new Promise((resolve) => {
          finish.set(params.path, resolve);
        });
      }
      return {
        data: {
          path: params.path,
          files: params.path === "/home/alice" ? [child] : [],
        },
      };
    });
    render(
      <FileManager initialHost={host} initialPath="/home/alice" compact />,
    );
    await tick();
    await tick();
    await act(async () => {
      await grid().onFileOpen(child);
    });
    await tick();
    await act(async () => {
      await grid().onFileOpen(next);
    });
    await tick();
    expect(finish.size).toBe(2);
    await act(async () => {
      finish.get(child.path)!({ data: { path: child.path, files: [] } });
    });
    expect(grid().onFileIntent).toBeTypeOf("function");
    act(() => {
      grid().onFileIntent?.(predicted);
    });
    await tick(201);
    expect(listCalls(predicted.path)).toHaveLength(0);
    await act(async () => {
      finish.get(next.path)!({ data: { path: next.path, files: [predicted] } });
    });
    await tick(201);
    expect(listCalls(predicted.path)).toHaveLength(1);
    expect(listCalls(predicted.path)[0][1].params.prefetch).toBe("true");
  });

  it("explicit refresh bypasses a fresh snapshot and still forces the backend", async () => {
    render(
      <FileManager initialHost={host} initialPath="/home/alice" compact />,
    );
    await tick();
    await act(async () => {
      toolbar().handleRefreshDirectory();
    });
    expect(listCalls("/home/alice")).toHaveLength(2);
    expect(listCalls("/home/alice")[1][1].params).toMatchObject({
      force: true,
    });
    expect(listCalls("/home/alice")[1][1].params).not.toHaveProperty(
      "prefetch",
    );
  });
});
