type SFTPWrapper = import("ssh2").SFTPWrapper;

const WRITE_CHUNK = 64 * 1024;
const MAX_IN_FLIGHT = 64;

/**
 * Streams `source` into a remote file with many WRITE requests in flight.
 * ssh2's createWriteStream waits for each ack before the next write, which
 * caps throughput at one chunk per round trip.
 */
export function pipelineWriteToSftp(
  sftp: SFTPWrapper,
  path: string,
  source: NodeJS.ReadableStream,
): { done: Promise<number>; abort: () => void } {
  let abortHook: () => void = () => {};

  const done = new Promise<number>((resolve, reject) => {
    let handle: Buffer | undefined;
    let inFlight = 0;
    let ended = false;
    let settled = false;
    let written = 0;
    let position = 0;
    const queue: Buffer[] = [];

    const closeHandle = (cb: (err?: Error) => void) => {
      if (!handle) return cb();
      const h = handle;
      handle = undefined;
      sftp.close(h, (err) => cb(err ?? undefined));
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      queue.length = 0;
      source.removeListener("data", onData);
      // Drain the rest of the body so the HTTP request can finish cleanly.
      source.resume();
      closeHandle(() => reject(err));
    };
    const maybeFinish = () => {
      if (settled || !ended || inFlight > 0 || queue.length > 0) return;
      settled = true;
      closeHandle((err) => (err ? reject(err) : resolve(written)));
    };
    // Dispatch queued bytes while fewer than MAX_IN_FLIGHT writes are pending.
    const pump = () => {
      while (
        !settled &&
        handle &&
        queue.length > 0 &&
        inFlight < MAX_IN_FLIGHT
      ) {
        const buf = queue[0];
        const len = Math.min(WRITE_CHUNK, buf.length);
        const piece = buf.subarray(0, len);
        if (len === buf.length) queue.shift();
        else queue[0] = buf.subarray(len);
        inFlight++;
        sftp.write(handle, piece, 0, len, position, (err) => {
          inFlight--;
          if (err) return fail(err);
          written += len;
          pump();
          maybeFinish();
        });
        position += len;
      }
      if (!settled && !ended && queue.length === 0) source.resume();
    };
    function onData(chunk: Buffer) {
      source.pause();
      queue.push(chunk);
      pump();
    }

    abortHook = () => fail(new Error("Upload aborted"));
    // Attached before open() so an early source error rejects instead of throwing.
    source.on("error", fail);
    source.once("end", () => {
      ended = true;
      maybeFinish();
    });

    sftp.open(path, "w", (err, h) => {
      if (err) return fail(err);
      if (settled) {
        sftp.close(h, () => {});
        return;
      }
      handle = h;
      source.on("data", onData);
    });
  });

  return { done, abort: () => abortHook() };
}
