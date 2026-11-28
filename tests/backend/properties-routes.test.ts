import type { Express, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerPropertiesRoutes } from "../../src/backend/properties-routes.js";
import type { SSHSession } from "../../src/backend/session.js";

const { execBuffer } = vi.hoisted(() => ({ execBuffer: vi.fn() }));
vi.mock("../../src/backend/session.js", () => ({
  execBuffer,
  getLiveSessionSftp: vi.fn(),
}));

function setup(connected = true) {
  const routes = new Map<string, (req: Request, res: Response) => void>();
  registerPropertiesRoutes(
    { post: (p: string, h: never) => routes.set(p, h) } as unknown as Express,
    {
      ctx: {
        currentActor: () => "u",
        log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      } as unknown as PluginContext,
      sshSessions: { s: { isConnected: connected } as SSHSession },
      verifySessionOwnership: () => true,
    },
  );
  return (body: Record<string, unknown>) =>
    new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve) => {
        let status = 200;
        const res = {
          headersSent: false,
          status(c: number) {
            status = c;
            return res;
          },
          json(b: Record<string, unknown>) {
            resolve({ status, body: b });
          },
        };
        routes.get("/dirSizes")!(
          { body } as Request,
          res as unknown as Response,
        );
      },
    );
}

const out = (s: string) => ({ stdout: Buffer.from(s) });

describe("dirSizes", () => {
  it("rejects a session that is not connected", async () => {
    expect((await setup(false)({ sessionId: "s", paths: ["/a"] })).status).toBe(
      400,
    );
  });

  it("parses du -sb output", async () => {
    execBuffer.mockResolvedValueOnce(out("42\t/a\n7\t/b c\n"));
    const r = await setup()({ sessionId: "s", paths: ["/a", "/b c"] });
    expect(r.body.sizes).toEqual({ "/a": 42, "/b c": 7 });
  });

  it("falls back to du -sk for paths -sb missed", async () => {
    execBuffer
      .mockResolvedValueOnce(out("42\t/a\n"))
      .mockResolvedValueOnce(out("3\t/b\n"));
    const r = await setup()({ sessionId: "s", paths: ["/a", "/b"] });
    expect(r.body.sizes).toEqual({ "/a": 42, "/b": 3072 });
  });
});
