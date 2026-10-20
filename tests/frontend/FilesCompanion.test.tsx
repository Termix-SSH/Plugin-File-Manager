import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CompanionProps } from "@termix-ssh/plugin-sdk/frontend";
import { FilesCompanion } from "../../src/frontend/FilesCompanion";

const fileManager = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/frontend/FileManager.tsx", () => ({
  FileManager: (props: Record<string, unknown>) => {
    fileManager.props.push(props);
    return <div data-testid="file-manager" />;
  },
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
  useSettings: () => ({
    values: { companionSyncInterval: 1, companionFollowTerminal: true },
  }),
}));

function setup(handle: Record<string, unknown> | null) {
  const props = {
    tab: { id: "t1", type: "terminal", label: "box" },
    host: { id: 7 },
    sshHost: { id: 7 },
    getHandle: () => handle,
    side: "right",
    isVisible: true,
    close: vi.fn(),
    setSide: vi.fn(),
  } as unknown as CompanionProps;
  return render(<FilesCompanion {...props} />);
}

const lastProps = () => fileManager.props[fileManager.props.length - 1];

describe("FilesCompanion", () => {
  beforeEach(() => {
    fileManager.props.length = 0;
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("opens in the terminal folder", async () => {
    setup({ getCwd: vi.fn().mockResolvedValue("/var/www") });
    await waitFor(() =>
      expect(screen.getByTestId("file-manager")).toBeTruthy(),
    );
    expect(lastProps().initialPath).toBe("/var/www");
    expect(lastProps().compact).toBe(true);
  });

  it("still opens when there is no terminal folder", async () => {
    setup(null);
    await waitFor(() =>
      expect(screen.getByTestId("file-manager")).toBeTruthy(),
    );
    expect(lastProps().initialPath).toBeUndefined();
  });

  it("follows the terminal when its folder changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getCwd = vi.fn().mockResolvedValueOnce("/a").mockResolvedValue("/b");
    setup({ getCwd });
    await waitFor(() =>
      expect(screen.getByTestId("file-manager")).toBeTruthy(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(lastProps().externalPath).toMatchObject({ path: "/b" });
  });

  it("sends a quoted cd to the terminal for the current folder", async () => {
    const sendInput = vi.fn();
    setup({ getCwd: vi.fn().mockResolvedValue("/a"), sendInput });
    await waitFor(() =>
      expect(screen.getByTestId("file-manager")).toBeTruthy(),
    );
    act(() => {
      (lastProps().onPathChange as (path: string) => void)("/it's");
    });
    fireEvent.click(screen.getByTitle("companion.cdTerminal"));
    expect(sendInput).toHaveBeenCalledWith("cd '/it'\\''s'\r");
  });

  it("hides the terminal controls without a terminal", async () => {
    setup(null);
    await waitFor(() =>
      expect(screen.getByTestId("file-manager")).toBeTruthy(),
    );
    expect(screen.queryByTitle("companion.syncNow")).toBeNull();
  });
});
