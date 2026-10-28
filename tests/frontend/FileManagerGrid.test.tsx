import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FileManagerGrid } from "../../src/frontend/FileManagerGrid";
import type { FileItem } from "../../src/frontend/host-types";
import { createDirectoryPrefetch } from "../../src/frontend/lib/directory-prefetch";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 29,
        size: 29,
      })),
    measureElement: () => {},
    measure: () => {},
  }),
}));

const file: FileItem = {
  name: "notes.txt",
  path: "/notes.txt",
  type: "file",
  modified: "2026-09-01",
  owner: "owner",
  permissions: "-rw-r--r--",
};
const props = {
  files: [file],
  selectedFiles: [file],
  viewMode: "list" as const,
  onFileOpen: vi.fn(),
  onSelectionChange: vi.fn(),
  onRefresh: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("remote file rename", () => {
  it.each(["F2", "F6"])("starts rename with %s in the visible pane", (key) => {
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      document.body,
    );
    const onStartEdit = vi.fn();
    render(<FileManagerGrid {...props} onStartEdit={onStartEdit} />);
    fireEvent.keyDown(document, { key });
    expect(onStartEdit).toHaveBeenCalledExactlyOnceWith(file);
  });

  it("does not rename files in a hidden pane", () => {
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      null,
    );
    const onStartEdit = vi.fn();
    render(<FileManagerGrid {...props} onStartEdit={onStartEdit} />);
    fireEvent.keyDown(document, { key: "F2" });
    expect(onStartEdit).not.toHaveBeenCalled();
  });

  it("hides metadata while editing and commits the new name", () => {
    const onRename = vi.fn();
    const { rerender } = render(<FileManagerGrid {...props} />);
    expect(screen.getByText(file.modified!)).toBeInTheDocument();
    rerender(
      <FileManagerGrid
        {...props}
        density="compact"
        editingFile={file}
        onRename={onRename}
      />,
    );
    expect(screen.queryByText(file.modified!)).not.toBeInTheDocument();
    expect(screen.queryByText(file.permissions!)).not.toBeInTheDocument();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "renamed.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(file, "renamed.txt");
    rerender(<FileManagerGrid {...props} />);
    expect(screen.getByText(file.modified!)).toBeInTheDocument();
  });

  it("does not open the file when Enter confirms a rename", () => {
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      document.body,
    );
    const onFileOpen = vi.fn();
    const onRename = vi.fn();
    render(
      <FileManagerGrid
        {...props}
        onFileOpen={onFileOpen}
        editingFile={file}
        onRename={onRename}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "renamed.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(file, "renamed.txt");
    expect(onFileOpen).not.toHaveBeenCalled();
  });
});

describe("external file drops", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  it.each(["list", "grid"] as const)(
    "uploads dropped folders over a file in %s view",
    (viewMode) => {
      const onUploadItems = vi.fn();
      render(
        <FileManagerGrid
          {...props}
          viewMode={viewMode}
          onUploadItems={onUploadItems}
        />,
      );
      const folder = {
        name: "logs",
        isDirectory: true,
        isFile: false,
      } as FileSystemEntry;
      fireEvent.drop(screen.getByText(file.name), {
        dataTransfer: {
          types: ["Files"],
          files: [],
          getData: () => "",
          items: [{ webkitGetAsEntry: () => folder }],
        },
      });
      expect(onUploadItems).toHaveBeenCalledExactlyOnceWith([folder]);
    },
  );

  it("uploads a plain OS file dropped over a row", () => {
    const onUpload = vi.fn();
    render(<FileManagerGrid {...props} onUpload={onUpload} />);
    const files = [new File(["log"], "app.log")];
    fireEvent.drop(screen.getByText(file.name), {
      dataTransfer: { types: ["Files"], files, items: [], getData: () => "" },
    });
    expect(onUpload).toHaveBeenCalledExactlyOnceWith(files);
  });
});

describe("directory prefetch intent", () => {
  const folder: FileItem = {
    name: "folder",
    path: "/folder",
    type: "directory",
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.useRealTimers());

  it.each(["list", "grid"] as const)(
    "waits for deliberate directory hover and cancels on leave in %s view",
    async (viewMode) => {
      const read = vi.fn(async (_path: string) => undefined);
      const scheduler = createDirectoryPrefetch({
        read,
        isCached: () => false,
        run: (task) => {
          void task();
          return true;
        },
      });
      const onFileIntent = vi.fn();
      const { container } = render(
        <FileManagerGrid
          {...props}
          files={[folder, file]}
          selectedFiles={[]}
          viewMode={viewMode}
          onFileIntent={onFileIntent}
          onDirectoryHover={(entry) => scheduler.hover(entry.path)}
          onDirectoryLeave={(entry) => scheduler.cancelIntent(entry.path)}
        />,
      );
      const row = container.querySelector('[data-file-path="/folder"]')!;
      fireEvent.mouseEnter(row);
      await vi.advanceTimersByTimeAsync(50);
      fireEvent.mouseLeave(row);
      await vi.advanceTimersByTimeAsync(200);
      expect(read).not.toHaveBeenCalled();
      fireEvent.mouseEnter(row);
      await vi.advanceTimersByTimeAsync(99);
      expect(read).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledExactlyOnceWith(folder.path);
      expect(onFileIntent).not.toHaveBeenCalled();
      fireEvent.mouseEnter(
        container.querySelector('[data-file-path="/notes.txt"]')!,
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(read).toHaveBeenCalledTimes(1);
      scheduler.dispose();
    },
  );

  it("prefetches a keyboard-focused selection, keeps Enter-to-open, and adds no arrow navigation", () => {
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
      document.body,
    );
    const onFileIntent = vi.fn();
    const onFileOpen = vi.fn();
    const onSelectionChange = vi.fn();
    const { container, rerender } = render(
      <FileManagerGrid
        {...props}
        files={[folder]}
        selectedFiles={[folder]}
        onFileIntent={onFileIntent}
        onFileOpen={onFileOpen}
        onSelectionChange={onSelectionChange}
      />,
    );
    const grid = container.querySelector<HTMLElement>('[tabindex="0"]')!;
    act(() => grid.focus());
    expect(onFileIntent).toHaveBeenCalledExactlyOnceWith(folder);
    const next = { ...folder, path: "/next", name: "next" };
    rerender(
      <FileManagerGrid
        {...props}
        files={[next]}
        selectedFiles={[next]}
        onFileIntent={onFileIntent}
        onFileOpen={onFileOpen}
        onSelectionChange={onSelectionChange}
      />,
    );
    expect(onFileIntent).toHaveBeenLastCalledWith(next);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onFileOpen).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("keeps click content prefetch and does not prefetch an old selection during pointer focus", () => {
    const onFileIntent = vi.fn();
    render(
      <FileManagerGrid
        {...props}
        files={[folder, file]}
        selectedFiles={[folder]}
        onFileIntent={onFileIntent}
      />,
    );
    fireEvent.click(screen.getByText(file.name));
    expect(onFileIntent).toHaveBeenCalledExactlyOnceWith(file);
  });
});
