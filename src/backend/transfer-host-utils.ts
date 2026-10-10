import { normalizeSftpPath } from "./transfer-paths.js";

export function escapeShell(s: string): string {
  return s.replace(/'/g, "'\"'\"'");
}

export function isRootOnlyPath(path: string): boolean {
  const normalized = normalizeSftpPath(path);
  return (
    normalized === "/" ||
    /^\/[A-Za-z]:$/.test(normalized) ||
    /^[A-Za-z]:$/.test(normalized)
  );
}

export function isPermissionError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("permission denied") ||
    msg.includes("eacces") ||
    msg.includes("access denied")
  );
}
