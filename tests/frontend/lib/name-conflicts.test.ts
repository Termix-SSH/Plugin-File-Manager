import { describe, expect, it, vi } from "vitest";
import {
  applyUploadPlan,
  resolveNameConflicts,
  uniqueName,
  uploadRoots,
  type ConflictChoice,
  type NamedItem,
} from "../../../src/frontend/lib/name-conflicts";

const file = (name: string): NamedItem => ({ name, type: "file" });
const choose = (action: ConflictChoice["action"], applyToAll = false) =>
  vi.fn(async () => ({ action, applyToAll }));

describe("name conflicts", () => {
  it("does not ask when nothing conflicts, including case-sensitive remote names", async () => {
    const ask = choose("skip");
    const plan = await resolveNameConflicts(
      [file("A.txt")],
      [file("a.txt")],
      ask,
    );
    expect(plan).toMatchObject([{ name: "A.txt", overwrite: false }]);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    [file("notes.txt"), ["notes.txt", "notes (1).txt"], "notes (2).txt"],
    [file(".env"), [".env"], ".env (1)"],
    [file("README"), ["README"], "README (1)"],
    [
      { name: "folder.ext", type: "directory" as const },
      ["folder.ext"],
      "folder.ext (1)",
    ],
  ])("names keep-both items without colliding", (item, names, expected) => {
    expect(uniqueName(item, new Set(names))).toBe(expected);
  });

  it("skips only the conflicting item", async () => {
    const plan = await resolveNameConflicts(
      [file("a"), file("b")],
      [file("a")],
      choose("skip"),
    );
    expect(plan?.map((p) => p.name)).toEqual(["b"]);
  });

  it.each(["overwrite", "skip", "keep-both"] as const)(
    "applies %s to remaining conflicts only",
    async (action) => {
      const ask = choose(action, true);
      const plan = await resolveNameConflicts(
        [file("a"), file("new"), file("b")],
        [file("a"), file("b")],
        ask,
      );
      expect(ask).toHaveBeenCalledExactlyOnceWith({ name: "a", remaining: 2 });
      expect(plan?.find((p) => p.name === "new")?.overwrite).toBe(false);
      expect(plan?.map((p) => p.name)).toEqual(
        action === "skip"
          ? ["new"]
          : action === "keep-both"
            ? ["a (1)", "new", "b (1)"]
            : ["a", "new", "b"],
      );
    },
  );

  it("counts down and asks again without apply-to-all", async () => {
    const ask = choose("overwrite");
    await resolveNameConflicts([file("a"), file("a")], [file("a")], ask);
    expect(ask.mock.calls).toEqual([
      [{ name: "a", remaining: 2 }],
      [{ name: "a", remaining: 1 }],
    ]);
  });

  it("cancels the whole plan on dismissal, including earlier nonconflicts", async () => {
    const ask = vi.fn(async () => null);
    expect(
      await resolveNameConflicts(
        [file("new"), file("a"), file("b")],
        [file("a"), file("b")],
        ask,
      ),
    ).toBeNull();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("makes same-directory copies without asking and reserves incoming names", async () => {
    const ask = choose("skip");
    const plan = await resolveNameConflicts(
      [file("a.txt"), file("a (1).txt")],
      [file("a.txt")],
      ask,
      (f) => f.name === "a.txt",
    );
    expect(plan?.map((p) => p.name)).toEqual(["a (2).txt", "a (1).txt"]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("detects duplicate incoming names and gives each a distinct keep-both name", async () => {
    const plan = await resolveNameConflicts(
      [file("a"), file("a"), file("a")],
      [],
      choose("keep-both", true),
    );
    expect(plan?.map((p) => p.name)).toEqual(["a", "a (1)", "a (2)"]);
  });

  it("does not carry apply-to-all between operations", async () => {
    const ask = choose("skip", true);
    await resolveNameConflicts([file("a")], [file("a")], ask);
    await resolveNameConflicts([file("a")], [file("a")], ask);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("checks only top-level upload folders, preserving duplicate loose files", () => {
    expect(
      uploadRoots(
        [
          { relativePath: "folder/a" },
          { relativePath: "folder/sub/b" },
          { relativePath: "a" },
          { relativePath: "a" },
        ],
        ["folder/empty", "other"],
      ),
    ).toEqual([
      { name: "folder", type: "directory", index: -1 },
      { name: "other", type: "directory", index: -1 },
      { name: "a", type: "file", index: 2 },
      { name: "a", type: "file", index: 3 },
    ]);
  });
});

describe("applyUploadPlan", () => {
  it("renames, skips and flags overwrite per top-level item", async () => {
    const files = [
      { relativePath: "dir/a.txt" },
      { relativePath: "dir/sub/b.txt" },
      { relativePath: "x.txt" },
      { relativePath: "y.txt" },
    ];
    const emptyDirs = ["dir/empty", "other"];
    const plan = await resolveNameConflicts(
      uploadRoots(files, emptyDirs),
      [
        { name: "dir", type: "directory" },
        { name: "x.txt", type: "file" },
        { name: "y.txt", type: "file" },
      ],
      async (conflict) => ({
        action:
          conflict.name === "dir"
            ? "keep-both"
            : conflict.name === "x.txt"
              ? "skip"
              : "overwrite",
        applyToAll: false,
      }),
    );
    expect(applyUploadPlan(files, emptyDirs, plan!)).toEqual({
      files: [
        { relativePath: "dir (1)/a.txt", overwrite: false },
        { relativePath: "dir (1)/sub/b.txt", overwrite: false },
        { relativePath: "y.txt", overwrite: true },
      ],
      emptyDirs: ["dir (1)/empty", "other"],
    });
  });
});
