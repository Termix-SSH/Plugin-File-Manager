import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHSession } from "../../src/backend/session.js";

const s = vi.hoisted(() => ({ execBuffer: vi.fn(), execWithSudo: vi.fn() }));
vi.mock("../../src/backend/session.js", () => s);
import {
  isRemovablePath,
  removePermanently,
} from "../../src/backend/permanent-delete.js";

const NL = String.fromCharCode(10);
// Echo the nonce the script embeds, mapping each index to a status.
const reply = (statuses: string[]) => (_s: unknown, command: string) => {
  const nonce = /([0-9a-f-]{36}) OK 0/.exec(command)![1];
  return Promise.resolve({
    stdout: Buffer.from(
      statuses.map((v, i) => nonce + " " + v + " " + i).join(NL),
    ),
    stderr: "",
    code: 0,
  });
};
const item = (path: string, isDirectory = false) => ({ path, isDirectory });
const session = (sudoPassword?: string) =>
  ({ sudoPassword }) as unknown as SSHSession;

describe("removePermanently", () => {
  beforeEach(() => {
    s.execBuffer.mockReset();
    s.execWithSudo.mockReset();
  });

  it("refuses roots and dot segments, including Windows aliases", async () => {
    for (const p of ["/", "/..", "C:/../", "C:/folder/../../", "/a/./b", ""])
      expect(isRemovablePath(p)).toBe(false);
    expect(isRemovablePath("/a/b")).toBe(true);
    const r = await removePermanently(session(), [item("/"), item("C:/../")]);
    expect(r.every((x) => x.error)).toBe(true);
    expect(s.execBuffer).not.toHaveBeenCalled();
  });

  it("batches into one command, uses rm -f for files and rm -rf for directories", async () => {
    s.execBuffer.mockImplementation(reply(["OK", "FAIL", "OK"]));
    const r = await removePermanently(session(), [
      item("/a"),
      item("/b"),
      item("/c", true),
    ]);
    expect(s.execBuffer).toHaveBeenCalledTimes(1);
    const cmd = s.execBuffer.mock.calls[0][1] as string;
    expect(cmd).toContain("rm -f -- ");
    expect(cmd).toContain("rm -rf -- ");
    expect(r.map((x) => !!x.error)).toEqual([false, true, false]);
  });

  it("ignores status lines without the nonce (forged output)", async () => {
    s.execBuffer.mockResolvedValue({
      stdout: Buffer.from("OK 0" + NL),
      stderr: "OK 0",
      code: 0,
    });
    const r = await removePermanently(session(), [item("/a")]);
    expect(r[0].error).toBe("Delete failed");
  });

  it("retries only denied paths with sudo; flags needsSudo without a password", async () => {
    s.execBuffer.mockImplementation(reply(["OK", "DENIED", "FAIL"]));
    s.execWithSudo.mockImplementation(reply(["OK"]));
    const r = await removePermanently(session("pw"), [
      item("/a"),
      item("/b"),
      item("/c"),
    ]);
    expect(s.execWithSudo).toHaveBeenCalledTimes(1);
    expect(s.execWithSudo.mock.calls[0][1]).not.toContain("/c");
    expect(r.map((x) => x.error)).toEqual([
      undefined,
      undefined,
      "Delete failed",
    ]);
    s.execBuffer.mockImplementation(reply(["OK", "DENIED"]));
    const r2 = await removePermanently(session(), [item("/a"), item("/b")]);
    expect(r2[1]).toMatchObject({
      error: "Permission denied",
      needsSudo: true,
    });
  });

  it("does not start sudo after cancel and reports Cancelled", async () => {
    let stopped = false;
    s.execBuffer.mockImplementation(async (...a: [unknown, string]) => {
      stopped = true;
      return reply(["DENIED"])(...a);
    });
    const r = await removePermanently(
      session("pw"),
      [item("/a")],
      () => stopped,
    );
    expect(s.execWithSudo).not.toHaveBeenCalled();
    expect(r[0].error).toBe("Cancelled");
    const r2 = await removePermanently(session(), [item("/a")], () => true);
    expect(r2[0].error).toBe("Cancelled");
  });

  it("classifies denial by rm's error suffix, not by file names", async () => {
    s.execBuffer.mockImplementation(async (_s: unknown, command: string) => {
      expect(command).toContain('grep -q ": Permission denied$"');
      expect(command).toContain("LC_ALL=C");
      return reply(["FAIL"])(_s, command);
    });
    const r = await removePermanently(session("pw"), [
      item("/tmp/Permission denied"),
    ]);
    expect(s.execWithSudo).not.toHaveBeenCalled();
    expect(r[0].error).toBe("Delete failed");
  });
});
