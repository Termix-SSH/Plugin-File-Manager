import { describe, expect, it } from "vitest";
import {
  canBrowseFiles,
  canOpenFiles,
  ftpEnabled,
  usesFtp,
} from "../../src/frontend/host-settings";

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

describe("ftp hosts", () => {
  const ftp = { "file-manager": { enableFtp: true } };

  it("uses FTP when the host has no SFTP files", () => {
    expect(usesFtp({ enableSsh: false, pluginSettings: ftp })).toBe(true);
    expect(canOpenFiles({ enableSsh: false, pluginSettings: ftp })).toBe(true);
    expect(canBrowseFiles({ enableSsh: false, pluginSettings: ftp })).toBe(
      false,
    );
  });

  it("keeps SFTP when SSH files are on", () => {
    expect(usesFtp({ enableSsh: true, pluginSettings: ftp })).toBe(false);
  });

  it("stays closed without FTP or SSH", () => {
    expect(canOpenFiles({ enableSsh: false })).toBe(false);
    expect(ftpEnabled(null)).toBe(false);
  });
});
