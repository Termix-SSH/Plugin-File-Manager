import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { toast } from "sonner";
import type { FileItem, SSHHost } from "../../src/frontend/host-types";

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  get: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  trash: vi.fn(),
  error: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBrowser: vi.fn(),
  copyItem: vi.fn<
    typeof import("../../src/frontend/api/ssh-file-operations-api").copySSHItem
  >(async () => ({})),
  moveItem: vi.fn<
    typeof import("../../src/frontend/api/ssh-file-operations-api").moveSSHItem
  >(async () => ({})),
  uploadFile: vi.fn<
    typeof import("../../src/frontend/api/ssh-file-operations-api").uploadSSHFile
  >(async () => ({})),
  createFolder: vi.fn<
    typeof import("../../src/frontend/api/ssh-file-operations-api").createSSHFolder
  >(async () => ({})),
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
    ): React.ReactNode => null,
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
    getSSHStatus: mocks.status,
    trashSSHItems: mocks.trash,
    verifySSHTOTP: mocks.verifyTotp,
    verifySSHBrowserSignIn: mocks.verifyBrowser,
    copySSHItem: mocks.copyItem,
    moveSSHItem: mocks.moveItem,
    uploadSSHFile: mocks.uploadFile,
    createSSHFolder: mocks.createFolder,
  }),
);
vi.mock("../../src/frontend/api/file-manager-data-api", () => ({
  getPinnedFiles: async () => [],
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: mocks.t }),
  useSettings: () => ({ values: { confirmBeforeTrash: false } }),
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

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    error: mocks.error,
  },
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
  mocks.status.mockResolvedValue({ connected: true });
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
  vi.unstubAllGlobals();
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

