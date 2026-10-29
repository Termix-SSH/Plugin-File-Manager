import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  isPermissionDenied,
  pipeCommandDownload,
} from "../../src/backend/command-download.js";

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  written: string[] = [];
  write(data: string) {
    this.written.push(data);
    return true;
  }
  pause() {}
  resume() {}
  destroy() {}
}

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    headers: new Map<string, string>(),
    chunks: [] as Buffer[],
    setHeader: vi.fn((k: string, v: string) => res.headers.set(k, v)),
    write: vi.fn((chunk: Buffer) => {
      res.chunks.push(chunk);
      return true;
    }),
    end: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
    destroy: vi.fn(),
    headersSent: false,
  });
  return res;
}

describe("pipeCommandDownload", () => {
  it("streams output and sends stdin", () => {
    const stream = new FakeChannel();
    const res = fakeRes();
    pipeCommandDownload(stream as never, res as never, { stdin: "pw\n" });
    expect(stream.written).toEqual(["pw\n"]);
    stream.emit("data", Buffer.from("hello"));
    stream.emit("close", 0);
    expect(Buffer.concat(res.chunks).toString()).toBe("hello");
    expect(res.end).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("answers 403 with needsSudo when cat is refused", () => {
    const stream = new FakeChannel();
    const res = fakeRes();
    pipeCommandDownload(stream as never, res as never);
    stream.stderr.emit(
      "data",
      Buffer.from("cat: /etc/shadow: Permission denied"),
    );
    stream.emit("close", 1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Permission denied",
      needsSudo: true,
    });
  });

  it("says when the sudo password is wrong", () => {
    const stream = new FakeChannel();
    const res = fakeRes();
    pipeCommandDownload(stream as never, res as never, { stdin: "bad\n" });
    stream.stderr.emit("data", Buffer.from("Sorry, try again.\n"));
    stream.emit("close", 1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ sudoFailed: true, needsSudo: true }),
    );
  });

  it("sends an empty file when there is nothing to read", () => {
    const stream = new FakeChannel();
    const res = fakeRes();
    pipeCommandDownload(stream as never, res as never);
    stream.emit("close", 0);
    expect(res.end).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("isPermissionDenied", () => {
  it("knows the SFTP code and the message", () => {
    expect(isPermissionDenied({ code: 3 })).toBe(true);
    expect(isPermissionDenied(new Error("Permission denied"))).toBe(true);
    expect(isPermissionDenied(new Error("No such file"))).toBe(false);
  });
});
