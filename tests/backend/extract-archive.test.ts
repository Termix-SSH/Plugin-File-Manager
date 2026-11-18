import { EventEmitter } from "node:events";
import type { Express, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  buildExtractCommand,
  friendlyExtractError,
  registerExtractProgressRoutes,
} from "../../src/backend/extract-archive.js";
import type { SSHSession } from "../../src/backend/session.js";

const { execChannel } = vi.hoisted(() => ({ execChannel: vi.fn() }));
vi.mock("../../src/backend/session.js", () => ({ execChannel }));

type Stream = EventEmitter & { stderr: EventEmitter };

function setup({ actor = "user-1" }: { actor?: string | null } = {}) {
  const streams = new Map<string, Stream>();
  const commands: string[] = [];
  execChannel.mockImplementation((_session, command, callback) => {
    const stream = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
    });
    commands.push(command);
    streams.set(command, stream);
    callback(undefined, stream);
  });
  const routes = new Map<string, (req: Request, res: Response) => void>();
  const app = {
    post: (path: string, handler: (req: Request, res: Response) => void) =>
      routes.set(`POST ${path}`, handler),
    get: (path: string, handler: (req: Request, res: Response) => void) =>
      routes.set(`GET ${path}`, handler),
  } as unknown as Express;
  const session = { isConnected: true, activeOperations: 0 } as SSHSession;
  let currentActor = actor;
  registerExtractProgressRoutes(app, {
    ctx: {
      currentActor: () => currentActor,
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as PluginContext,
    sshSessions: { s: session },
    scheduleSessionCleanup: vi.fn(),
    verifySessionOwnership: () => true,
  });
  const call = (
    route: string,
    req: { body?: unknown; params?: Record<string, string> },
  ) => {
    let status = 200;
    let body: Record<string, unknown> = {};
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: Record<string, unknown>) {
        body = payload;
      },
    };
    routes.get(route)!(req as Request, res as unknown as Response);
    return { status, body };
  };
  const start = (archivePath: string) =>
    call("POST /extractArchive/start", {
      body: { sessionId: "s", archivePath },
    });
  const status = (operationId: unknown) =>
    call("GET /extractArchive/status/:operationId", {
      params: { operationId: String(operationId) },
    });
  return {
    start,
    status,
    commands,
    session,
    stream: (index: number) => streams.get(commands[index])!,
    actAs: (next: string | null) => (currentActor = next),
  };
}

describe("buildExtractCommand", () => {
  it("keeps the plain commands when progress is not asked for", () => {
    expect(buildExtractCommand("/d/a.tar.gz")?.command).toBe(
      "tar -xzf '/d/a.tar.gz' -C '/d'",
    );
    expect(buildExtractCommand("/d/a.zip", "/out")?.command).toBe(
      "unzip -o '/d/a.zip' -d '/out'",
    );
    expect(buildExtractCommand("/d/a.gz")?.command).toBe(
      "gunzip -c '/d/a.gz' > '/d/a'",
    );
    expect(buildExtractCommand("/d/a.rar")?.command).toBe(
      "unrar x '/d/a.rar' '/d/'",
    );
    expect(buildExtractCommand("/d/a.txt")).toBeNull();
  });

  it("lists entries for tar and counts them up front for zip", () => {
    const tar = buildExtractCommand("/d/a.tgz", undefined, { verbose: true })!;
    expect(tar.command).toBe("tar -xvzf '/d/a.tgz' -C '/d'");
    expect(tar.listsEntries).toBe(true);
    expect(tar.countCommand).toBeUndefined();

    const zip = buildExtractCommand("/d/a.zip", undefined, { verbose: true })!;
    expect(zip.listsEntries).toBe(true);
    expect(zip.countCommand).toBe("unzip -Z1 '/d/a.zip' | wc -l");

    const seven = buildExtractCommand("/d/a.7z", undefined, { verbose: true })!;
    expect(seven.listsEntries).toBe(false);
  });

  it("quotes paths so a quote in a name cannot end the argument", () => {
    expect(buildExtractCommand("/d/it's.tar")?.command).toBe(
      "tar -xf '/d/it'\"'\"'s.tar' -C '/d'",
    );
  });
});

