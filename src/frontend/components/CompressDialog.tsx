import React, { useState, useEffect } from "react";
import {
  Input,
  Label,
  InlineView,
  FormFooter,
} from "@termix-ssh/plugin-sdk/ui";
import { Package } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";

interface CompressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileNames: string[];
  onCompress: (archiveName: string, format: string) => void;
}

export function CompressDialog({
  open,
  onOpenChange,
  fileNames,
  onCompress,
}: CompressDialogProps) {
  const { t } = useTranslation();
  const [archiveName, setArchiveName] = useState("");
  const [format, setFormat] = useState("zip");

  useEffect(() => {
    if (open && fileNames.length > 0) {
      if (fileNames.length === 1) {
        const baseName = fileNames[0].replace(/\.[^/.]+$/, "");
        setArchiveName(baseName);
      } else {
        setArchiveName("archive");
      }
    }
  }, [open, fileNames]);

  const handleCompress = () => {
    if (!archiveName.trim()) return;

    let finalName = archiveName.trim();
    const extensions: Record<string, string> = {
      zip: ".zip",
      "tar.gz": ".tar.gz",
      "tar.bz2": ".tar.bz2",
      "tar.xz": ".tar.xz",
      tar: ".tar",
      "7z": ".7z",
    };

    const expectedExtension = extensions[format];
    if (expectedExtension && !finalName.endsWith(expectedExtension)) {
      finalName += expectedExtension;
    }

    onCompress(finalName, format);
    onOpenChange(false);
  };

  const formats = ["zip", "tar.gz", "tar.bz2", "tar.xz", "tar", "7z"] as const;

  return (
    <InlineView
      open={open}
      onOpenChange={onOpenChange}
      icon={<Package className="size-4" />}
      title={t("fileManager.compressFiles")}
      footer={
        <FormFooter
          onCancel={() => onOpenChange(false)}
          onSave={() => void handleCompress()}
          saveLabel={t("fileManager.compress")}
          disabled={!archiveName.trim()}
        />
      }
    >
      <p className="text-xs text-muted-foreground">
        {t("fileManager.compressFilesDesc", { count: fileNames.length })}
      </p>
      <div className="py-4 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label
            className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            htmlFor="archiveName"
          >
            {t("fileManager.archiveName")}
          </Label>
          <Input
            id="archiveName"
            value={archiveName}
            onChange={(e) => setArchiveName(e.target.value)}
            placeholder={t("fileManager.enterArchiveName")}
            className="rounded-none bg-muted/50 border-border text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCompress();
              }
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {t("fileManager.compressionFormat")}
          </Label>
          <div className="grid grid-cols-3 gap-1">
            {formats.map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`py-2 text-xs font-bold uppercase tracking-widest border transition-colors ${
                  format === f
                    ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                .{f}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-none bg-muted/10 border border-border p-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
            {t("fileManager.selectedFiles")}:
          </p>
          <ul className="text-xs space-y-1">
            {fileNames.slice(0, 5).map((name, index) => (
              <li key={index} className="truncate text-foreground font-medium">
                {name}
              </li>
            ))}
            {fileNames.length > 5 && (
              <li className="text-muted-foreground">
                {t("fileManager.andMoreFiles", {
                  count: fileNames.length - 5,
                })}
              </li>
            )}
          </ul>
        </div>
      </div>
    </InlineView>
  );
}
