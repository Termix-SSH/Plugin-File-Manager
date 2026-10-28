import type { FileEntry, SFTPWrapper } from "ssh2";

export function readDirectory(
  sftp: SFTPWrapper,
  path: string,
  done: (error: Error | null, entries: FileEntry[]) => void,
  onCloseError: (error: Error) => void,
): void {
  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

  const collect = async (): Promise<FileEntry[]> => {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.opendir(path, (error, handle) =>
        error ? reject(error) : resolve(handle),
      );
    });
    const batches: FileEntry[][] = [];
    let nextBatch = 0;
    let stopped = false;
    let failure: Error | undefined;

    const read = async () => {
      while (!stopped) {
        const index = nextBatch++;
        try {
          const entries = await new Promise<FileEntry[] | false>(
            (resolve, reject) => {
              // Keep dot-only batches nonempty so [] really indicates no progress.
              sftp.readdir(handle, { full: true }, (error, entries) =>
                error ? reject(error) : resolve(entries),
              );
            },
          );
          if (entries === false) {
            stopped = true;
          } else if (entries.length === 0) {
            throw new Error("SFTP readdir returned an empty batch without EOF");
          } else {
            batches[index] = entries;
          }
        } catch (error) {
          stopped = true;
          if ((error as { code?: number })?.code !== 1) {
            failure ??= asError(error);
          }
        }
      }
    };

    // EOF can overtake an earlier data/error reply; both readers must drain.
    await Promise.all([read(), read()]);
    try {
      sftp.close(handle, (error) => {
        if (error) onCloseError(error);
      });
    } catch (error) {
      onCloseError(asError(error));
    }
    if (failure) throw failure;
    const seen = new Set([".", ".."]);
    return batches.flat().filter((entry) => {
      if (seen.has(entry.filename)) return false;
      seen.add(entry.filename);
      return true;
    });
  };

  void collect().then(
    (entries) => done(null, entries),
    (error: unknown) => done(asError(error), []),
  );
}
