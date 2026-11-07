import { useCallback, useEffect, useRef } from "react";
import { downloadSSHFile } from "../api/ssh-file-operations-api";
import type { FileItem } from "../host-types";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20;

interface Ready {
  tempId: string;
  size: number;
}

type DragApi = NonNullable<typeof window.electronAPI> & {
  startDragFiles: (tempIds: string[]) => void;
};

function api(): DragApi | undefined {
  if (typeof window === "undefined") return undefined;
  const a = window.electronAPI as Partial<DragApi> | undefined;
  return a?.isElectron && a.startDragFiles ? (a as DragApi) : undefined;
}

// Downloads files to temp when a drag is likely, so dragstart can hand the
// OS real files synchronously. Desktop app only.
export function useNativeDragOut(sshSessionId: string) {
  const ready = useRef(new Map<string, Ready>());
  const pending = useRef(new Map<string, Promise<void>>());

  const cleanup = useCallback(() => {
    const a = window.electronAPI;
    for (const { tempId } of ready.current.values()) {
      void a?.cleanupTempFile(tempId);
    }
    ready.current.clear();
    pending.current.clear();
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    ready.current.clear();
  }, [sshSessionId]);

  const key = (f: FileItem) => `${sshSessionId}:${f.path}:${f.size ?? 0}`;

  const eligible = (files: FileItem[]) => {
    if (files.length === 0 || files.length > MAX_FILES) return false;
    if (files.some((f) => f.type !== "file")) return false;
    const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
    return total <= MAX_BYTES;
  };

  const prefetch = useCallback(
    (files: FileItem[]) => {
      const a = api();
      if (!a || !sshSessionId || !eligible(files)) return;
      for (const file of files) {
        const k = key(file);
        if (ready.current.has(k) || pending.current.has(k)) continue;
        const job = (async () => {
          try {
            const res = await downloadSSHFile(sshSessionId, file.path);
            if (!res?.content) return;
            const tmp = await a.createTempFile({
              fileName: file.name,
              content: res.content,
              encoding: "base64",
            });
            if (tmp.success && tmp.tempId) {
              ready.current.set(k, {
                tempId: tmp.tempId,
                size: file.size ?? 0,
              });
            }
          } catch {
            // The Save As fallback still works
          } finally {
            pending.current.delete(k);
          }
        })();
        pending.current.set(k, job);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sshSessionId],
  );

  // Sync on purpose: Electron only accepts startDrag inside dragstart.
  const start = useCallback(
    (files: FileItem[]) => {
      const a = api();
      if (!a || !eligible(files)) return false;
      const ids: string[] = [];
      for (const file of files) {
        const r = ready.current.get(key(file));
        if (!r) return false;
        ids.push(r.tempId);
      }
      a.startDragFiles(ids);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sshSessionId],
  );

  return { prefetch, start, cleanup };
}
