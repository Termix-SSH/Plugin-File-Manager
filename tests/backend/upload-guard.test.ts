import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertNoLinksBelow,
  buildLinkGuardCommand,
  pathBelowRoot,
  UploadGuardError,
} from "../../src/backend/upload-guard";

type Kind = "file" | "dir" | "link";
function fakeSftp(tree: Record<string, Kind>) {
  return {
    lstat: (
      path: string,
      done: (err: unknown, stats?: Record<string, () => boolean>) => void,
    ) => {
      const kind = tree[path];
      if (!kind) return done({ code: 2 });
      done(null, {
        isSymbolicLink: () => kind === "link",
        isDirectory: () => kind === "dir",
      });
    },
  } as never;
}

describe("upload guard", () => {
  it("keeps paths inside the upload root", () => {
    expect(pathBelowRoot("/r/", "/r/a/b")).toEqual(["a", "b"]);
    expect(pathBelowRoot("/r", "/r/../x")).toBeNull();
    expect(pathBelowRoot("/r", "/other/a")).toBeNull();
    expect(pathBelowRoot("/r", "/r")).toBeNull();
  });

  it("allows new paths and merging into regular directories", async () => {
    const sftp = fakeSftp({ "/r/d": "dir", "/r/d/f": "file" });
    await expect(
      assertNoLinksBelow(sftp, "/r", "/r/d/f", "file"),
    ).resolves.toBeUndefined();
    await expect(
      assertNoLinksBelow(sftp, "/r", "/r/d/new/f", "file"),
    ).resolves.toBeUndefined();
    await expect(
      assertNoLinksBelow(sftp, "/r", "/r/d", "directory"),
    ).resolves.toBeUndefined();
  });

  it("does not check the root itself, so a linked base folder still works", async () => {
    const sftp = fakeSftp({ "/r": "link" });
    await expect(
      assertNoLinksBelow(sftp, "/r", "/r/f", "file"),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["nested file link", { "/r/d": "dir", "/r/d/f": "link" }, "/r/d/f", "file"],
    ["nested directory link", { "/r/d": "link" }, "/r/d/f", "file"],
    ["folder link as folder target", { "/r/d": "link" }, "/r/d", "directory"],
    ["file where a folder is needed", { "/r/d": "file" }, "/r/d/f", "file"],
    ["folder where a file is needed", { "/r/f": "dir" }, "/r/f", "file"],
  ] as const)("refuses %s", async (_name, tree, path, kind) => {
    await expect(
      assertNoLinksBelow(fakeSftp(tree), "/r", path, kind),
    ).rejects.toBeInstanceOf(UploadGuardError);
  });
});

const bash =
  process.platform === "win32"
    ? `${process.env.ProgramFiles}/Git/bin/bash.exe`
    : "/bin/bash";
const dir = mkdtempSync(join(tmpdir(), "fm-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posix = (p: string) => p.replaceAll("\\", "/");
function canLink() {
  try {
    writeFileSync(join(dir, "probe"), "");
    symlinkSync(join(dir, "probe"), join(dir, "probe-link"));
    return lstatSync(join(dir, "probe-link")).isSymbolicLink();
  } catch {
    return false;
  }
}

// Real shell checks for the cat fallback; not SSH proof.
describe.skipIf(!existsSync(bash) || !canLink())("cat fallback guard", () => {
  const guard = (path: string, kind: "file" | "directory" = "file") =>
    spawnSync(
      bash,
      [
        "-c",
        `${buildLinkGuardCommand(posix(dir) + "/root", posix(path), kind)}echo OK`,
      ],
      { encoding: "utf8" },
    );
  it("allows a regular directory merge and refuses nested links", () => {
    const outside = join(dir, "outside");
    mkdirSync(join(dir, "root", "plain"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "root", "dirlink"));
    symlinkSync(join(dir, "probe"), join(dir, "root", "plain", "filelink"));
    expect(guard(join(dir, "root", "plain", "new")).stdout).toContain("OK");
    const viaDir = guard(join(dir, "root", "dirlink", "f"));
    expect(viaDir.stdout).not.toContain("OK");
    expect(viaDir.status).not.toBe(0);
    expect(guard(join(dir, "root", "plain", "filelink")).stdout).not.toContain(
      "OK",
    );
    expect(guard(join(dir, "root", "plain"), "directory").stdout).toContain(
      "OK",
    );
  });
});
