import { useSyncExternalStore } from "react";

/**
 * A per host guard against misclicks: while locked, the file manager only
 * browses, opens, previews and downloads. It is not a permission.
 */
const KEY_PREFIX = "termix-fm-locked:";
const listeners = new Set<() => void>();

function key(hostId: number | string | null | undefined): string | null {
  return hostId == null ? null : KEY_PREFIX + hostId;
}

export function isEditLocked(hostId: number | string | null | undefined) {
  const k = key(hostId);
  if (!k) return false;
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
}

export function setEditLocked(
  hostId: number | string | null | undefined,
  locked: boolean,
) {
  const k = key(hostId);
  if (!k) return;
  try {
    if (locked) localStorage.setItem(k, "1");
    else localStorage.removeItem(k);
  } catch {
    // Storage blocked, the lock just won't stick.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditLocked(hostId: number | string | null | undefined) {
  return useSyncExternalStore(subscribe, () => isEditLocked(hostId));
}