describe("friendlyExtractError", () => {
  it("says what to install when the tool is missing", () => {
    expect(
      friendlyExtractError("/d/a.zip", "bash: unzip: command not found"),
    ).toContain("Command 'unzip' not found");
    expect(friendlyExtractError("/d/a.zip", "bad zipfile")).toBe("bad zipfile");
    expect(friendlyExtractError("/d/a.zip", "")).toBe(
      "Failed to extract archive",
    );
  });
});

describe("extractArchive/start and status", () => {
  it("answers at once and reports entries as the host writes them", () => {
    const { start, status, stream, session, commands } = setup();
    const started = start("/data/big.tar.gz");
    expect(started.status).toBe(202);
    expect(commands).toEqual(["tar -xvzf '/data/big.tar.gz' -C '/data'"]);
    const id = started.body.operationId;
    // Held open so the idle cleanup cannot end a long extraction.
    expect(session.activeOperations).toBe(1);
    expect(status(id).body).toMatchObject({ status: "running", extracted: 0 });

    // A line split across two chunks counts once.
    stream(0).emit("data", Buffer.from("src/\nsrc/a.txt\nsrc/b"));
    expect(status(id).body.extracted).toBe(2);
    stream(0).emit("data", Buffer.from(".txt\n"));
    expect(status(id).body.extracted).toBe(3);

    stream(0).emit("close", 0);
    expect(status(id).body).toMatchObject({
      status: "done",
      extracted: 3,
      extractPath: "/data",
    });
    expect(session.activeOperations).toBe(0);
  });

  it("gives a zip its total and skips unzip's header lines", () => {
    const { start, status, stream, commands } = setup();
    const id = start("/data/a.zip").body.operationId;
    expect(commands).toEqual([
      "unzip -Z1 '/data/a.zip' | wc -l",
      "unzip -o '/data/a.zip' -d '/data'",
    ]);
    stream(0).emit("data", Buffer.from("4\n"));
    stream(0).emit("close", 0);
    stream(1).emit(
      "data",
      Buffer.from(
        "Archive:  /data/a.zip\n   creating: /data/src/\n  inflating: /data/src/a.txt\n",
      ),
    );
    expect(status(id).body).toMatchObject({
      status: "running",
      extracted: 2,
      total: 4,
    });
  });

  it("reports a failed extraction with a readable error", () => {
    const { start, status, stream, session } = setup();
    const id = start("/data/a.zip").body.operationId;
    stream(1).stderr.emit(
      "data",
      Buffer.from("bash: unzip: command not found"),
    );
    stream(1).emit("close", 127);
    const result = status(id).body;
    expect(result.status).toBe("error");
    expect(result.error).toContain("Command 'unzip' not found");
    expect(session.activeOperations).toBe(0);
  });

  it("has no count for formats that do not list entries", () => {
    const { start, status } = setup();
    const id = start("/data/a.7z").body.operationId;
    expect(status(id).body.extracted).toBeUndefined();
  });

  it("hides another user's extraction", () => {
    const { start, status, actAs } = setup();
    const id = start("/data/a.tar").body.operationId;
    actAs("user-2");
    expect(status(id).status).toBe(404);
    expect(status("nope").status).toBe(404);
  });

  it("rejects bad requests before running anything", () => {
    const { start, commands } = setup();
    expect(start("/data/a.txt").status).toBe(400);
    expect(start("").status).toBe(400);
    expect(commands).toEqual([]);
    const anonymous = setup({ actor: null });
    expect(anonymous.start("/data/a.tar").status).toBe(403);
    expect(anonymous.commands).toEqual([]);
  });
});
