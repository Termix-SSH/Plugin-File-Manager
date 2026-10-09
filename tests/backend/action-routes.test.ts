import { EventEmitter } from "node:events";
import type { Express, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { registerFileActionRoutes } from "../../src/backend/action-routes.js";
import type { SSHSession } from "../../src/backend/session.js";

const { execChannel } = vi.hoisted(() => ({ execChannel: vi.fn() }));
vi.mock("../../src/backend/session.js", () => ({ execChannel }));

type Run = { stdout?: string; stderr?: string; code: number };

function fakeStream({ stdout = "", stderr = "", code }: Run) {
  const stream = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: vi.fn(),
  });
  setTimeout(() => {
    if (stdout) stream.emit("data", Buffer.from(stdout));
    if (stderr) stream.stderr.emit("data", Buffer.from(stderr));
    stream.emit("close", code);
  });
  return stream;
}

function setup(runs: Run[]) {
  const commands: string[] = [];
  execChannel.mockImplementation((_session, command, callback) => {
    commands.push(command);
    callback(undefined, fakeStream(runs.shift() ?? { code: 0 }));
  });
  const routes = new Map<string, (req: Request, res: Response) => void>();
  const app = {
    post: (path: string, handler: (req: Request, res: Response) => void) =>
      routes.set(path, handler),
  } as unknown as Express;
  registerFileActionRoutes(app, {
    ctx: {
      currentActor: () => "user-1",
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as PluginContext,
    sshSessions: { s: { isConnected: true } as SSHSession },
    scheduleSessionCleanup: vi.fn(),
    verifySessionOwnership: () => true,
  });
  const call = (route: string, body: Record<string, unknown>) =>
    new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve) => {
        let status = 200;
        const res = {
          headersSent: false,
          writableFinished: false,
          on: vi.fn(),
          status(code: number) {
            status = code;
            return res;
          },
          json(payload: Record<string, unknown>) {
            res.headersSent = true;
            resolve({ status, body: payload });
          },
        };
        routes.get(route)!(
          { body } as unknown as Request,
          res as unknown as Response,
        );
      },
    );
  return { call, commands };
}

describe("copyItem", () => {
  it("copies folders recursively and reports success", async () => {
    const { call, commands } = setup([{ stdout: "COPY_SUCCESS\n", code: 0 }]);
    const result = await call("/copyItem", {
      sessionId: "s",
      sourcePath: "/home/a/dir",
      targetDir: "/home/a",
    });
    expect(result.status).toBe(200);
    expect(commands[0]).toMatch(/^cp -r '/);
  });

  it("answers with the error when cp fails without output", async () => {
    const { call } = setup([{ stderr: "cp: cannot stat", code: 1 }]);
    const result = await call("/copyItem", {
      sessionId: "s",
      sourcePath: "/missing",
      targetDir: "/home/a",
    });
    expect(result.status).toBe(500);
    expect(result.body.error).toContain("cannot stat");
  });
});

describe("copyItem disconnects", () => {
  it("stops waiting when the client goes away", async () => {
    let stream: EventEmitter & { close: ReturnType<typeof vi.fn> };
    execChannel.mockImplementation((_session, _command, callback) => {
      stream = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close: vi.fn(),
      });
      callback(undefined, stream);
    });
    const routes = new Map<string, (req: Request, res: Response) => void>();
    const session = { isConnected: true, activeOperations: 0 } as SSHSession;
    registerFileActionRoutes(
      {
        post: (path: string, handler: (req: Request, res: Response) => void) =>
          routes.set(path, handler),
      } as unknown as Express,
      {
        ctx: {
          currentActor: () => "user-1",
          log: { info: vi.fn(), error: vi.fn() },
        } as unknown as PluginContext,
        sshSessions: { s: session },
        scheduleSessionCleanup: vi.fn(),
        verifySessionOwnership: () => true,
      },
    );
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableFinished: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });
    routes.get("/copyItem")!(
      {
        body: { sessionId: "s", sourcePath: "/a", targetDir: "/b" },
      } as unknown as Request,
      res as unknown as Response,
    );
    expect(session.activeOperations).toBe(1);
    res.emit("close");
    expect(stream!.close).toHaveBeenCalled();
    expect(session.activeOperations).toBe(0);
  });
});

describe("executeFile", () => {
  it("refuses a file that is not executable", async () => {
    const { call, commands } = setup([{ stdout: "NOT_EXECUTABLE\n", code: 0 }]);
    const result = await call("/executeFile", {
      sessionId: "s",
      filePath: "/home/a/notes.txt",
    });
    expect(result.status).toBe(400);
    expect(commands).toHaveLength(1);
  });

  it("runs an executable file", async () => {
    const { call } = setup([
      { stdout: "EXECUTABLE\n", code: 0 },
      { stdout: "hi\nEXIT_CODE:0", code: 0 },
    ]);
    const result = await call("/executeFile", {
      sessionId: "s",
      filePath: "/home/a/run.sh",
    });
    expect(result.body).toMatchObject({ exitCode: 0, output: "hi" });
  });
});
