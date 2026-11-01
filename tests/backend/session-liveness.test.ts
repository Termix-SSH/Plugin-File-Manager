import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelOpenSerializer,
  ensureSessionAlive,
  SessionLostError,
  type SSHSession,
} from "../../src/backend/session";

afterEach(() => vi.useRealTimers());

function session(realpath: unknown): SSHSession {
  return {
    client: { destroy: vi.fn() },
    isConnected: true,
    lastActive: 0,
    activeOperations: 0,
    channelOpener: new ChannelOpenSerializer(),
    sftp: { realpath },
  } as unknown as SSHSession;
}

describe("ensureSessionAlive", () => {
  it("passes when the host answers", async () => {
    const s = session((_p: string, cb: (e?: Error) => void) => cb());
    await expect(ensureSessionAlive(s)).resolves.toBeUndefined();
    expect(s.isConnected).toBe(true);
  });

  it("marks the session lost when the host stays silent", async () => {
    const s = session(() => {});
    await expect(ensureSessionAlive(s, 10)).rejects.toBeInstanceOf(
      SessionLostError,
    );
    expect(s.isConnected).toBe(false);
    expect(s.sftp).toBeUndefined();
    expect(s.client.destroy).toHaveBeenCalledOnce();
  });

  it("leaves other SFTP errors to the caller", async () => {
    const s = session((_p: string, cb: (e?: Error) => void) =>
      cb(new Error("denied")),
    );
    await expect(ensureSessionAlive(s)).resolves.toBeUndefined();
    expect(s.isConnected).toBe(true);
  });
});

describe("ChannelOpenSerializer", () => {
  it("lets the next open run after one never finishes", async () => {
    vi.useFakeTimers();
    const opener = new ChannelOpenSerializer();
    const stuck = opener.run(() => new Promise(() => {}));
    const next = opener.run(async () => "open");
    const failed = expect(stuck).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    await expect(next).resolves.toBe("open");
  });
});
