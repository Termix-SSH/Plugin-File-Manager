import { useCallback, useEffect, useRef, useState } from "react";
import { History, RefreshCw, SquareTerminal } from "lucide-react";
import {
  useSettings,
  useTranslation,
  type CompanionProps,
  type CompanionDefaults,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@termix-ssh/plugin-sdk/ui";
import { FileManager } from "./FileManager.tsx";
import type { SSHHost } from "./host-types";
import {
  clearPaths,
  listPaths,
  recordPath,
  shellQuote,
} from "./lib/path-history";

interface CompanionSettings {
  autoOpen: boolean;
  side: "left" | "right" | "bottom";
  size: number;
  edgeButton: boolean;
  follow: boolean;
  interval: number;
  historySize: number;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function useCompanionSettings(): CompanionSettings {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    autoOpen: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: numberOr(values.companionSize, 380),
    edgeButton: values.companionEdgeButton !== false,
    follow: values.companionFollowTerminal !== false,
    interval: Math.min(
      30,
      Math.max(1, numberOr(values.companionSyncInterval, 3)),
    ),
    historySize: Math.min(
      100,
      Math.max(5, numberOr(values.companionHistorySize, 20)),
    ),
  };
}

/** Starting state of the panel, from the user's settings. */
export function useFilesCompanionDefaults(): CompanionDefaults {
  const settings = useCompanionSettings();
  return {
    open: settings.autoOpen,
    side: settings.side,
    size: settings.size,
    edgeButton: settings.edgeButton,
  };
}

interface TerminalHandle {
  getCwd?: () => Promise<string | null>;
  sendInput?: (data: string) => void;
}

export function FilesCompanion({
  host,
  sshHost,
  getHandle,
  isVisible,
}: CompanionProps) {
  const { t } = useTranslation();
  const settings = useCompanionSettings();
  const [follow, setFollow] = useState(settings.follow);
  const [ready, setReady] = useState(false);
  const [startPath, setStartPath] = useState<string | undefined>();
  const [target, setTarget] = useState<{ path: string; nonce: number }>();
  const currentPathRef = useRef<string>(".");
  const terminalPathRef = useRef<string | null>(null);
  const nonceRef = useRef(0);
  const [terminalPath, setTerminalPath] = useState<string | null>(null);
  const hostId = host?.id ?? "unknown";
  const [history, setHistory] = useState(() => listPaths(hostId));

  const readCwd = useCallback(async (): Promise<string | null> => {
    const handle = getHandle() as TerminalHandle | null;
    if (!handle?.getCwd) return null;
    try {
      return await handle.getCwd();
    } catch {
      return null;
    }
  }, [getHandle]);

  const goTo = useCallback((path: string) => {
    nonceRef.current += 1;
    setTarget({ path, nonce: nonceRef.current });
  }, []);

  // Open in the terminal's folder the first time the panel shows.
  useEffect(() => {
    if (ready || !isVisible) return;
    let cancelled = false;
    void readCwd().then((cwd) => {
      if (cancelled) return;
      terminalPathRef.current = cwd;
      setTerminalPath(cwd);
      setStartPath(cwd ?? undefined);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, isVisible, readCwd]);

  // Follow the terminal while the panel is showing.
  useEffect(() => {
    if (!ready || !isVisible || !follow) return;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void readCwd()
        .then((cwd) => {
          console.debug("[files-panel] terminal folder", cwd);
          setTerminalPath(cwd);
          if (!cwd || cwd === terminalPathRef.current) return;
          terminalPathRef.current = cwd;
          goTo(cwd);
        })
        .finally(() => {
          busy = false;
        });
    }, settings.interval * 1000);
    return () => clearInterval(timer);
  }, [ready, isVisible, follow, settings.interval, readCwd, goTo]);

  const syncNow = useCallback(() => {
    void readCwd().then((cwd) => {
      console.debug("[files-panel] terminal folder", cwd);
      setTerminalPath(cwd);
      if (!cwd) return;
      terminalPathRef.current = cwd;
      goTo(cwd);
    });
  }, [readCwd, goTo]);

  const sendToTerminal = useCallback(
    (path: string) => {
      const handle = getHandle() as TerminalHandle | null;
      if (!handle?.sendInput || !path || path === ".") return;
      handle.sendInput(`cd ${shellQuote(path)}\r`);
      terminalPathRef.current = path;
    },
    [getHandle],
  );

  const onPathChange = useCallback(
    (path: string) => {
      currentPathRef.current = path;
      recordPath(hostId, path, settings.historySize);
    },
    [hostId, settings.historySize],
  );

  const canTerminal = !!(getHandle() as TerminalHandle | null)?.getCwd;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1 border-b border-border px-1.5 py-1">
        <DropdownMenu
          onOpenChange={(open) => open && setHistory(listPaths(hostId))}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              title={t("companion.history")}
            >
              <History className="size-3.5" />
              {t("companion.history")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-80">
            {history.frequent.length === 0 && history.recent.length === 0 && (
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("companion.historyEmpty")}
              </DropdownMenuLabel>
            )}
            {history.frequent.length > 0 && (
              <DropdownMenuLabel>{t("companion.frequent")}</DropdownMenuLabel>
            )}
            {history.frequent.map((path) => (
              <DropdownMenuItem key={`f${path}`} onClick={() => goTo(path)}>
                <span className="truncate">{path}</span>
              </DropdownMenuItem>
            ))}
            {history.recent.length > 0 && (
              <DropdownMenuLabel>{t("companion.recent")}</DropdownMenuLabel>
            )}
            {history.recent.map((path) => (
              <DropdownMenuItem key={`r${path}`} onClick={() => goTo(path)}>
                <span className="truncate">{path}</span>
              </DropdownMenuItem>
            ))}
            {(history.frequent.length > 0 || history.recent.length > 0) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    clearPaths(hostId);
                    setHistory(listPaths(hostId));
                  }}
                >
                  {t("companion.clearHistory")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span
          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
          title={t("companion.terminalAt")}
        >
          {canTerminal
            ? `${t("companion.terminalAt")} ${terminalPath ?? "?"}`
            : ""}
        </span>
        {canTerminal && (
          <>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              {t("companion.follow")}
            </label>
            <button
              type="button"
              className="p-1 text-muted-foreground hover:text-foreground"
              title={t("companion.syncNow")}
              onClick={syncNow}
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              type="button"
              className="p-1 text-muted-foreground hover:text-foreground"
              title={t("companion.cdTerminal")}
              onClick={() => sendToTerminal(currentPathRef.current)}
            >
              <SquareTerminal className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {ready && (
          <FileManager
            initialHost={sshHost as unknown as SSHHost}
            initialPath={startPath}
            externalPath={target}
            onPathChange={onPathChange}
            isVisible={isVisible}
            compact
          />
        )}
      </div>
    </div>
  );
}
