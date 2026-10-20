export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "-";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  const formattedSize =
    size < 10 && unitIndex > 0 ? size.toFixed(1) : Math.round(size).toString();
  return `${formattedSize} ${units[unitIndex]}`;
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await task(item);
      }
    }),
  );
}

/** Decodes base64 in slices so no full-size binary string is ever built. */
export function base64ToBytes(b64: string): Uint8Array {
  const SLICE = 3 * 1024 * 1024; // multiple of 4 chars per slice stays aligned
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(Math.floor((b64.length * 3) / 4) - pad);
  let offset = 0;
  for (let i = 0; i < b64.length; i += SLICE) {
    const bin = atob(b64.slice(i, i + SLICE));
    for (let j = 0; j < bin.length; j++) out[offset++] = bin.charCodeAt(j);
  }
  return out;
}

/**
 * Sends `items` to `trash` in batches, `limit` batches at a time. `trash`
 * returns one entry per item in order; an entry with `error` failed on its own
 * and the rest carry on. A thrown batch (or an abort) stops new batches, waits
 * for those running, and leaves the untouched items out of `done`, so `done`
 * is exact when this returns.
 */
export async function trashInBatches<T>(
  items: T[],
  size: number,
  limit: number,
  trash: (batch: T[]) => Promise<Array<{ error?: string }>>,
  opts: {
    signal?: AbortSignal;
    onProgress?: (finished: number) => void;
    /** Items of a batch the server confirmed trashed, as each batch returns. */
    onBatchDone?: (trashed: T[]) => void;
  } = {},
): Promise<{
  done: Set<T>;
  failed: Set<T>;
  itemError?: string;
  thrown?: unknown;
}> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    batches.push(items.slice(i, i + size));
  const done = new Set<T>();
  const failed = new Set<T>();
  let finished = 0;
  let itemError: string | undefined;
  let thrown: unknown;
  await runWithConcurrency(batches, limit, async (batch) => {
    if (thrown !== undefined || opts.signal?.aborted) return;
    try {
      const results = await trash(batch);
      const trashed: T[] = [];
      batch.forEach((item, i) => {
        const error = results[i]?.error;
        if (error === undefined && results[i]) {
          done.add(item);
          trashed.push(item);
        } else {
          failed.add(item);
          itemError ??= error ?? "No result";
        }
      });
      opts.onBatchDone?.(trashed);
    } catch (error) {
      thrown = error ?? new Error("Batch failed");
      return;
    }
    finished += batch.length;
    opts.onProgress?.(finished);
  });
  return { done, failed, itemError, thrown };
}

/** Resolves once no delete is running, including ones started while waiting. */
export async function waitForDeletes(ref: {
  current: Promise<unknown>;
}): Promise<void> {
  let seen: Promise<unknown>;
  do {
    seen = ref.current;
    await seen;
  } while (seen !== ref.current);
}
