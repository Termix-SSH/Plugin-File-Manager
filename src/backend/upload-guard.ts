import { quotePosixPath } from "./operation-commands.js";

type SFTPWrapper = import("ssh2").SFTPWrapper;

export class UploadGuardError extends Error {}

const OUTSIDE = "Upload path is outside the selected upload folder";

/** Path components of `fullPath` below `root`, or null when it escapes it. */
export function pathBelowRoot(root: string, fullPath: string): string[] | null {
  const base = root.replace(/\/+$/, "");
  if (!fullPath.startsWith(`${base}/`)) return null;
  const parts = fullPath
    .slice(base.length + 1)
    .split("/")
    .filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) {
    return null;
  }
  return parts;
}

function prefixes(root: string, parts: string[]) {
  const base = root.replace(/\/+$/, "");
  return parts.map((_, i) => `${base}/${parts.slice(0, i + 1).join("/")}`);
}

/**
 * Browser upload batches write below one user-selected root. Everything
 * below it that already exists must be a plain directory (or, as the final
 * component, a plain file for "file" / a directory for "directory"); a link
 * or type mismatch is refused so a write cannot be redirected elsewhere.
 * The root itself may be reached through a link (legitimate navigation).
 * shortcut: lstat-then-write leaves a small race window; SFTP has no O_NOFOLLOW.
 */
export async function assertNoLinksBelow(
  sftp: SFTPWrapper,
  root: string,
  fullPath: string,
  finalKind: "file" | "directory",
): Promise<void> {
  const parts = pathBelowRoot(root, fullPath);
  if (!parts) throw new UploadGuardError(OUTSIDE);
  const paths = prefixes(root, parts);
  for (let i = 0; i < paths.length; i++) {
    const stats = await new Promise<import("ssh2").Stats | null>(
      (resolve, reject) =>
        sftp.lstat(paths[i], (err, value) => {
          const code = (err as { code?: unknown } | undefined)?.code;
          if (!err) resolve(value);
          else if (code === 2 || code === "ENOENT") resolve(null);
          else reject(err);
        }),
    );
    if (!stats) return; // Nothing below this exists yet.
    const wantsDirectory = i < paths.length - 1 || finalKind === "directory";
    if (stats.isSymbolicLink()) {
      throw new UploadGuardError(
        `Refusing to write through a link: ${paths[i]}`,
      );
    }
    if (stats.isDirectory() !== wantsDirectory) {
      throw new UploadGuardError(
        `File and folder name conflict at: ${paths[i]}`,
      );
    }
  }
}

/** Shell form of assertNoLinksBelow for hosts without an SFTP server. */
export function buildLinkGuardCommand(
  root: string,
  fullPath: string,
  finalKind: "file" | "directory",
): string {
  const parts = pathBelowRoot(root, fullPath);
  if (!parts) return `echo '${OUTSIDE}' >&2; exit 1; `;
  return prefixes(root, parts)
    .map((path, i) => {
      const quoted = quotePosixPath(path);
      const wantsDirectory = i < parts.length - 1 || finalKind === "directory";
      const mismatch = wantsDirectory
        ? `[ -e ${quoted} ] && [ ! -d ${quoted} ]`
        : `[ -d ${quoted} ]`;
      return `if [ -L ${quoted} ] || { ${mismatch}; }; then echo 'Refusing to write through a link or mismatched item' >&2; exit 1; fi; `;
    })
    .join("");
}
