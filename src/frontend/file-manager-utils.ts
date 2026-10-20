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
