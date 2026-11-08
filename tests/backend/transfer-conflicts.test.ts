import {
  existsSync,
  lstatSync,
  symlinkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildTransferCommand } from "../../src/backend/operation-commands";

const bash =
  process.platform === "win32"
    ? `${process.env.ProgramFiles}/Git/bin/bash.exe`
    : "/bin/bash";
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fm-conflicts-"));
  directories.push(dir);
  return { source: join(dir, "source"), target: join(dir, "target") };
}
function run(
  operation: "copy" | "move",
  source: string,
  target: string,
  overwrite = false,
  before = "",
) {
  return spawnSync(
    bash,
    [
      "-c",
      before +
        buildTransferCommand(
          operation,
          source.replaceAll("\\", "/"),
          target.replaceAll("\\", "/"),
          overwrite,
        ),
    ],
    { encoding: "utf8" },
  );
}

// These are real GNU cp/mv checks in disposable local directories, not SSH proof.
describe.skipIf(!existsSync(bash))("copy/move conflict safety", () => {
  it.each(["copy", "move"] as const)(
    "%s refuses an existing file unless overwrite is explicit",
    (operation) => {
      const { source, target } = fixture();
      writeFileSync(source, "new");
      writeFileSync(target, "old");
      const refused = run(operation, source, target);
      expect(refused.status, refused.stderr).not.toBe(0);
      expect(readFileSync(target, "utf8")).toBe("old");
      expect(readFileSync(source, "utf8")).toBe("new");
      const replaced = run(operation, source, target, true);
      expect(replaced.status, replaced.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("new");
      expect(existsSync(source)).toBe(operation === "copy");
    },
  );

  it.each(["copy", "move"] as const)(
    "%s refuses file/directory type mismatches without deleting anything",
    (operation) => {
      for (const sourceIsDirectory of [true, false]) {
        const { source, target } = fixture();
        if (sourceIsDirectory) {
          mkdirSync(source);
          writeFileSync(target, "old");
        } else {
          writeFileSync(source, "new");
          mkdirSync(target);
        }
        const result = run(operation, source, target, true);
        expect(result.status, result.stderr).not.toBe(0);
        expect(existsSync(source)).toBe(true);
        expect(existsSync(target)).toBe(true);
        expect(readFileSync(sourceIsDirectory ? target : source, "utf8")).toBe(
          sourceIsDirectory ? "old" : "new",
        );
      }
    },
  );

  it("refuses moving onto a directory rather than silently nesting or deleting it", () => {
    const { source, target } = fixture();
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "old");
    const result = run("move", source, target, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("choose Keep both");
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("old");
    expect(existsSync(join(target, "source"))).toBe(false);
  });

  it("copies into the exact destination and merges folders only with explicit overwrite", () => {
    const { source, target } = fixture();
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, "a"), "new");
    writeFileSync(join(target, "a"), "old");
    writeFileSync(join(target, "keep"), "keep");
    expect(run("copy", source, target).status).not.toBe(0);
    const result = run("copy", source, target, true);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(target, "a"), "utf8")).toBe("new");
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("keep");
    expect(existsSync(join(target, "source"))).toBe(false);
  });

  it.each(["copy", "move"] as const)(
    "%s quotes names and handles new destinations",
    (operation) => {
      const { source, target } = fixture();
      const quotedSource = source + "' notes.txt";
      const quotedTarget = target + "' notes (1).txt";
      writeFileSync(quotedSource, "new");
      const result = run(operation, quotedSource, quotedTarget);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(quotedTarget, "utf8")).toBe("new");
    },
  );

  it.each(["copy", "move"] as const)(
    "%s refuses overwriting itself",
    (operation) => {
      const { source } = fixture();
      writeFileSync(source, "keep");
      expect(run(operation, source, source, true).status).not.toBe(0);
      expect(readFileSync(source, "utf8")).toBe("keep");
    },
  );

  it("refuses to copy or move a folder into itself or a descendant", () => {
    for (const operation of ["copy", "move"] as const) {
      const { source } = fixture();
      mkdirSync(join(source, "child"), { recursive: true });
      writeFileSync(join(source, "a"), "keep");
      for (const target of [join(source, "copy"), join(source, "child", "x")]) {
        const result = run(operation, source, target);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("into itself");
        expect(existsSync(target)).toBe(false);
      }
      expect(readFileSync(join(source, "a"), "utf8")).toBe("keep");
    }
  });

  it("refuses to overwrite a folder containing the source", () => {
    const { source } = fixture();
    const nested = join(source, "child");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(source, "a"), "parent");
    writeFileSync(join(nested, "a"), "child");
    const result = run("copy", nested, source, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("contains it");
    expect(result.stdout).not.toContain("COPY_SUCCESS");
    expect(readFileSync(join(source, "a"), "utf8")).toBe("parent");
    expect(readFileSync(join(nested, "a"), "utf8")).toBe("child");
  });

  it("refuses an occupied temporary copy path without changing it", () => {
    const { source, target } = fixture();
    writeFileSync(source, "new");
    const posixTarget = target.replaceAll("\\", "/");
    const result = run(
      "copy",
      source,
      target,
      false,
      `tmp='${posixTarget}'.termix-copy-$$; echo keep > "$tmp"; `,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("COPY_SUCCESS");
    expect(result.stderr).toContain("Temporary copy path already exists");
    expect(existsSync(target)).toBe(false);
    const remaining = spawnSync(bash, [
      "-c",
      `cat '${posixTarget}'.termix-copy-*`,
    ]);
    expect(remaining.stdout.toString().trim()).toBe("keep");
  });

  it("no-clobber copy keeps a target that appears after the check and reports failure", () => {
    const { source, target } = fixture();
    writeFileSync(source, "new");
    const posixTarget = target.replaceAll("\\", "/");
    const result = run(
      "copy",
      source,
      target,
      false,
      `cp() { command cp "$@"; echo late > '${posixTarget}'; }; `,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("COPY_SUCCESS");
    expect(readFileSync(target, "utf8").trim()).toBe("late");
    expect(
      spawnSync(bash, ["-c", `ls '${posixTarget}'.termix-copy-* 2>/dev/null`])
        .stdout.length,
    ).toBe(0);
  });

  // Needs real symlinks (not available to every Windows account).
  const canLink = (() => {
    try {
      const dir = mkdtempSync(join(tmpdir(), "fm-link-"));
      directories.push(dir);
      writeFileSync(join(dir, "f"), "");
      symlinkSync(join(dir, "f"), join(dir, "l"));
      return lstatSync(join(dir, "l")).isSymbolicLink();
    } catch {
      return false;
    }
  })();
  it.skipIf(!canLink)(
    "overwrite replaces a nested file link instead of writing through it",
    () => {
      const { source, target } = fixture();
      const outside = join(fixture().source, "..", "outside.txt");
      writeFileSync(outside, "outside");
      mkdirSync(source);
      mkdirSync(target);
      writeFileSync(join(source, "a"), "new");
      symlinkSync(outside, join(target, "a"));
      const result = run("copy", source, target, true);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outside, "utf8")).toBe("outside");
      expect(readFileSync(join(target, "a"), "utf8")).toBe("new");
      expect(lstatSync(join(target, "a")).isSymbolicLink()).toBe(false);
    },
  );
});
