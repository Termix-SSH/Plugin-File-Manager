import { describe, expect, it } from "vitest";
import { filterAndSortFiles } from "../../src/frontend/file-list";
import type { FileItem } from "../../src/frontend/host-types";

const f = (
  name: string,
  type: FileItem["type"] = "file",
  size = 0,
): FileItem => ({
  name,
  type,
  size,
  path: "/" + name,
});

describe("filterAndSortFiles", () => {
  it("puts directories first and sorts names naturally", () => {
    const out = filterAndSortFiles(
      [f("a10"), f("a2"), f("z", "directory")],
      "",
      "name",
      "asc",
    );
    expect(out.map((x) => x.name)).toEqual(["z", "a2", "a10"]);
  });
  it("filters case-insensitively and reverses", () => {
    const out = filterAndSortFiles(
      [f("Ab", "file", 1), f("ab2", "file", 2), f("c")],
      "AB",
      "size",
      "desc",
    );
    expect(out.map((x) => x.name)).toEqual(["ab2", "Ab"]);
  });
});
