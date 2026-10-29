import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listSSHFiles: vi.fn(),
}));

vi.mock("../../src/frontend/api/ssh-file-operations-api", () => ({
  listSSHFiles: mocks.listSSHFiles,
}));
vi.mock("../../src/frontend/api/file-manager-data-api", () => ({
  getRecentFiles: async () => [],
  getPinnedFiles: async () => [],
  getFolderShortcuts: async () => [],
  removeRecentFile: vi.fn(),
  removePinnedFile: vi.fn(),
  removeFolderShortcut: vi.fn(),
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConfirm: () => vi.fn(),
}));

const { FileManagerSidebar } =
  await import("../../src/frontend/FileManagerSidebar");

const dir = (name: string) => ({
  name,
  path: `/${name}`,
  type: "directory",
});

afterEach(cleanup);

describe("FileManagerSidebar", () => {
  it("drops a deleted folder from the tree on refresh", async () => {
    mocks.listSSHFiles.mockResolvedValue({ files: [dir("keep"), dir("gone")] });
    const props = {
      currentHost: { id: 1, name: "h", ip: "h" } as never,
      currentPath: "/",
      onPathChange: vi.fn(),
      sshSessionId: "s1",
    };
    const view = render(<FileManagerSidebar {...props} refreshTrigger={0} />);
    expect(await screen.findByText("gone")).toBeTruthy();

    mocks.listSSHFiles.mockResolvedValue({ files: [dir("keep")] });
    view.rerender(<FileManagerSidebar {...props} refreshTrigger={1} />);
    await waitFor(() => expect(screen.queryByText("gone")).toBeNull());
    expect(screen.getByText("keep")).toBeTruthy();
  });
});
