import type { Express, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerFileOperationRoutes } from "../../src/backend/operation-routes.js";
import type { SSHSession } from "../../src/backend/session.js";

const m = vi.hoisted(() => ({
  moveMany: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../src/backend/session.js", () => ({
  execChannel: vi.fn(),
  execWithSudo: vi.fn(),
  getSessionSftp: vi.fn(async () => ({})),
}));
vi.mock("../../src/backend/trash-service.js", () => ({
  emptyTrash: vi.fn(),
  listTrash: vi.fn(async () => []),
  moveToTrash: vi.fn(),
  moveManyToTrash: m.moveMany,
  permanentlyDeleteTrashItem: vi.fn(),
  restoreTrashItem: vi.fn(),
}));
vi.mock("../../src/backend/permanent-delete.js", () => ({
  removePermanently: m.remove,
}));

type Handler = (req: Request, res: Response) => Promise<void>;

function setup(owned = true) {
  const routes = new Map<string, Handler>();
  const app = {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    post: (p: string, h: Handler) => routes.set(p, h),
  } as unknown as Express;
  registerFileOperationRoutes(app, {
    ctx: {
      currentActor: () => "u",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      settings: { get: vi.fn() },
      rbac: { has: vi.fn() },
    } as unknown as PluginContext,
    sshSessions: { s: { isConnected: true, userId: "u" } as SSHSession },
    verifySessionOwnership: () => owned,
  });
  return (route: string, body: Record<string, unknown>) =>
    new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve) => {
        let status = 200;
        const res = {
          status(c: number) {
            status = c;
            return res;
          },
          json(b: Record<string, unknown>) {
            resolve({ status, body: b });
          },
        };
        void routes.get(route)!(
          { body, query: {} } as unknown as Request,
          res as unknown as Response,
        );
      },
    );
}

describe("POST /deleteItems", () => {
  beforeEach(() => {
    m.moveMany.mockReset();
    m.remove.mockReset();
  });

  it.each([
    [{ sessionId: "s", paths: [] }],
    [{ sessionId: "s", paths: [1] }],
    [{ sessionId: "s", paths: [""] }],
    [{ sessionId: "s", paths: Array(501).fill("/a") }],
    [{ sessionId: "s" }],
  ])("rejects bad paths %j", async (body) => {
    expect((await setup()("/deleteItems", body)).status).toBe(400);
  });

  it("rejects unknown and foreign sessions", async () => {
    expect(
      (await setup()("/deleteItems", { sessionId: "x", paths: ["/a"] })).status,
    ).toBe(400);
    expect(
      (await setup(false)("/deleteItems", { sessionId: "s", paths: ["/a"] }))
        .status,
    ).toBe(403);
  });

  it("dedupes paths and returns per-path results", async () => {
    const results = [{ path: "/a" }, { path: "/b", error: "nope" }];
    m.moveMany.mockResolvedValue(results);
    const out = await setup()("/deleteItems", {
      sessionId: "s",
      paths: ["/a", "/b", "/a"],
    });
    expect(m.moveMany.mock.calls[0][1]).toEqual(["/a", "/b"]);
    expect(out.body.results).toEqual(results);
  });

  it("uses permanent removal only when permanent is true", async () => {
    m.remove.mockResolvedValue([{ path: "/a" }]);
    const call = setup();
    await call("/deleteItems", {
      sessionId: "s",
      paths: ["/a"],
      permanent: true,
    });
    expect(m.remove).toHaveBeenCalledTimes(1);
    expect(m.moveMany).not.toHaveBeenCalled();
  });

  it("reports an unavailable trash as 409", async () => {
    m.moveMany.mockRejectedValue(new Error("no trash"));
    const out = await setup()("/deleteItems", {
      sessionId: "s",
      paths: ["/a"],
    });
    expect(out.status).toBe(409);
    expect(out.body.trashUnavailable).toBe(true);
  });

  it("stops queued items after /deleteItems/cancel for that opId only", async () => {
    let stop: () => boolean = () => false;
    m.moveMany.mockImplementation(async (_s, _p, _c, shouldStop) => {
      stop = shouldStop;
      return [];
    });
    const call = setup();
    await call("/deleteItems", { sessionId: "s", paths: ["/a"], opId: "op1" });
    expect(stop()).toBe(false);
    expect((await call("/deleteItems/cancel", { sessionId: "s" })).status).toBe(
      400,
    );
    await call("/deleteItems/cancel", { sessionId: "s", opId: "op1" });
    expect(stop()).toBe(true);
    await call("/deleteItems", { sessionId: "s", paths: ["/a"], opId: "op2" });
    expect(stop()).toBe(false);
  });
});
