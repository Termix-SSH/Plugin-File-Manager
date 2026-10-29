import type { FileItem } from "../host-types";

export function createDirectoryPrefetch({
  read,
  isCached,
  run,
}: {
  read: (path: string) => Promise<unknown>;
  isCached: (path: string) => boolean;
  run: (task: () => Promise<unknown>) => boolean;
}) {
  let disposed = false;
  let foreground = false;
  let active: string | undefined;
  let queue: string[] = [];
  let hoverPath: string | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let predictionTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  function drain() {
    if (disposed || foreground || active) return;
    const path = queue.shift();
    if (!path) return;
    if (isCached(path)) {
      drain();
      return;
    }
    active = path;
    // Admission can defer the callback; navigation must still be able to veto it.
    const admitted = run(async () => {
      try {
        if (!disposed && !foreground && active === path && !isCached(path)) {
          await read(path);
        }
      } finally {
        active = undefined;
        if (!disposed && !foreground) drainTimer = setTimeout(drain, 0);
      }
    });
    if (!admitted) {
      active = undefined;
      queue = [];
    }
  }

  function enqueue(path: string, priority: boolean) {
    if (disposed || foreground || active === path || isCached(path)) return;
    queue = queue.filter((entry) => entry !== path);
    if (priority) queue.unshift(path);
    else queue.push(path);
    queue = queue.slice(0, 2);
    drain();
  }

  function cancelIntent(path: string) {
    if (hoverPath === path) {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
      hoverPath = undefined;
    }
    queue = queue.filter((entry) => entry !== path);
  }

  function clear() {
    clearTimeout(hoverTimer);
    clearTimeout(predictionTimer);
    clearTimeout(drainTimer);
    hoverTimer = predictionTimer = undefined;
    drainTimer = undefined;
    hoverPath = undefined;
    queue = [];
  }

  return {
    intent(path: string) {
      if (hoverPath) cancelIntent(hoverPath);
      enqueue(path, true);
    },
    hover(path: string) {
      if (hoverPath) cancelIntent(hoverPath);
      if (disposed || foreground) return;
      hoverPath = path;
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        enqueue(path, true);
      }, 100);
    },
    cancelIntent,
    predict(parent: string, entries: readonly FileItem[]) {
      clearTimeout(predictionTimer);
      if (disposed || foreground) return;
      const prefix = parent === "/" ? "/" : `${parent.replace(/\/$/, "")}/`;
      const paths: string[] = [];
      for (const entry of entries) {
        const name = entry.path.slice(prefix.length);
        if (
          entry.type === "directory" &&
          entry.path.startsWith(prefix) &&
          name &&
          name !== "." &&
          name !== ".." &&
          !name.includes("/") &&
          !paths.includes(entry.path) &&
          !isCached(entry.path)
        ) {
          paths.push(entry.path);
          if (paths.length === 2) break;
        }
      }
      predictionTimer = setTimeout(() => {
        predictionTimer = undefined;
        for (const path of paths) enqueue(path, false);
      }, 200);
    },
    setForeground(value: boolean) {
      foreground = value;
      if (value) clear();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
