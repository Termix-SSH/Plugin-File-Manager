import { describe, expect, it } from "vitest";
import { canBrowseFiles } from "../../src/frontend/host-settings";

describe("canBrowseFiles", () => {
  it("needs SSH and the plugin turned on for the host", () => {
    expect(canBrowseFiles({ enableSsh: true })).toBe(true);
    expect(canBrowseFiles({ enableSsh: false, connectionType: "telnet" })).toBe(
      false,
    );
    expect(
      canBrowseFiles({
        enableSsh: true,
        pluginSettings: { "file-manager": { enableFileManager: false } },
      }),
    ).toBe(false);
    expect(canBrowseFiles(null)).toBe(false);
  });
});
