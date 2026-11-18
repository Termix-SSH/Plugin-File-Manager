import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";

import { TransferProgressBar } from "./TransferProgressBar";

export type ArchiveProgressState = {
  id: string;
  name: string;
  /** Entries written so far, when the host reports them. */
  extracted?: number;
  /** Entries in the archive, when the host could count them. */
  total?: number;
  error?: string;
};

/**
 * One line in the file list footer per archive being extracted. Drawn in the
 * panel itself so it stays up for as long as the extraction runs.
 */
export function ArchiveProgress({
  items,
  t,
}: {
  items: ArchiveProgressState[];
  t: TranslateFn;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 min-w-0 flex-1 px-3">
      {items.map((item) => {
        const label = t("fileManager.extractingArchive", { name: item.name });
        if (item.error) {
          return (
            <span
              key={item.id}
              role="alert"
              className="truncate text-destructive"
              title={item.error}
            >
              {t("fileManager.extractFailed")}: {item.name} - {item.error}
            </span>
          );
        }
        const percent =
          item.total && item.extracted !== undefined
            ? (item.extracted / item.total) * 100
            : undefined;
        return (
          <div key={item.id} className="flex items-center gap-2 min-w-0">
            <span className="truncate">{label}</span>
            <div className="w-16 sm:w-32 shrink-0">
              <TransferProgressBar value={percent} label={label} />
            </div>
            {item.extracted !== undefined && (
              <span className="shrink-0 tabular-nums">
                {item.total
                  ? t("fileManager.extractProgressOf", {
                      extracted: item.extracted,
                      total: item.total,
                    })
                  : t("fileManager.extractProgressCount", {
                      count: item.extracted,
                    })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
