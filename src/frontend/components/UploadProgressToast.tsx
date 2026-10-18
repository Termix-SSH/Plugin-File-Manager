import type { TranslateFn } from "@termix-ssh/plugin-sdk/frontend";
import { ArrowUpFromLine } from "lucide-react";
import { formatTransferMbPerSec } from "../api/transfer-api";
import { formatFileSize } from "../file-manager-utils";
import { TransferProgressBar } from "./TransferProgressBar";

interface UploadProgressToastProps {
  t: TranslateFn;
  doneFiles: number;
  totalFiles: number;
  loaded: number;
  total: number;
  mbPerSec?: number;
  onCancel: () => void;
}

export function UploadProgressToast({
  t,
  doneFiles,
  totalFiles,
  loaded,
  total,
  mbPerSec,
  onCancel,
}: UploadProgressToastProps) {
  const percent =
    total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined;
  const speed = formatTransferMbPerSec(mbPerSec);
  const title = t("fileManager.uploadingFolderFiles", { count: totalFiles });

  return (
    <div className="flex w-[min(calc(100vw-5rem),288px)] max-w-full flex-col gap-2 pr-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium leading-tight">
          <ArrowUpFromLine className="size-3.5 shrink-0 text-accent-brand" />
          <span className="truncate">{title}</span>
        </p>
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          {t("fileManager.cancel")}
        </button>
      </div>
      <TransferProgressBar value={percent} label={title} />
      <div className="flex items-center justify-between gap-3 pr-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate tabular-nums">
          {t("fileManager.uploadFilesDone", {
            done: doneFiles,
            total: totalFiles,
          })}
          {" · "}
          {formatFileSize(loaded)} / {formatFileSize(total)}
        </span>
        <span
          className={`shrink-0 tabular-nums ${speed ? "font-medium text-foreground" : "invisible"}`}
          aria-hidden={!speed}
        >
          {speed || "0 MB/s"}
        </span>
      </div>
    </div>
  );
}
