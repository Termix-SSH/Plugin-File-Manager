import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import { SudoPasswordDialog } from "../../src/frontend/SudoPasswordDialog";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("SudoPasswordDialog", () => {
  it("can be submitted again after a wrong password", async () => {
    let finish!: () => void;
    const onSubmit = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    render(
      <SurfaceScope>
        <SudoPasswordDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />
      </SurfaceScope>,
    );
    fireEvent.change(screen.getByPlaceholderText("fileManager.sudoPassword"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));
    expect(onSubmit).toHaveBeenCalledWith("wrong");
    expect(
      screen.getByRole("button", { name: "common.loading" }),
    ).toBeDisabled();

    finish();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "common.confirm" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByPlaceholderText("fileManager.sudoPassword"),
    ).toBeEnabled();
  });
});
