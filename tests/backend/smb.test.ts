import { describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import {
  entryName,
  smbError,
  smbProtocol,
  toItem,
} from "../../src/backend/remote-fs/smb.js";
import { manifest } from "./helpers.js";

describe("smb", () => {
  it("strips the ./ node-smb2 puts on names", () => {
    expect(entryName("./moved.txt")).toBe("moved.txt");
    expect(entryName(".hidden")).toBe(".hidden");
    expect(entryName("./a/b.txt")).toBe("b.txt");
  });

  it("turns entries into list rows", () => {
    const when = new Date("2026-11-20T10:00:00Z");
    expect(
      toItem(
        {
          filename: "./report.pdf",
          type: "File",
          fileSize: 1234n,
          lastWriteTime: when,
          fileAttributes: ["ReadOnly"],
        } as never,
        "/docs",
      ),
    ).toMatchObject({
      name: "report.pdf",
      type: "file",
      size: 1234,
      path: "/docs/report.pdf",
      permissions: "-r--r--r--",
      modifiedTimestamp: Math.floor(when.getTime() / 1000),
    });
    expect(
      toItem(
        {
          filename: "./photos",
          type: "Directory",
          fileSize: 0n,
          lastWriteTime: when,
          fileAttributes: ["Directory"],
        } as never,
        "/",
      ),
    ).toMatchObject({ type: "directory", size: undefined, path: "/photos" });
  });

  it("says what an NT status means", () => {
    expect(
      smbError({ header: { status: 0xc000006d } }, "connect").message,
    ).toBe("Could not connect: the login was refused");
    expect(
      smbError({ header: { status: 0xc00000cc } }, "connect").message,
    ).toMatch(/share does not exist/);
    expect(smbError({ header: { status: 0xdeadbeef } }, "read").message).toBe(
      "Could not read: status 0xdeadbeef",
    );
    const own = new Error("socket closed");
    expect(smbError(own, "read")).toBe(own);
  });

  it("needs a share name before it connects", async () => {
    const mock = createMockCtx({ pluginId: manifest.id, manifest });
    const settings = await smbProtocol.readSettings(mock.ctx, 7);
    expect(settings).toEqual({ port: 445, share: "", domain: "WORKGROUP" });
    await expect(
      smbProtocol.connect({} as never, { ...settings, share: "a/b" }),
    ).rejects.toThrow(/share name/);
  });
});
