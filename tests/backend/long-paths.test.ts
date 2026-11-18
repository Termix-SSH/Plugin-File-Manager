import { describe, expect, it } from "vitest";
import { trimEnd } from "../../src/backend/trim.js";
import {
  basename,
  dirname,
  normalizeSftpPath,
} from "../../src/backend/transfer-paths.js";
import { pathBelowRoot } from "../../src/backend/upload-guard.js";

// A request path with a long run of slashes used to take quadratic time.
const longRun = "/".repeat(200_000) + "x";

function fast(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("trailing slash trimming", () => {
  it("trims the given characters only at the end", () => {
    expect(trimEnd("/a/b///")).toBe("/a/b");
    expect(trimEnd("///")).toBe("");
    expect(trimEnd("/a/b")).toBe("/a/b");
    expect(trimEnd("name. . ", ". ")).toBe("name");
  });

  it("stays fast on long runs of slashes", () => {
    expect(fast(() => normalizeSftpPath(longRun))).toBeLessThan(500);
    expect(fast(() => basename(longRun))).toBeLessThan(500);
    expect(fast(() => dirname(longRun))).toBeLessThan(500);
    expect(fast(() => pathBelowRoot(longRun, "/srv/x"))).toBeLessThan(500);
    expect(fast(() => trimEnd(". ".repeat(100_000) + "a", ". "))).toBeLessThan(
      500,
    );
  });

  it("keeps the same results as before", () => {
    expect(normalizeSftpPath("/home/user///")).toBe("/home/user");
    expect(normalizeSftpPath("///")).toBe("/");
    expect(basename("/home/user/file.txt/")).toBe("file.txt");
    expect(dirname("/home/user/file.txt")).toBe("/home/user");
    expect(pathBelowRoot("/srv/up//", "/srv/up/a/b")).toEqual(["a", "b"]);
  });
});
