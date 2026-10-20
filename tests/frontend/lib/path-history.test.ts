import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPaths,
  listPaths,
  recordPath,
  shellQuote,
} from "../../../src/frontend/lib/path-history";

describe("path history", () => {
  beforeEach(() => localStorage.clear());

  it("ignores empty and relative root paths", () => {
    recordPath(1, "", 10);
    recordPath(1, ".", 10);
    expect(listPaths(1)).toEqual({ frequent: [], recent: [] });
  });

  it("lists visited folders, newest first", () => {
    recordPath(1, "/a", 10);
    recordPath(1, "/b", 10);
    expect(listPaths(1).recent).toEqual(["/b", "/a"]);
  });

  it("moves folders visited more than once into frequent", () => {
    recordPath(1, "/a", 10);
    recordPath(1, "/b", 10);
    recordPath(1, "/a", 10);
    const { frequent, recent } = listPaths(1);
    expect(frequent).toEqual(["/a"]);
    expect(recent).toEqual(["/b"]);
  });

  it("keeps only the newest folders up to the limit", () => {
    recordPath(1, "/a", 2);
    recordPath(1, "/b", 2);
    recordPath(1, "/c", 2);
    expect(listPaths(1).recent).toEqual(["/c", "/b"]);
  });

  it("keeps each host separate and can clear one", () => {
    recordPath(1, "/a", 10);
    recordPath(2, "/b", 10);
    clearPaths(1);
    expect(listPaths(1).recent).toEqual([]);
    expect(listPaths(2).recent).toEqual(["/b"]);
  });

  it("quotes a path for the shell", () => {
    expect(shellQuote("/var/www")).toBe("'/var/www'");
    expect(shellQuote("/it's here")).toBe("'/it'\\''s here'");
  });
});
