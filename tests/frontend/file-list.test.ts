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
  it("sorts same length hex names char by char", () => {
    const names = [
      "000000010000012A00000000",
      "000000010000012A0000000A",
      "0000000100000129000000FF",
      "000000010000012A00000001",
    ];
    const out = filterAndSortFiles(
      names.map((n) => f(n)),
      "",
      "name",
      "asc",
    );
    expect(out.map((x) => x.name)).toEqual([
      "0000000100000129000000FF",
      "000000010000012A00000000",
      "000000010000012A00000001",
      "000000010000012A0000000A",
    ]);
  });
});
