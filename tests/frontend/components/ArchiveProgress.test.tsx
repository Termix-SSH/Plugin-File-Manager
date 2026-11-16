import { cleanup, render, screen } from "@testing-library/react";
import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";
import { afterEach, describe, expect, it } from "vitest";

import { ArchiveProgress } from "../../../src/frontend/components/ArchiveProgress";

afterEach(cleanup);

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as TranslateFn;

describe("ArchiveProgress", () => {
  it("draws nothing when no archive is extracting", () => {
    const { container } = render(<ArchiveProgress items={[]} t={t} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a percentage when the total is known", () => {
    render(
      <ArchiveProgress
        items={[{ id: "1", name: "a.zip", extracted: 30, total: 120 }]}
        t={t}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "25",
    );
    expect(
      screen.getByText(
        'fileManager.extractProgressOf {"extracted":30,"total":120}',
      ),
    ).toBeTruthy();
  });

  it("shows a running count without a percentage when the total is unknown", () => {
    render(
      <ArchiveProgress
        items={[{ id: "1", name: "a.tar.gz", extracted: 7 }]}
        t={t}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-busy")).toBe("true");
    expect(
      screen.getByText('fileManager.extractProgressCount {"count":7}'),
    ).toBeTruthy();
  });

  it("shows only the moving bar for formats that report no count", () => {
    render(<ArchiveProgress items={[{ id: "1", name: "a.7z" }]} t={t} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByText(/extractProgress/)).toBeNull();
  });

  it("replaces the bar with the error when an extraction fails", () => {
    render(
      <ArchiveProgress
        items={[{ id: "1", name: "a.zip", error: "bad zipfile" }]}
        t={t}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("bad zipfile");
  });
});