describe("FileManager mouse history ownership", () => {
  it("routes back and forward once to the visible pane containing the target", async () => {
    mocks.toolbar.mockImplementation(({ currentPath, navigateTo }) => (
      <button onClick={() => navigateTo(`${currentPath}/child`)}>
        {currentPath}
      </button>
    ));
    const first = render(
      <FileManager initialHost={host} initialPath="/first" compact />,
    );
    const second = render(
      <FileManager
        initialHost={{ ...host, id: 902 }}
        initialPath="/second"
        compact
      />,
    );
    await tick();
    await tick();
    const firstButton = () => first.container.querySelector("button")!;
    const secondButton = () => second.container.querySelector("button")!;
    fireEvent.click(firstButton());
    fireEvent.click(secondButton());
    await tick();
    fireEvent.click(firstButton());
    await tick();
    expect(firstButton().textContent).toBe("/first/child/child");
    expect(secondButton().textContent).toBe("/second/child");
    const mouse = (target: EventTarget, type: string, button: number) => {
      const event = new MouseEvent(type, {
        button,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(mouse(firstButton(), "mouseup", 3)).toBe(true);
    expect(mouse(firstButton(), "auxclick", 3)).toBe(true);
    await tick();
    expect(firstButton().textContent).toBe("/first/child");
    expect(secondButton().textContent).toBe("/second/child");
    expect(mouse(firstButton(), "mouseup", 4)).toBe(true);
    expect(mouse(firstButton(), "auxclick", 4)).toBe(true);
    await tick();
    expect(firstButton().textContent).toBe("/first/child/child");
    first.rerender(
      <FileManager
        initialHost={host}
        initialPath="/first"
        compact
        isVisible={false}
      />,
    );
    for (const target of [firstButton(), document.body, window]) {
      for (const button of [3, 4]) {
        expect(mouse(target, "mouseup", button)).toBe(false);
        expect(mouse(target, "auxclick", button)).toBe(false);
      }
    }
    expect(mouse(secondButton(), "mouseup", 0)).toBe(false);
    expect(mouse(secondButton(), "mouseup", 3)).toBe(true);
    await tick();
    expect(firstButton().textContent).toBe("/first/child/child");
    expect(secondButton().textContent).toBe("/second");
    first.rerender(
      <FileManager initialHost={host} initialPath="/first" compact />,
    );
    expect(mouse(firstButton(), "mouseup", 3)).toBe(true);
    await tick();
    expect(firstButton().textContent).toBe("/first/child");
    const detached = firstButton();
    first.unmount();
    expect(mouse(detached, "mouseup", 3)).toBe(false);
    expect(mouse(window, "auxclick", 4)).toBe(false);
    mocks.toolbar.mockImplementation(() => null);
  });
});

describe("FileManager deletion over HTTP", () => {
  it.each([false, true])(
    "finishes deletion without randomUUID (failure=%s)",
    async (failed) => {
      const getRandomValues = crypto.getRandomValues.bind(crypto);
      vi.stubGlobal("crypto", { getRandomValues });
      mocks.status.mockResolvedValue({ connected: true });
      if (failed) mocks.trash.mockRejectedValue(new Error("Delete refused"));
      else
        mocks.trash.mockResolvedValue({
          results: [{ path: child.path, success: true }],
        });
      render(
        <FileManager initialHost={host} initialPath="/home/alice" compact />,
      );
      await tick();
      await act(async () => {
        await toolbar().handleDeleteFiles([child]);
      });
      expect(mocks.trash).toHaveBeenCalledWith(
        String(host.id),
        [child.path],
        expect.objectContaining({
          permanent: false,
          opId: expect.any(String),
        }),
      );
      expect(grid().deletingPaths?.has(child.path)).toBe(false);
      if (failed)
        expect(mocks.error).toHaveBeenCalledWith(
          "fileManager.failedToDeleteItems",
        );
    },
  );
});

describe("FileManager conflict integration", () => {
  async function start(items: FileItem[] = []) {
    mocks.get.mockImplementation(async (_url, { params }) => ({
      data: {
        path: params.path === "." ? "/home/alice" : params.path,
        files: items,
      },
    }));
    render(
      <FileManager initialHost={host} initialPath="/home/alice" compact />,
    );
    await tick();
    await tick();
    mocks.get.mockClear();
  }
  async function begin(operation: () => unknown) {
    let pending: unknown;
    await act(async () => {
      pending = operation();
    });
    return {
      finish: async () => {
        await act(async () => {
          await pending;
        });
      },
    };
  }
  const incoming = (name: string): FileItem => ({
    name,
    path: `/source/${name}`,
    type: "file",
  });
  const current = (name: string): FileItem => ({
    name,
    path: `/home/alice/${name}`,
    type: "file",
  });

  it("uses the loaded current directory for a conflict-free paste", async () => {
    await start();
    act(() => grid().onCopy!([incoming("new.txt")]));
    await act(async () => {
      await grid().onPaste!();
    });
    expect(mocks.copyItem).toHaveBeenCalledWith(
      String(host.id),
      "/source/new.txt",
      "/home/alice",
      host.id,
      undefined,
      { name: "new.txt", overwrite: false },
    );
    expect(dialogs().nameConflict).toBeNull();
    // Any subsequent listing is the existing post-operation refresh, not a preflight.
    expect(
      mocks.get.mock.calls.filter(([, c]) => !c.params.force),
    ).toHaveLength(0);
  });

  it("copies within the same directory using keep-both without prompting", async () => {
    await start([current("a.txt")]);
    act(() => grid().onCopy!([current("a.txt")]));
    await act(async () => {
      await grid().onPaste!();
    });
    expect(mocks.copyItem.mock.calls[0]?.[5]).toEqual({
      name: "a (1).txt",
      overwrite: false,
    });
    expect(dialogs().nameConflict).toBeNull();
  });

  it.each(["copy", "cut"] as const)(
    "cancels %s before any requests, even preceding nonconflicts",
    async (operation) => {
      await start([current("a")]);
      act(() =>
        (operation === "copy" ? grid().onCopy! : grid().onCut!)([
          incoming("new"),
          incoming("a"),
        ]),
      );
      const batch = await begin(() => grid().onPaste!());
      expect(dialogs().nameConflict).toMatchObject({ name: "a", remaining: 1 });
      expect(mocks.copyItem).not.toHaveBeenCalled();
      expect(mocks.moveItem).not.toHaveBeenCalled();
      act(() => dialogs().onResolveConflict(null));
      await batch.finish();
      expect(mocks.copyItem).not.toHaveBeenCalled();
      expect(mocks.moveItem).not.toHaveBeenCalled();
    },
  );

  it("lists a drag-move destination once and reuses keep-both for remaining conflicts", async () => {
    await start();
    mocks.get.mockResolvedValue({
      data: { path: "/target", files: [incoming("a"), incoming("b")] },
    });
    const batch = await begin(() =>
      grid().onFileDrop!([incoming("a"), incoming("b")], {
        name: "target",
        path: "/target",
        type: "directory",
      }),
    );
    expect(dialogs().nameConflict).toMatchObject({ name: "a", remaining: 2 });
    expect(listCalls("/target")).toHaveLength(1);
    act(() =>
      dialogs().onResolveConflict({ action: "keep-both", applyToAll: true }),
    );
    await batch.finish();
    expect(mocks.moveItem.mock.calls.map((args) => args[2])).toEqual([
      "/target/a (1)",
      "/target/b (1)",
    ]);
    expect(listCalls("/target")).toHaveLength(1);
  });

  it("passes explicit overwrite for cut paste and retains skipped clipboard items", async () => {
    await start([current("a"), current("b")]);
    act(() => grid().onCut!([incoming("a"), incoming("b")]));
    const batch = await begin(() => grid().onPaste!());
    act(() =>
      dialogs().onResolveConflict({ action: "overwrite", applyToAll: false }),
    );
    await tick();
    expect(dialogs().nameConflict).toMatchObject({ name: "b", remaining: 1 });
    act(() =>
      dialogs().onResolveConflict({ action: "skip", applyToAll: false }),
    );
    await batch.finish();
    expect(mocks.moveItem.mock.calls.map((args) => [args[1], args[5]])).toEqual(
      [["/source/a", true]],
    );
    expect(grid().hasClipboard).toBe(true);
  });

  it("renames a loose uploaded file and skips the next conflict before upload", async () => {
    await start([current("a.txt"), current("b.txt")]);
    const batch = await begin(() =>
      toolbar().handleFilesDropped([
        new File(["a"], "a.txt"),
        new File(["b"], "b.txt"),
      ] as unknown as FileList),
    );
    act(() =>
      dialogs().onResolveConflict({ action: "keep-both", applyToAll: false }),
    );
    await tick();
    act(() =>
      dialogs().onResolveConflict({ action: "skip", applyToAll: false }),
    );
    await batch.finish();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile.mock.calls[0]?.[2]).toBe("a (1).txt");
    expect(mocks.uploadFile.mock.calls[0]?.[8]).toBe(false);
  });

  it("does not let an old undo action remove an overwritten item", async () => {
    await start([current("a")]);
    act(() => grid().onCut!([incoming("new")]));
    await act(async () => {
      await grid().onPaste!();
    });
    act(() => grid().onCut!([incoming("a")]));
    const batch = await begin(() => grid().onPaste!());
    act(() =>
      dialogs().onResolveConflict({ action: "overwrite", applyToAll: false }),
    );
    await batch.finish();
    expect(mocks.moveItem).toHaveBeenCalledTimes(2);
    await act(async () => {
      await grid().onUndo!();
    });
    expect(mocks.moveItem).toHaveBeenCalledTimes(2);
  });

  it("records the actual successful move for undo after an earlier failure", async () => {
    await start();
    mocks.moveItem.mockRejectedValueOnce(new Error("cannot move a"));
    await act(async () => {
      await grid().onFileDrop!([incoming("a"), incoming("b")], {
        name: "target",
        path: "/target",
        type: "directory",
      });
    });
    expect(mocks.moveItem).toHaveBeenCalledTimes(2);
    await act(async () => {
      await grid().onUndo!();
    });
    expect(mocks.moveItem.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      "/target/b",
      "/source/b",
    ]);
  });

  it("serializes duplicate loose uploads when overwrite was explicitly selected", async () => {
    await start();
    let finishFirst!: () => void;
    mocks.uploadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({});
        }),
    );
    const batch = await begin(() =>
      toolbar().handleFilesDropped([
        new File(["a"], "a"),
        new File(["b"], "a"),
      ] as unknown as FileList),
    );
    act(() =>
      dialogs().onResolveConflict({ action: "overwrite", applyToAll: false }),
    );
    await tick();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    act(() => finishFirst());
    await batch.finish();
    expect(mocks.uploadFile.mock.calls.map((args) => args[8])).toEqual([
      false,
      true,
    ]);
  });

  it("tells the user when another operation arrives during a prompt", async () => {
    const info = vi.spyOn(toast, "info").mockReturnValue(1);
    await start([current("a")]);
    act(() => grid().onCopy!([incoming("a")]));
    const batch = await begin(() => grid().onPaste!());
    await act(async () => {
      await grid().onPaste!();
    });
    expect(info).toHaveBeenCalledWith("fileManager.conflictBusy");
    act(() => dialogs().onResolveConflict(null));
    await batch.finish();
  });

  it("cancels a pending operation when the pane navigates elsewhere", async () => {
    await start([current("a")]);
    act(() => grid().onCopy!([incoming("a")]));
    const batch = await begin(() => grid().onPaste!());
    await act(async () => {
      await grid().onFileOpen({
        name: "elsewhere",
        path: "/elsewhere",
        type: "directory",
      });
    });
    await batch.finish();
    expect(mocks.copyItem).not.toHaveBeenCalled();
    expect(dialogs().nameConflict).toBeNull();
  });
});

