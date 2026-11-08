import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FileWindow } from "../../../src/frontend/components/FileWindow";
import type { FileItem, SSHHost } from "../../../src/frontend/host-types";

const api = vi.hoisted(() => ({
  downloadSSHFileStream: vi.fn(),
  readSSHFile: vi.fn(),
  getSSHStatus: vi.fn(async () => ({ connected: true })),
  connectSSH: vi.fn(),
  writeSSHFile: vi.fn(),
  setSudoPassword: vi.fn(),
}));
vi.mock("../../../src/frontend/api/ssh-file-operations-api", () => api);
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../../src/frontend/components/WindowManager", () => ({
  useWindowManager: () => ({
    windows: [{ id: "w" }],
    closeWindow: vi.fn(),
    maximizeWindow: vi.fn(),
    focusWindow: vi.fn(),
  }),
}));
vi.mock("../../../src/frontend/components/DraggableWindow", () => ({
  DraggableWindow: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("../../../src/frontend/SudoPasswordDialog", () => ({
  SudoPasswordDialog: () => null,
}));

interface ViewerProps {
  content: string;
  savedContent: string;
  onContentChange: (value: string) => void;
}
let viewer: ViewerProps | null = null;
vi.mock("../../../src/frontend/components/FileViewer", () => ({
  FileViewer: (props: ViewerProps) => {
    viewer = props;
    return null;
  },
}));

const file: FileItem = { name: "notes.txt", path: "/notes.txt", type: "file" };
const host = { id: 1, name: "host", ip: "127.0.0.1", port: 22 } as SSHHost;

beforeEach(() => {
  vi.clearAllMocks();
  viewer = null;
  api.readSSHFile.mockResolvedValue({ content: "hello", encoding: "utf8" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function open() {
  render(
    <FileWindow
      windowId="w"
      file={{ ...file }}
      sshSessionId="s"
      sshHost={host}
    />,
  );
  await waitFor(() => expect(viewer?.savedContent).toBe("hello"));
}

describe("FileWindow", () => {
  it("treats an emptied file as a change", async () => {
    await open();
    act(() => viewer!.onContentChange(""));
    expect(viewer!.content).toBe("");
    expect(viewer!.savedContent).toBe("hello");
  });

  it("shows base64 text files as text", async () => {
    api.readSSHFile.mockResolvedValue({
      content: btoa("hello"),
      encoding: "base64",
    });
    await open();
    expect(viewer!.content).toBe("hello");
  });

  it("does not report an auto save that failed", async () => {
    await open();
    vi.useFakeTimers();
    api.writeSSHFile.mockRejectedValueOnce(new Error("disk full"));
    act(() => viewer!.onContentChange("changed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
