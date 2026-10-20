import { randomUUID } from "node:crypto";
import path from "node:path";
import { execBuffer, execWithSudo, type SSHSession } from "./session.js";
import { buildDeleteCommand, quotePosixPath } from "./operation-commands.js";
import { isWindowsSftpPath } from "./transfer-paths.js";

export type RemoveItem = { path: string; isDirectory: boolean };
export type RemoveResult = {
  path: string;
  error?: string;
  needsSudo?: boolean;
};

// One shell command removes many paths; keep each under typical exec limits.
const MAX_SCRIPT_CHARS = 16_000;
const WINDOWS_CONCURRENCY = 4;

/** Refuses roots, empty paths and any . or .. segment: a batch rm -rf must never reach them. */
export function isRemovablePath(itemPath: string): boolean {
  const slashed = itemPath.replace(/\\/g, "/");
  if (slashed.split("/").some((s) => s === "." || s === "..")) return false;
  const normalized = path.posix.normalize(slashed);
  return (
    normalized !== "." &&
    normalized !== "/" &&
    !/^\/?[A-Za-z]:\/?$/.test(normalized)
  );
}

async function runPosixGroup(
  session: SSHSession,
  group: RemoveItem[],
  useSudo: boolean,
): Promise<Map<number, "OK" | "FAIL" | "DENIED">> {
  // The nonce keeps file names or error text from forging a status line, and
  // rm's own stderr is captured so only these markers reach stdout.
  const nonce = randomUUID();
  const script = group
    .map((item, i) => {
      const rm = item.isDirectory ? "rm -rf --" : "rm -f --";
      return `e=$(LC_ALL=C ${rm} ${quotePosixPath(item.path)} 2>&1) && echo "${nonce} OK ${i}" || { if printf %s "$e" | grep -q ": Permission denied$"; then echo "${nonce} DENIED ${i}"; else echo "${nonce} FAIL ${i}"; fi; }`;
    })
    .join("; ");
  const command = `sh -c ${quotePosixPath(script)}`;
  const result = useSudo
    ? await execWithSudo(session, command, session.sudoPassword!)
    : await execBuffer(session, command);
  const status = new Map<number, "OK" | "FAIL" | "DENIED">();
  const re = new RegExp(`^${nonce} (OK|FAIL|DENIED) (\\d+)$`, "gm");
  for (const m of result.stdout.toString().matchAll(re))
    if (!status.has(Number(m[2])))
      status.set(Number(m[2]), m[1] as "OK" | "FAIL" | "DENIED");
  return status;
}

/** Permanently removes paths, one shell command per chunk, with per-path results. */
export async function removePermanently(
  session: SSHSession,
  items: RemoveItem[],
  shouldStop: () => boolean = () => false,
): Promise<RemoveResult[]> {
  const results: RemoveResult[] = items.map((x) => ({ path: x.path }));
  const posix: number[] = [];
  const windows: number[] = [];
  items.forEach((x, i) => {
    if (!isRemovablePath(x.path))
      results[i].error = "This path cannot be deleted";
    else (isWindowsSftpPath(x.path) ? windows : posix).push(i);
  });

  const groups: number[][] = [];
  let current: number[] = [];
  let size = 0;
  for (const i of posix) {
    const cost = items[i].path.length * 2 + 120;
    if (current.length > 0 && size + cost > MAX_SCRIPT_CHARS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(i);
    size += cost;
  }
  if (current.length > 0) groups.push(current);

  for (const group of groups) {
    if (shouldStop()) {
      for (const i of group) results[i].error = "Cancelled";
      continue;
    }
    const status = await runPosixGroup(
      session,
      group.map((i) => items[i]),
      false,
    );
    // Only paths rm said were denied are retried with sudo, never other failures.
    const denied: number[] = [];
    group.forEach((i, k) => {
      const s = status.get(k);
      if (s === "OK") return;
      if (s === "DENIED") denied.push(i);
      else results[i].error = "Delete failed";
    });
    if (denied.length > 0 && session.sudoPassword && shouldStop()) {
      for (const i of denied) results[i].error = "Cancelled";
    } else if (denied.length > 0 && session.sudoPassword) {
      const retry = await runPosixGroup(
        session,
        denied.map((i) => items[i]),
        true,
      );
      denied.forEach((i, k) => {
        if (retry.get(k) !== "OK") results[i].error = "Delete failed";
      });
    } else {
      for (const i of denied) {
        results[i].error = "Permission denied";
        results[i].needsSudo = true;
      }
    }
  }

  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(WINDOWS_CONCURRENCY, windows.length) },
      async () => {
        while (next < windows.length) {
          const i = windows[next++];
          if (shouldStop()) {
            results[i].error = "Cancelled";
            continue;
          }
          const { commandWithSuccess } = buildDeleteCommand(
            items[i].path,
            items[i].isDirectory,
          );
          const result = await execBuffer(session, commandWithSuccess);
          if (!result.stdout.toString().includes("SUCCESS"))
            results[i].error = result.stderr.trim() || "Delete failed";
        }
      },
    ),
  );
  return results;
}
