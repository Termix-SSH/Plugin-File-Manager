// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const download = vi.fn();
vi.mock("../../../src/frontend/api/ssh-file-operations-api", () => ({
  downloadSSHFile: (...args: unknown[]) => download(...args),
}));

import { useNativeDragOut } from "../../../src/frontend/hooks/useNativeDragOut";

const file = (name: string, size = 10) => ({
  name,
  path: `/tmp/${name}`,
  type: "file" as const,
  size,
});

describe("useNativeDragOut", () => {
  const api = {
    isElectron: true,
    createTempFile: vi.fn(),
    cleanupTempFile: vi.fn(),
    startDragFiles: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    download.mockResolvedValue({ content: "YQ==" });
    api.createTempFile.mockResolvedValue({ success: true, tempId: "t1" });
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
  });

  it("does not start before the file is ready", () => {
    const { result } = renderHook(() => useNativeDragOut("s1"));
    expect(result.current.start([file("a.txt")])).toBe(false);
    expect(api.startDragFiles).not.toHaveBeenCalled();
  });

  it("starts a native drag once prefetched", async () => {
    const { result } = renderHook(() => useNativeDragOut("s1"));
    act(() => result.current.prefetch([file("a.txt")]));
    await waitFor(() => expect(api.createTempFile).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.start([file("a.txt")])).toBe(true),
    );
    expect(api.startDragFiles).toHaveBeenCalledWith(["t1"]);
  });

  it("skips folders and files over the size cap", () => {
    const { result } = renderHook(() => useNativeDragOut("s1"));
    act(() =>
      result.current.prefetch([
        { ...file("d"), type: "directory" as const },
        file("big.bin", 60 * 1024 * 1024),
      ]),
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("does nothing in a browser", () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = undefined;
    const { result } = renderHook(() => useNativeDragOut("s1"));
    act(() => result.current.prefetch([file("a.txt")]));
    expect(download).not.toHaveBeenCalled();
    expect(result.current.start([file("a.txt")])).toBe(false);
  });
});
