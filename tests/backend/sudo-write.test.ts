import { describe, expect, it, vi } from "vitest";
import {
  SUDO_INLINE_MAX_BYTES,
  sudoWriteViaTempFile,
} from "../../src/backend/content-routes.js";
import type { SSHSession } from "../../src/backend/session.js";

const { getSessionSftp, execWithSudo } = vi.hoisted(() => ({
  getSessionSftp: vi.fn(),
  execWithSudo: vi.fn(),
}));
vi.mock("../../src/backend/session.js", () => ({
  getSessionSftp,
  execWithSudo,
}));

function fakeSftp() {
  return {
    writeFile: vi.fn((_p, _d, _o, done: (err?: Error) => void) => done()),
    unlink: vi.fn((_p, done: () => void) => done()),
  };
}

const session = {} as SSHSession;
const big = Buffer.alloc(SUDO_INLINE_MAX_BYTES + 1, 1);

describe("sudoWriteViaTempFile", () => {
  it("uploads a private temp file, copies it with sudo and removes it", async () => {
    const sftp = fakeSftp();
    getSessionSftp.mockResolvedValue(sftp);
    execWithSudo.mockResolvedValue({ stdout: "SUCCESS\n", code: 0 });

    expect(
      await sudoWriteViaTempFile(session, big, "/etc/it's $(x)", "pw"),
    ).toBe(true);

    const [tempPath, data, options] = sftp.writeFile.mock.calls[0];
    expect(tempPath).toMatch(/^\/tmp\/termix-save-/);
    expect(data).toBe(big);
    expect(options).toEqual({ mode: 0o600, flag: "wx" });
    const command = execWithSudo.mock.calls[0][1] as string;
    expect(command.startsWith("sh -c '")).toBe(true);
    expect(command).not.toContain(big.toString("base64").slice(0, 32));
    expect(sftp.unlink).toHaveBeenCalledWith(tempPath, expect.any(Function));
  });

  it("removes the temp file even when sudo fails", async () => {
    const sftp = fakeSftp();
    getSessionSftp.mockResolvedValue(sftp);
    execWithSudo.mockRejectedValue(new Error("boom"));

    await expect(
      sudoWriteViaTempFile(session, big, "/etc/x", "pw"),
    ).rejects.toThrow("boom");
    expect(sftp.unlink).toHaveBeenCalledOnce();
  });

  it("reports failure when the copy does not succeed", async () => {
    getSessionSftp.mockResolvedValue(fakeSftp());
    execWithSudo.mockResolvedValue({ stdout: "denied", code: 1 });
    expect(await sudoWriteViaTempFile(session, big, "/etc/x", "pw")).toBe(
      false,
    );
  });
});
