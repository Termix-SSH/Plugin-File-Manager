import { useEffect, useState } from "react";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { DraggableWindow } from "./DraggableWindow.tsx";
import { useWindowManager } from "./WindowManager.tsx";
import {
  getDirectorySizes,
  getFileProperties,
  type FileProperties,
} from "../api/properties-api";
import { formatFileSize } from "../file-manager-utils.ts";
import type { FileItem } from "../host-types";

interface PropertiesWindowProps {
  windowId: string;
  file: FileItem;
  sshSessionId: string;
  initialX?: number;
  initialY?: number;
  /** Absent when the file is read-only or the protocol has no chmod. */
  onChangePermissions?: (file: FileItem) => void;
}

const when = (seconds?: number) =>
  seconds ? new Date(seconds * 1000).toLocaleString() : "-";

export function PropertiesWindow({
  windowId,
  file,
  sshSessionId,
  initialX = 150,
  initialY = 100,
  onChangePermissions,
}: PropertiesWindowProps) {
  const { t } = useTranslation();
  const { closeWindow, maximizeWindow, focusWindow, windows } =
    useWindowManager();
  const [props, setProps] = useState<FileProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderSize, setFolderSize] = useState<number | null | undefined>();

  useEffect(() => {
    let cancelled = false;
    getFileProperties(sshSessionId, file.path)
      .then(async (p) => {
        if (cancelled) return;
        setProps(p);
        if (p.type === "directory" || p.targetIsDirectory) {
          setFolderSize(undefined);
          const sizes = await getDirectorySizes(sshSessionId, [
            file.path,
          ]).catch(() => ({}) as Record<string, number>);
          if (!cancelled) setFolderSize(sizes[file.path] ?? null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sshSessionId, file.path]);

  const currentWindow = windows.find((w) => w.id === windowId);
  if (!currentWindow) return null;

  const isDir = props?.type === "directory" || props?.targetIsDirectory;
  const sizeText = !props
    ? "-"
    : isDir
      ? folderSize === undefined
        ? t("fileManager.calculating")
        : folderSize === null
          ? t("fileManager.sizeUnavailable")
          : `${formatFileSize(folderSize)} (${folderSize.toLocaleString()} B)`
      : `${formatFileSize(props.size)} (${props.size.toLocaleString()} B)`;

  const rows: [string, string][] = props
    ? [
        [t("fileManager.name"), props.name],
        [t("fileManager.location"), props.path],
        [t("fileManager.type"), t(`fileManager.type_${props.type}`)],
        ...(props.linkTarget
          ? ([[t("fileManager.linkTarget"), props.linkTarget]] as [
              string,
              string,
            ][])
          : []),
        [t("fileManager.size"), sizeText],
        [t("fileManager.created"), when(props.created)],
        [t("fileManager.modified"), when(props.modified)],
        [t("fileManager.accessed"), when(props.accessed)],
        [t("fileManager.permissions"), `${props.permissions} (${props.octal})`],
        [
          t("fileManager.owner"),
          `${props.owner ?? props.uid} / ${props.group ?? props.gid}`,
        ],
      ]
    : [];

  return (
    <DraggableWindow
      label={t("fileManager.properties")}
      title={file.name}
      initialX={initialX}
      initialY={initialY}
      initialWidth={460}
      initialHeight={420}
      minWidth={340}
      minHeight={300}
      onClose={() => closeWindow(windowId)}
      onMaximize={() => maximizeWindow(windowId)}
      onFocus={() => focusWindow(windowId)}
      isMaximized={currentWindow.isMaximized}
      zIndex={currentWindow.zIndex}
    >
      <div className="flex h-full flex-col gap-3 overflow-auto p-4 text-xs">
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : !props ? (
          <p className="text-muted-foreground">
            {t("fileManager.calculating")}
          </p>
        ) : (
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-bold uppercase tracking-widest text-[10px] text-muted-foreground pt-0.5">
                  {label}
                </dt>
                <dd className="break-all select-text">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {props && onChangePermissions && (
          <div className="mt-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChangePermissions(file)}
            >
              {t("fileManager.changePermissions")}
            </Button>
          </div>
        )}
      </div>
    </DraggableWindow>
  );
}
