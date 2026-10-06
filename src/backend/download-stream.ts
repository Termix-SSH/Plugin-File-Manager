import { Readable } from "node:stream";
import type { SFTPWrapper } from "ssh2";
import {
  promisifySftpClose,
  promisifySftpOpen,
  SFTP_OPEN_READ,
} from "./sftp-promisify.js";

/** Used when the server's read limit is unknown. */
const DEFAULT_CHUNK_SIZE = 32 * 1024;
/** OpenSSH serves ~254 KiB per READ. */
const MAX_CHUNK_SIZE = 256 * 1024;
/** In-flight READ requests; with OpenSSH limits that is ~8 MiB of read-ahead. */
const CONCURRENCY = 32;

/**
 * ssh2 splits a READ longer than its negotiated limit into serial follow-up
 * requests, so chunks never exceed it.
 */
function chunkSizeFor(sftp: SFTPWrapper): number {
  const maxReadLen = (sftp as unknown as { _maxReadLen?: number })._maxReadLen;
  if (!maxReadLen || !Number.isFinite(maxReadLen) || maxReadLen <= 0)
    return DEFAULT_CHUNK_SIZE;
  return Math.min(Math.floor(maxReadLen), MAX_CHUNK_SIZE);
}

/** Sliding read-ahead window; chunks keep file order even if replies arrive out of order. */
export function createDownloadStream(
  sftp: SFTPWrapper,
  path: string,
  size: number,
): Readable {
  const chunkSize = chunkSizeFor(sftp);
  const stream = Readable.from(readFile(), {
    objectMode: false,
    highWaterMark: chunkSize,
  });
  return stream;

  async function readChunk(handle: Buffer, position: number, length: number) {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length && !stream.destroyed) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        sftp.read(
          handle,
          buffer,
          offset,
          length - offset,
          position + offset,
          (err, bytes) => (err ? reject(err) : resolve(bytes)),
        );
      });
      if (bytesRead === 0)
        throw new Error("File ended before the advertised size");
      offset += bytesRead;
    }
    return buffer;
  }

  async function* readFile() {
    if (stream.destroyed) return;
    const handle = await promisifySftpOpen(sftp, path, SFTP_OPEN_READ, 0o666);
    const window: Promise<Buffer>[] = [];
    let failed = false;
    let position = 0;
    const fill = () => {
      while (
        window.length < CONCURRENCY &&
        position < size &&
        !failed &&
        !stream.destroyed
      ) {
        const length = Math.min(chunkSize, size - position);
        const read = readChunk(handle, position, length);
        // A failure stops new reads; the error surfaces when it reaches the head.
        read.catch(() => {
          failed = true;
        });
        window.push(read);
        position += length;
      }
    };
    try {
      fill();
      while (window.length > 0) {
        const chunk = await window.shift()!;
        if (stream.destroyed) return;
        // Refill before yielding so reads overlap with the consumer.
        fill();
        yield chunk;
      }
    } finally {
      // Settle all reads before closing the shared handle after an error.
      await Promise.allSettled(window);
      await promisifySftpClose(sftp, handle);
    }
  }
}