describe("FileManager folder upload conflicts", () => {
  function folder(name: string, children: FileSystemEntry[]): FileSystemEntry {
    let read = false;
    return {
      name,
      isDirectory: true,
      createReader: () => ({
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          resolve(read ? [] : children);
          read = true;
        },
      }),
    } as unknown as FileSystemEntry;
  }
  function fileEntry(name: string): FileSystemEntry {
    return {
      name,
      isFile: true,
      file: (resolve: (f: File) => void) =>
        resolve(new File(["contents"], name)),
    } as unknown as FileSystemEntry;
  }
  it.each(["overwrite", "keep-both", "skip"] as const)(
    "resolves only the top-level folder with %s",
    async (action) => {
      mocks.get.mockImplementation(async (_url, { params }) => ({
        data: {
          path: "/home/alice",
          files: [
            { name: "folder", path: "/home/alice/folder", type: "directory" },
          ],
        },
      }));
      render(
        <FileManager initialHost={host} initialPath="/home/alice" compact />,
      );
      await tick();
      await tick();
      let operation: unknown;
      await act(async () => {
        operation = grid().onUploadItems!([
          folder("folder", [fileEntry("a.txt"), folder("empty", [])]),
        ]);
      });
      expect(dialogs().nameConflict).toMatchObject({
        name: "folder",
        remaining: 1,
      });
      expect(mocks.createFolder).not.toHaveBeenCalled();
      expect(mocks.uploadFile).not.toHaveBeenCalled();
      act(() => dialogs().onResolveConflict({ action, applyToAll: false }));
      await act(async () => {
        await operation;
      });
      if (action === "skip") {
        expect(mocks.createFolder).not.toHaveBeenCalled();
        expect(mocks.uploadFile).not.toHaveBeenCalled();
      } else {
        const root = action === "keep-both" ? "folder (1)" : "folder";
        expect(
          mocks.createFolder.mock.calls.map((args) => [args[1], args[2]]),
        ).toEqual([
          ["/home/alice/", root],
          [`/home/alice/${root}/`, "empty"],
        ]);
        expect(mocks.uploadFile.mock.calls[0]?.[1]).toBe(
          `/home/alice/${root}/`,
        );
        expect(mocks.uploadFile.mock.calls[0]?.[2]).toBe("a.txt");
        expect(mocks.uploadFile.mock.calls[0]?.[8]).toBe(
          action === "overwrite",
        );
        // The dropped-into folder is the root nothing below may link out of.
        expect(mocks.uploadFile.mock.calls[0]?.[9]).toBe("/home/alice");
        expect(mocks.createFolder.mock.calls[0]?.[5]).toBe("/home/alice");
      }
    },
  );
});
