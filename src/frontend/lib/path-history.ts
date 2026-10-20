interface Entry {
  path: string;
  count: number;
  last: number;
}

const KEY_PREFIX = "termix:file-manager:path-history:";

function read(hostId: number | string): Entry[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + hostId);
    const parsed = raw ? (JSON.parse(raw) as Entry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(hostId: number | string, entries: Entry[]): void {
  try {
    localStorage.setItem(KEY_PREFIX + hostId, JSON.stringify(entries));
  } catch {
    // storage unavailable
  }
}

/** Counts a visit to a folder, keeping the newest `limit` folders. */
export function recordPath(
  hostId: number | string,
  path: string,
  limit: number,
): void {
  if (!path || path === ".") return;
  const entries = read(hostId);
  // Always newer than the last visit, so two quick visits keep their order.
  const now = Math.max(Date.now(), (entries[0]?.last ?? 0) + 1);
  const found = entries.find((entry) => entry.path === path);
  if (found) {
    found.count += 1;
    found.last = now;
  } else {
    entries.push({ path, count: 1, last: now });
  }
  entries.sort((a, b) => b.last - a.last);
  write(hostId, entries.slice(0, Math.max(1, limit)));
}

export interface PathHistory {
  frequent: string[];
  recent: string[];
}

/** The most visited folders, and the latest ones that are not among them. */
export function listPaths(
  hostId: number | string,
  frequentCount = 5,
): PathHistory {
  const entries = read(hostId);
  const frequent = [...entries]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, frequentCount)
    .map((entry) => entry.path);
  const recent = [...entries]
    .sort((a, b) => b.last - a.last)
    .map((entry) => entry.path)
    .filter((path) => !frequent.includes(path));
  return { frequent, recent };
}

export function clearPaths(hostId: number | string): void {
  write(hostId, []);
}

/** Single quotes a path for a POSIX shell. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
