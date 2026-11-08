import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { HOST_PROTOCOL_SECRET_KEPT } from "@termix-ssh/plugin-sdk/frontend";
import { FtpHostSection } from "../../src/frontend/FtpHostSection";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function renderSection() {
  const updateForm = vi.fn();
  const form = {
    pluginSettings: { "file-manager": { enableFtp: true } },
    protocolAuth: {
      ftp: {
        authType: "direct",
        credentialId: "",
        username: "bob",
        password: HOST_PROTOCOL_SECRET_KEPT,
        fields: {},
      },
    },
  };
  render(
    <FtpHostSection
      form={form}
      setField={vi.fn()}
      updateForm={updateForm}
      protocols={{ enableFtp: true }}
    />,
  );
  return { updateForm, form };
}

describe("FtpHostSection", () => {
  it("keeps the saved password when the field is only focused", () => {
    const { updateForm } = renderSection();
    const input = screen.getByPlaceholderText("ftp.passwordSaved");
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(updateForm).not.toHaveBeenCalled();
  });

  it("replaces the saved password once something is typed", () => {
    const { updateForm, form } = renderSection();
    fireEvent.change(screen.getByPlaceholderText("ftp.passwordSaved"), {
      target: { value: "new-secret" },
    });
    const next = updateForm.mock.calls[0][0](form);
    expect(next.protocolAuth.ftp.password).toBe("new-secret");
  });
});
