import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NameConflictDialog } from "../../../src/frontend/components/NameConflictDialog";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}: ${values.name}` : key,
  }),
}));
afterEach(cleanup);

describe("NameConflictDialog", () => {
  it.each(["overwrite", "skip", "keep-both"])(
    "returns an explicit %s choice with apply-to-all",
    (action) => {
      const onResolve = vi.fn();
      render(
        <NameConflictDialog
          conflict={{ name: "a.txt", remaining: 2 }}
          onResolve={onResolve}
        />,
      );
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(
        screen.getByText("fileManager.nameConflictDescription: a.txt"),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: "fileManager.conflictApplyToAll",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: `fileManager.conflict-${action}` }),
      );
      expect(onResolve).toHaveBeenCalledExactlyOnceWith({
        action,
        applyToAll: true,
      });
    },
  );

  it("hides apply-to-all for the last conflict and defaults to one item", () => {
    const onResolve = vi.fn();
    render(
      <NameConflictDialog
        conflict={{ name: "a", remaining: 1 }}
        onResolve={onResolve}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "fileManager.conflict-overwrite" }),
    );
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({
      action: "overwrite",
      applyToAll: false,
    });
  });

  it("cancels instead of choosing overwrite", () => {
    const onResolve = vi.fn();
    render(
      <NameConflictDialog
        conflict={{ name: "a", remaining: 1 }}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("cancels with Escape and backdrop dismissal, and keeps Tab inside the prompt", () => {
    const onResolve = vi.fn();
    render(
      <NameConflictDialog
        conflict={{ name: "a", remaining: 1 }}
        onResolve={onResolve}
      />,
    );
    const first = screen.getByRole("button", { name: "common.cancel" });
    const last = screen.getByRole("button", {
      name: "fileManager.conflict-keep-both",
    });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(onResolve).toHaveBeenLastCalledWith(null);
    onResolve.mockClear();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onResolve).toHaveBeenCalledExactlyOnceWith(null);
  });
});
