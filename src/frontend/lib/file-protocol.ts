import { useSyncExternalStore } from "react";

export type RemoteProtocolId = "ftp" | "webdav" | "smb";
export type FileProtocol = "sftp" | RemoteProtocolId;

/** The protocol a person picked for a host, when it has more than one. */
const KEY_PREFIX = "termix-fm-protocol:";
const listeners = new Set<() => void>();
const PROTOCOLS: readonly FileProtocol[] = ["sftp", "ftp", "webdav", "smb"];

function key(hostId: number | string | null | undefined): string | null {
  return hostId == null ? null : KEY_PREFIX + hostId;
}

export function getPreferredProtocol(
  hostId: number | string | null | undefined,
): FileProtocol | null {
  const k = key(hostId);
  if (!k) return null;
  try {
    const value = localStorage.getItem(k);
    return PROTOCOLS.includes(value as FileProtocol)
      ? (value as FileProtocol)
      : null;
  } catch {
    return null;
  }
}

export function setPreferredProtocol(
  hostId: number | string | null | undefined,
  protocol: FileProtocol,
) {
  const k = key(hostId);
  if (!k) return;
  try {
    localStorage.setItem(k, protocol);
  } catch {
    // Storage blocked, the choice lasts until reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreferredProtocol(
  hostId: number | string | null | undefined,
): FileProtocol | null {
  return useSyncExternalStore(subscribe, () => getPreferredProtocol(hostId));
}
