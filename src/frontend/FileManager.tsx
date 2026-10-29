import { Folder } from "lucide-react";
import { fileManagerHostSetting } from "./host-settings";
import { getErrorMessage } from "./lib/error-message";
import { fileManagerApi } from "./api/client";
import { subscribeLocalEvents } from "./lib/local-events";
/* eslint-disable react-hooks/exhaustive-deps */
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { asHttpError } from "./lib/http-error";
import { cn, PanelShell } from "@termix-ssh/plugin-sdk/ui";
import { FileManagerGrid } from "./FileManagerGrid.tsx";
import { filterAndSortFiles } from "./file-list.ts";
import { FileManagerSidebar, type SidebarItem } from "./FileManagerSidebar.tsx";
import { FileManagerContextMenu } from "./FileManagerContextMenu.tsx";
import { useFileSelection } from "./hooks/useFileSelection.ts";
import { useDragAndDrop } from "./hooks/useDragAndDrop.ts";
import {
  WindowManager,
  useWindowManager,
} from "./components/WindowManager.tsx";
import { FileWindow } from "./components/FileWindow.tsx";
import { DownloadProgressToast } from "./components/DownloadProgressToast.tsx";
import { UploadProgressToast } from "./components/UploadProgressToast.tsx";
import { DiffWindow } from "./components/DiffWindow.tsx";
import { useDragToDesktop } from "./hooks/useDragToDesktop";
import { useDragToSystemDesktop } from "./hooks/useDragToSystemDesktop";
import { useConfirm } from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { FileManagerDialogs } from "./FileManagerDialogs.tsx";
import { PassphraseDialog } from "@termix-ssh/plugin-sdk/ui";
import { FileManagerToolbar } from "./FileManagerToolbar.tsx";
import { LocalFilePane } from "./LocalFilePane.tsx";
import { useLocalTransfers } from "./hooks/useLocalTransfers.ts";
import { usePaneWidth } from "./hooks/usePaneWidth.ts";
import { PaneResizeHandle } from "./components/PaneResizeHandle.tsx";
import { isLocalFileBrowserAvailable } from "./lib/local-files";
import { TransferToHostDialog } from "./components/TransferToHostDialog.tsx";
import { FileManagerTrashDialog } from "./FileManagerTrashDialog.tsx";
import { TerminalWindow } from "./components/TerminalWindow.tsx";
import type { SSHHost, FileItem } from "./host-types";
import {
  ConnectionLogProvider,
  useConnectionLog,
  ConnectionScreen,
} from "@termix-ssh/plugin-sdk/ui";
import { ConnectionLogPanel } from "@termix-ssh/plugin-sdk/ui";
import {
  usePluginUiPreferences,
  invokeAction,
  useSettings,
  useConnectionRetry,
  logActivity,
} from "@termix-ssh/plugin-sdk/frontend";
import { copyToClipboard } from "@termix-ssh/plugin-sdk/ui";
import {
  listSSHFiles,
  readSSHFile,
  writeSSHFile,
  downloadSSHFile,
  resolveSSHPath,
  uploadSSHFile,
  createSSHFile,
  createSSHFolder,
  deleteSSHItem,
  copySSHItem,
  trashSSHItems,
  cancelDeleteItems,
  renameSSHItem,
  moveSSHItem,
  connectSSH,
  verifySSHTOTP,
  verifySSHBrowserSignIn,
  getSSHStatus,
  keepSSHAlive,
  identifySSHSymlink,
  changeSSHPermissions,
  extractSSHArchive,
  compressSSHFiles,
  setSudoPassword,
} from "./api/ssh-file-operations-api";
import {
  addRecentFile,
  addPinnedFile,
  removePinnedFile,
  removeRecentFile,
  addFolderShortcut,
  getPinnedFiles,
} from "./api/file-manager-data-api";
import {
  transferToHost,
  addTransferRecent,
  type TransferMethodPreference,
} from "./api/transfer-api";
import type { DiskFilesystem, HostDiskInfo } from "./disk-info";
import {
  getAdaptiveResourceBudget,
  markAdaptiveResourceUsed,
  runAdaptiveBackgroundTask,
} from "@termix-ssh/plugin-sdk/ui";
import { shouldPrefetchFileContent } from "./lib/file-content-request-cache";
import { createDirectoryPrefetch } from "./lib/directory-prefetch";
import {
  markFilePreviewUsed,
  preloadFilePreview,
} from "./file-preview-preload";
import { beginTransferProgressMonitoring } from "./transferProgressMonitor.tsx";
import { createFormatTransferMetrics } from "./transferMetricsFormat.ts";
import type {
  CreateIntent,
  FileManagerProps,
  PendingSudoOperation,
  SSHConnectionError,
} from "./file-manager-types.ts";
import {
  base64ToBytes,
  formatFileSize,
  trashInBatches,
  waitForDeletes,
  runWithConcurrency,
} from "./file-manager-utils.ts";
import {
  invalidateCachedFileList,
  peekCachedFileList,
  updateCachedFileList,
} from "./lib/file-list-request-cache";
import {
  addOptimisticItem,
  childPath,
  removePaths,
  renameOptimisticItem,
  restoreItems,
} from "./optimistic-file-list";

/** Paths per trash request, and requests in flight (backend adds its own pool). */
const TRASH_BATCH_SIZE = 200;
const TRASH_BATCHES_IN_FLIGHT = 3;
const LOCAL_PANE_OPEN_STORAGE_KEY = "termix:file-manager:local-pane:open";
const SIDEBAR_OPEN_STORAGE_KEY = "termix:file-manager:sidebar:open";
const LOCAL_PANE_WIDTH_STORAGE_KEY = "termix:file-manager:local-pane:width";
const LOCAL_PANE_MIN_WIDTH = 300;
const LOCAL_PANE_DEFAULT_WIDTH = 440;
const SIDEBAR_WIDTH_STORAGE_KEY = "termix:file-manager:sidebar:width";
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_DEFAULT_WIDTH = 224; // matches the previous fixed w-56

const LARGE_FILE_WARNING_SIZE = 50 * 1024 * 1024;

function FileManagerContent({
  initialHost,
  initialFilePath,
  initialPath,
  onClose,
  onOpenTerminalTab,
  isVisible = true,
  compact = false,
  externalPath,
  onPathChange,
}: FileManagerProps) {
  const { openWindow } = useWindowManager();
  const { t } = useTranslation();
  const formatTransferMetrics = useMemo(
    () => createFormatTransferMetrics(t),
    [t],
  );
  const confirm = useConfirm();
  const confirmBeforeTrash =
    useSettings("user").values.confirmBeforeTrash !== false;
  const { addLog, clearLogs } = useConnectionLog();

  const [currentHost] = useState<SSHHost | null>(initialHost || null);
  const [currentPath, setCurrentPath] = useState(
    initialPath ||
      fileManagerHostSetting(initialHost, "defaultPath", "") ||
      ".",
  );
  const currentPathRef = useRef(currentPath);
  const pendingDeleteRef = useRef<Promise<unknown>>(Promise.resolve());
  currentPathRef.current = currentPath;
  const lastSuccessfulPathRef = useRef(
    initialPath ||
      fileManagerHostSetting(initialHost, "defaultPath", "") ||
      ".",
  );
  const [navHistory, setNavHistory] = useState<string[]>([
    initialPath ||
      fileManagerHostSetting(initialHost, "defaultPath", "") ||
      ".",
  ]);
  const [navIndex, setNavIndex] = useState(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const directoryRequestRef = useRef(0);
  const [isLoading, setIsLoading] = useState(false);
  const [sshSessionId, setSshSessionId] = useState<string | null>(null);
  const sshSessionIdRef = useRef(sshSessionId);
  sshSessionIdRef.current = sshSessionId;
  const paneVisibleRef = useRef(isVisible);
  paneVisibleRef.current = isVisible;
  const directoryPrefetchRef = useRef<ReturnType<
    typeof createDirectoryPrefetch
  > | null>(null);
  const foregroundDirectoryLoadsRef = useRef(0);
  const [prefetchListing, setPrefetchListing] = useState<{
    sessionId: string;
    path: string;
    files: FileItem[];
  } | null>(null);

  function publishConnectedListing(
    sessionId: string,
    path: string,
    response: Awaited<ReturnType<typeof listSSHFiles>>,
    requestId: number,
  ) {
    // A newer navigation owns the pane; don't let a slow auth listing win.
    if (directoryRequestRef.current !== requestId) return;
    const files = Array.isArray(response) ? response : response?.files || [];
    const listedPath = response.path || path;
    setFiles(files);
    setPrefetchListing({ sessionId, path: listedPath, files });
    setCurrentPath(listedPath);
    setNavHistory((history) =>
      history.map((entry) => (entry === path ? listedPath : entry)),
    );
    lastSuccessfulPathRef.current = listedPath;
  }

  useEffect(() => {
    const scheduler = createDirectoryPrefetch({
      read: (path) => {
        const sessionId = sshSessionIdRef.current;
        return sessionId && paneVisibleRef.current
          ? listSSHFiles(sessionId, path, { prefetch: true })
          : Promise.resolve();
      },
      isCached: (path) => {
        const sessionId = sshSessionIdRef.current;
        return (
          !sessionId || peekCachedFileList(sessionId, path, 5_000) !== null
        );
      },
      run: (task) =>
        paneVisibleRef.current &&
        runAdaptiveBackgroundTask("network", "directory-list", task),
    });
    scheduler.setForeground(true);
    directoryPrefetchRef.current = scheduler;
    return () => {
      scheduler.dispose();
      directoryPrefetchRef.current = null;
    };
  }, []);

  useEffect(() => {
    directoryPrefetchRef.current?.setForeground(true);
    if (
      !isVisible ||
      prefetchListing?.sessionId !== sshSessionId ||
      prefetchListing?.path !== currentPathRef.current ||
      foregroundDirectoryLoadsRef.current > 0
    )
      return;
    directoryPrefetchRef.current?.setForeground(false);
    directoryPrefetchRef.current?.predict(
      prefetchListing.path,
      prefetchListing.files,
    );
  }, [prefetchListing, sshSessionId, isVisible]);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  // An interface preset sets this too, so it is a plugin UI preference.
  const { values: fmPrefs, set: setFmPref } = usePluginUiPreferences<{
    viewMode: "grid" | "list";
  }>();
  const viewMode: "grid" | "list" =
    fmPrefs.viewMode === "list" ? "list" : "grid";
  const setViewMode = useCallback(
    (next: "grid" | "list") => setFmPref("viewMode", next),
    [setFmPref],
  );
  const [density, setDensity] = useState<"comfortable" | "compact">(() =>
    localStorage.getItem("fileManagerDensity") === "compact"
      ? "compact"
      : "comfortable",
  );
  const [sortBy, setSortBy] = useState<"name" | "modified" | "size">(() => {
    const saved = localStorage.getItem("fileManagerSortBy");
    return saved === "name" || saved === "modified" || saved === "size"
      ? saved
      : "name";
  });
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(() => {
    const saved = localStorage.getItem("fileManagerSortOrder");
    return saved === "asc" || saved === "desc" ? saved : "asc";
  });
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpSessionId, setTotpSessionId] = useState<string | null>(null);
  const [totpPrompt, setTotpPrompt] = useState<string>("");
  const [browserSignInRequired, setBrowserSignInRequired] = useState(false);
  const [browserSignInSessionId, setBrowserSignInSessionId] = useState<
    string | null
  >(null);
  const [browserSignInUrl, setBrowserSignInUrl] = useState<string>("");
  const [browserSignInCode, setBrowserSignInCode] = useState<string>("");
  const [browserSignInLabel, setBrowserSignInLabel] = useState<string>("");
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [authDialogReason, setAuthDialogReason] = useState<
    "no_keyboard" | "auth_failed" | "timeout"
  >("no_keyboard");
  const [showPassphraseDialog, setShowPassphraseDialog] = useState(false);
  const [pinnedFiles, setPinnedFiles] = useState<Set<string>>(new Set());
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);
  // Desktop-only Local | Remote split view (Termius-style dual pane).
  const localPaneAvailable = !compact && isLocalFileBrowserAvailable();
  const [localPaneOpen, setLocalPaneOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LOCAL_PANE_OPEN_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [localPaneRefreshToken, setLocalPaneRefreshToken] = useState(0);
  // Desktop directories sidebar visibility (mobile uses the overlay state).
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (compact) return false;
    try {
      return localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next));
      } catch {
        // storage unavailable
      }
      return next;
    });
  }, []);
  const panesRowRef = useRef<HTMLDivElement>(null);
  const localPaneSize = usePaneWidth({
    storageKey: LOCAL_PANE_WIDTH_STORAGE_KEY,
    defaultWidth: LOCAL_PANE_DEFAULT_WIDTH,
    minWidth: LOCAL_PANE_MIN_WIDTH,
    maxFraction: 0.65,
    containerRef: panesRowRef,
  });
  const sidebarSize = usePaneWidth({
    storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxFraction: 0.4,
    containerRef: panesRowRef,
  });
  const toggleLocalPane = useCallback(() => {
    setLocalPaneOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LOCAL_PANE_OPEN_STORAGE_KEY, String(next));
      } catch {
        // storage unavailable
      }
      return next;
    });
  }, []);
  const [trashOpen, setTrashOpen] = useState(false);
  const [hasConnectionError, setHasConnectionError] = useState<boolean>(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [diskInfo, setDiskInfo] = useState<{
    usedHuman: string;
    totalHuman: string;
    percent: number;
    mount: string | null;
    filesystems: DiskFilesystem[];
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    isVisible: boolean;
    files: FileItem[];
  }>({
    x: 0,
    y: 0,
    isVisible: false,
    files: [],
  });

  const [clipboard, setClipboard] = useState<{
    files: FileItem[];
    operation: "copy" | "cut";
    sourceHostId: number | null;
    sourceSessionId: string | null;
  } | null>(null);

  interface UndoAction {
    type: "copy" | "cut" | "delete";
    description: string;
    data: {
      operation: "copy" | "cut";
      copiedFiles?: {
        originalPath: string;
        targetPath: string;
        targetName: string;
      }[];
      deletedFiles?: { path: string; name: string }[];
      targetDirectory?: string;
    };
    timestamp: number;
  }

  const [undoHistory, setUndoHistory] = useState<UndoAction[]>([]);

  const [createIntent, setCreateIntent] = useState<CreateIntent | null>(null);
  const [editingFile, setEditingFile] = useState<FileItem | null>(null);
  const [permissionsDialogFile, setPermissionsDialogFile] =
    useState<FileItem | null>(null);
  const [compressDialogFiles, setCompressDialogFiles] = useState<FileItem[]>(
    [],
  );
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferFiles, setTransferFiles] = useState<FileItem[]>([]);
  const [transferMove, setTransferMove] = useState(false);

  const [sudoDialogOpen, setSudoDialogOpen] = useState(false);
  const [deletingPaths, setDeletingPaths] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const deletingPathsRef = useRef<ReadonlySet<string>>(new Set());
  const updateDeletingPaths = (next: ReadonlySet<string>) => {
    deletingPathsRef.current = next;
    setDeletingPaths(next);
  };
  const [pendingSudoOperation, setPendingSudoOperation] =
    useState<PendingSudoOperation | null>(null);

  const { selectedFiles, clearSelection, setSelection } = useFileSelection();

  const commitFilesForPath = useCallback(
    (sessionId: string, path: string, next: FileItem[]) => {
      updateCachedFileList(sessionId, path, next);
      if (
        sshSessionIdRef.current !== sessionId ||
        currentPathRef.current !== path
      ) {
        return;
      }
      directoryRequestRef.current += 1;
      filesRef.current = next;
      setFiles(next);
    },
    [],
  );

  const filesForPath = useCallback((sessionId: string, path: string) => {
    if (
      sshSessionIdRef.current === sessionId &&
      currentPathRef.current === path
    ) {
      return filesRef.current;
    }
    return peekCachedFileList(sessionId, path)?.files ?? [];
  }, []);

  const { dragHandlers } = useDragAndDrop({
    onFilesDropped: handleFilesDropped,
    onItemsDropped: handleItemsDropped,
    onError: (error) => toast.error(error),
    maxFileSize: 5120,
  });

  const dragToDesktop = useDragToDesktop({
    sshSessionId: sshSessionId || "",
    sshHost: currentHost!,
  });

  const systemDrag = useDragToSystemDesktop({
    sshSessionId: sshSessionId || "",
    sshHost: currentHost!,
  });

  const startKeepalive = useCallback(() => {
    if (!sshSessionId) return;

    if (keepaliveTimerRef.current) {
      clearInterval(keepaliveTimerRef.current);
    }

    keepaliveTimerRef.current = setInterval(async () => {
      if (sshSessionId) {
        try {
          await keepSSHAlive(sshSessionId);
        } catch {
          // The next request reconnects
        }
      }
    }, 30 * 1000);
  }, [sshSessionId]);

  const stopKeepalive = useCallback(() => {
    if (keepaliveTimerRef.current) {
      clearInterval(keepaliveTimerRef.current);
      keepaliveTimerRef.current = null;
    }
  }, []);

  const [lastConnectionError, setLastConnectionError] = useState<string | null>(
    null,
  );
  const handleCloseWithError = useCallback(
    (errorMessage: string) => {
      setHasConnectionError(true);
      setLastConnectionError(errorMessage);
      addLog({
        type: "error",
        stage: "connection",
        message: errorMessage,
      });
      connectRetryRef.current?.markFailed();
    },
    [addLog],
  );

  const connectRetry = useConnectionRetry({
    connect: () => {
      void initializeSSHConnection();
    },
    enabled:
      !!currentHost &&
      !sshSessionId &&
      !totpRequired &&
      !browserSignInRequired &&
      !showAuthDialog &&
      !showPassphraseDialog,
    autoStart: false,
  });
  const connectRetryRef = useRef(connectRetry);
  connectRetryRef.current = connectRetry;

  useEffect(() => {
    if (currentHost) {
      connectRetryRef.current.reset();
      connectRetryRef.current.retryNow();
    }
  }, [currentHost]);

  useEffect(() => {
    if (sshSessionId && isVisible) {
      startKeepalive();
    } else {
      stopKeepalive();
    }

    return () => {
      stopKeepalive();
    };
  }, [sshSessionId, isVisible, startKeepalive, stopKeepalive]);

  const initialFileOpenedRef = useRef(false);
  useEffect(() => {
    if (!sshSessionId || !initialFilePath || initialFileOpenedRef.current)
      return;
    initialFileOpenedRef.current = true;

    const fileName = initialFilePath.split("/").pop() || initialFilePath;
    const fileDir =
      initialFilePath.lastIndexOf("/") > 0
        ? initialFilePath.substring(0, initialFilePath.lastIndexOf("/"))
        : "/";

    setCurrentPath(fileDir);

    const file: FileItem = {
      name: fileName,
      path: initialFilePath,
      type: "file",
    };

    const windowCount = Date.now() % 10;
    const offsetX = Math.min(
      120 + windowCount * 30,
      Math.max(0, window.innerWidth - 820),
    );
    const offsetY = Math.min(
      120 + windowCount * 30,
      Math.max(0, window.innerHeight - 620),
    );

    const createWindowComponent = (windowId: string) => (
      <FileWindow
        windowId={windowId}
        file={file}
        sshSessionId={sshSessionId}
        sshHost={currentHost}
        initialX={offsetX}
        initialY={offsetY}
        onFileNotFound={handleFileNotFound}
      />
    );

    openWindow({
      title: fileName,
      x: offsetX,
      y: offsetY,
      width: 800,
      height: 600,
      isMaximized: compact,
      isMinimized: false,
      component: createWindowComponent,
    });
  }, [sshSessionId, initialFilePath]);

  const initialLoadDoneRef = useRef(false);
  const lastPathChangeRef = useRef<string>("");
  const pathChangeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentLoadingPathRef = useRef<string>("");
  const keepaliveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activityLoggedRef = useRef(false);
  const activityLoggingRef = useRef(false);

  const logFileManagerActivity = useCallback(async () => {
    if (
      !currentHost?.id ||
      activityLoggedRef.current ||
      activityLoggingRef.current
    ) {
      return;
    }

    activityLoggingRef.current = true;
    activityLoggedRef.current = true;

    try {
      const hostName =
        currentHost.name || `${currentHost.username}@${currentHost.ip}`;
      await logActivity("file_manager", currentHost.id, hostName);
    } catch (err) {
      activityLoggedRef.current = false;
    } finally {
      activityLoggingRef.current = false;
    }
  }, [currentHost]);

  const handleFileDragStart = useCallback(
    (files: FileItem[]) => {
      systemDrag.startDragToSystem(files, {
        enableToast: true,
        onSuccess: () => {
          clearSelection();
        },
      });
    },
    [systemDrag, clearSelection],
  );

  const handleFileDragEnd = useCallback(
    (e: DragEvent, draggedFiles: FileItem[]) => {
      const isOutside =
        e.clientX < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY < 0 ||
        e.clientY > window.innerHeight;

      if (isOutside) {
        if (draggedFiles.length === 0) {
          return;
        }

        systemDrag.startDragToSystem(draggedFiles, {
          enableToast: true,
          onSuccess: () => {
            clearSelection();
          },
        });
        systemDrag.handleDragEnd(e);
      } else {
        systemDrag.cancelDragToSystem();
      }
    },
    [systemDrag, clearSelection],
  );

  const isConnectingRef = useRef(false);

  async function initializeSSHConnection() {
    if (!currentHost || isConnectingRef.current) return;

    if (currentHost.enableSsh === false) {
      setHasConnectionError(true);
      addLog({
        type: "error",
        stage: "error",
        message: t("fileManager.sshRequiredForFileManager"),
      });
      setIsLoading(false);
      return;
    }

    isConnectingRef.current = true;

    try {
      setIsLoading(true);
      initialLoadDoneRef.current = false;
      setHasConnectionError(false);
      clearLogs();

      const sessionId = currentHost.id.toString();

      const result = await connectSSH(sessionId, {
        hostId: currentHost.id,
        connectionOrigin: currentHost.connectionOrigin,
        syncId: currentHost.syncId ?? null,
        ip: currentHost.ip,
        port: currentHost.port,
        username: currentHost.username,
        password: currentHost.password,
        sshKey: currentHost.key,
        keyPassword: currentHost.keyPassword,
        authType: currentHost.authType,
        credentialId: currentHost.credentialId,
        userId: currentHost.userId,
        forceKeyboardInteractive: currentHost.forceKeyboardInteractive,
        jumpHosts: currentHost.jumpHosts,
        useSocks5: currentHost.useSocks5,
        socks5Host: currentHost.socks5Host,
        socks5Port: currentHost.socks5Port,
        socks5Username: currentHost.socks5Username,
        socks5Password: currentHost.socks5Password,
        socks5ProxyChain: currentHost.socks5ProxyChain,
      });

      if (result?.requires_browser_sign_in) {
        setBrowserSignInRequired(true);
        setBrowserSignInSessionId(sessionId);
        setBrowserSignInUrl(result.url || "");
        setBrowserSignInCode(result.code || "N/A");
        setBrowserSignInLabel(result.label || "");
        setIsLoading(false);
        return;
      }

      if (result?.requires_totp) {
        setTotpRequired(true);
        setTotpSessionId(sessionId);
        setTotpPrompt(result.prompt || t("fileManager.verificationCodePrompt"));
        setIsLoading(false);
        return;
      }

      if (result?.status === "auth_required") {
        setAuthDialogReason(result.reason || "no_keyboard");
        setShowAuthDialog(true);
        setIsLoading(false);
        return;
      }

      if (result?.status === "passphrase_required") {
        setShowPassphraseDialog(true);
        setIsLoading(false);
        return;
      }

      setSshSessionId(sessionId);
      connectRetryRef.current.markConnected();

      try {
        const authRequestId = ++directoryRequestRef.current;
        const response = await listSSHFiles(sessionId, currentPath);
        publishConnectedListing(
          sessionId,
          currentPath,
          response,
          authRequestId,
        );
        clearSelection();
        initialLoadDoneRef.current = true;

        if (!result?.requires_totp) {
          logFileManagerActivity();
        }
      } catch (dirError: unknown) {}
    } catch (error: unknown) {
      const sshError = error as SSHConnectionError;

      if (sshError.connectionLogs) {
        sshError.connectionLogs.forEach((log) => {
          addLog({
            type: log.type,
            stage: log.stage,
            message: log.message,
            details: log.details,
          });
        });
        if (sshError.requires_totp) {
          setTotpRequired(true);
          setTotpSessionId(sshError.sessionId || currentHost.id.toString());
          setTotpPrompt(
            sshError.prompt || t("fileManager.verificationCodePrompt"),
          );
          setIsLoading(false);
          return;
        }
        if (sshError.requires_browser_sign_in) {
          setBrowserSignInRequired(true);
          setBrowserSignInSessionId(
            sshError.sessionId || currentHost.id.toString(),
          );
          setBrowserSignInUrl(sshError.url || "");
          setBrowserSignInCode(sshError.code || "N/A");
          setBrowserSignInLabel(sshError.label || "");
          setIsLoading(false);
          return;
        }
        if (sshError.status === "auth_required") {
          setAuthDialogReason(sshError.reason || "no_keyboard");
          setShowAuthDialog(true);
          setIsLoading(false);
          return;
        }
      } else {
        addLog({
          type: "error",
          stage: "connection",
          message:
            error instanceof Error
              ? error.message
              : t("fileManager.failedToConnect"),
        });
      }

      handleCloseWithError(
        t("fileManager.failedToConnect") +
          ": " +
          getErrorMessage(error, String(error)),
      );
    } finally {
      setIsLoading(false);
      isConnectingRef.current = false;
    }
  }

  const loadDirectory = useCallback(
    async (
      path: string,
      conflictAttempt = 0,
      forceRefresh = false,
    ): Promise<boolean> => {
      if (!sshSessionId) {
        return false;
      }
      const requestId = ++directoryRequestRef.current;
      const scheduler = directoryPrefetchRef.current;
      foregroundDirectoryLoadsRef.current += 1;
      scheduler?.setForeground(true);

      let resolvedPath = path;
      try {
        if (path.includes("$") || path.startsWith("~")) {
          resolvedPath = await resolveSSHPath(sshSessionId, path);
          if (resolvedPath !== path) {
            setCurrentPath(resolvedPath);
            lastPathChangeRef.current = resolvedPath;
          }
        }

        currentLoadingPathRef.current = resolvedPath;
        const cached = peekCachedFileList(sshSessionId, resolvedPath);
        if (cached) {
          setFiles(cached.files);
          clearSelection();
        }
        setIsLoading(!cached);

        const fresh = forceRefresh
          ? null
          : peekCachedFileList(sshSessionId, resolvedPath, 5_000);
        const response =
          fresh ??
          (await listSSHFiles(sshSessionId, resolvedPath, {
            force: forceRefresh || cached !== null,
          }));

        if (directoryRequestRef.current !== requestId) {
          return false;
        }

        const files = Array.isArray(response)
          ? response
          : response?.files || [];

        setFiles(files);
        const listedPath = response.path || resolvedPath;
        setPrefetchListing({
          sessionId: sshSessionId,
          path: listedPath,
          files,
        });
        if (listedPath !== resolvedPath) {
          setCurrentPath(listedPath);
          setNavHistory((history) =>
            history.map((entry) => (entry === path ? listedPath : entry)),
          );
        }
        lastSuccessfulPathRef.current = listedPath;
        clearSelection();
        return true;
      } catch (error: unknown) {
        if (directoryRequestRef.current === requestId) {
          // ApiError has .status directly; raw axios errors have .response.status
          const apiError = error as {
            status?: number;
            code?: string;
            response?: {
              status?: number;
              data?: {
                needsSudo?: boolean;
                error?: string;
                sudoFailed?: boolean;
                disconnected?: boolean;
              };
            };
            message?: string;
          };

          const httpStatus = apiError.status ?? apiError.response?.status;

          if (apiError.response?.data?.needsSudo) {
            const previousPath = lastSuccessfulPathRef.current;
            lastPathChangeRef.current = previousPath;
            setCurrentPath((current) =>
              current === resolvedPath ? previousPath : current,
            );
            if (!sudoDialogOpen) {
              setPendingSudoOperation({ type: "navigate", path: resolvedPath });
              setSudoDialogOpen(true);
            }

            if (apiError.response.data.sudoFailed) {
              toast.error(t("fileManager.sudoAuthFailed"));
            } else {
              toast.error(t("fileManager.permissionDenied"));
            }
            return false;
          }

          const errorMessage =
            apiError.response?.data?.error || apiError.message || String(error);

          const isConnectionError =
            // 500s from the file manager are SSH channel/session errors
            httpStatus === 500 ||
            httpStatus === 503 ||
            apiError.response?.data?.disconnected === true ||
            errorMessage?.includes("channel open failure") ||
            errorMessage?.includes("open failed") ||
            errorMessage?.includes("SSH connection not established") ||
            errorMessage?.includes("SSH session") ||
            errorMessage?.toLowerCase().includes("not connected");

          if (isConnectionError && sshSessionId && currentHost) {
            setIsReconnecting(true);
            setIsLoading(false);
            setFiles([]);
            currentLoadingPathRef.current = "";

            void (async () => {
              const delays = [1000, 2000, 3000, 5000, 5000];
              for (let attempt = 0; attempt < delays.length; attempt++) {
                await new Promise((r) => setTimeout(r, delays[attempt]));
                try {
                  await ensureSSHConnection();
                  setIsReconnecting(false);
                  loadDirectory(resolvedPath, 0, forceRefresh);
                  return;
                } catch {
                  // keep retrying
                }
              }
              setIsReconnecting(false);
              handleCloseWithError(
                t("fileManager.failedToLoadDirectory") + ": " + errorMessage,
              );
            })();

            return false;
          } else if (initialLoadDoneRef.current) {
            const isPermissionDenied =
              httpStatus === 403 ||
              errorMessage?.toLowerCase().includes("permission denied") ||
              errorMessage?.toLowerCase().includes("eacces");
            if (isPermissionDenied) {
              toast.error(t("fileManager.permissionDenied"));
            } else {
              toast.error(
                t("fileManager.failedToLoadDirectory") + ": " + errorMessage,
              );
            }
          }
        }
        return false;
      } finally {
        foregroundDirectoryLoadsRef.current -= 1;
        scheduler?.setForeground(
          foregroundDirectoryLoadsRef.current > 0 || !paneVisibleRef.current,
        );
        if (directoryRequestRef.current === requestId) {
          setIsLoading(false);
          currentLoadingPathRef.current = "";
        }
      }
    },
    [sshSessionId, clearSelection, t, sudoDialogOpen, currentHost],
  );

  const debouncedLoadDirectory = useCallback(
    (path: string, force?: boolean) => {
      if (pathChangeTimerRef.current) {
        clearTimeout(pathChangeTimerRef.current);
      }

      pathChangeTimerRef.current = setTimeout(() => {
        if ((force || path !== lastPathChangeRef.current) && sshSessionId) {
          lastPathChangeRef.current = path;
          loadDirectory(path);
        }
      }, 0);
    },
    [sshSessionId, loadDirectory],
  );

  const navigateTo = useCallback(
    (path: string) => {
      directoryPrefetchRef.current?.setForeground(
        path !== currentPathRef.current,
      );
      directoryRequestRef.current += 1;
      const cached = sshSessionId
        ? peekCachedFileList(sshSessionId, path)
        : null;
      if (cached) setFiles(cached.files);
      setIsLoading(!!sshSessionId && !cached);
      setCurrentPath(path);
      setNavHistory((prev) => {
        const next = [...prev.slice(0, navIndex + 1), path];
        setNavIndex(next.length - 1);
        return next;
      });
    },
    [navIndex, sshSessionId],
  );

  useEffect(() => {
    if (!externalPath || externalPath.path === currentPathRef.current) return;
    navigateTo(externalPath.path);
    // only a new external path should move the view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPath]);

  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  useEffect(() => {
    onPathChangeRef.current?.(currentPath);
  }, [currentPath]);

  const goBack = useCallback(() => {
    if (navIndex > 0) {
      directoryPrefetchRef.current?.setForeground(true);
      directoryRequestRef.current += 1;
      const newIndex = navIndex - 1;
      const path = navHistory[newIndex];
      const cached = sshSessionId
        ? peekCachedFileList(sshSessionId, path)
        : null;
      if (cached) setFiles(cached.files);
      setIsLoading(!!sshSessionId && !cached);
      setNavIndex(newIndex);
      setCurrentPath(path);
    }
  }, [navIndex, navHistory, sshSessionId]);

  const goForward = useCallback(() => {
    if (navIndex < navHistory.length - 1) {
      directoryPrefetchRef.current?.setForeground(true);
      directoryRequestRef.current += 1;
      const newIndex = navIndex + 1;
      const path = navHistory[newIndex];
      const cached = sshSessionId
        ? peekCachedFileList(sshSessionId, path)
        : null;
      if (cached) setFiles(cached.files);
      setIsLoading(!!sshSessionId && !cached);
      setNavIndex(newIndex);
      setCurrentPath(path);
    }
  }, [navIndex, navHistory, sshSessionId]);

  useEffect(() => {
    const handleMouseNavigation = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.button === 3) goBack();
      else goForward();
    };
    const preventBrowserMouseNavigation = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) event.preventDefault();
    };

    window.addEventListener("mouseup", handleMouseNavigation);
    window.addEventListener("auxclick", preventBrowserMouseNavigation);
    return () => {
      window.removeEventListener("mouseup", handleMouseNavigation);
      window.removeEventListener("auxclick", preventBrowserMouseNavigation);
    };
  }, [goBack, goForward]);

  const goUp = useCallback(() => {
    if (currentPath === "/") return;
    const parent =
      currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  useEffect(() => {
    if (sshSessionId && currentPath) {
      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;
        lastPathChangeRef.current = currentPath;
        return;
      }

      debouncedLoadDirectory(currentPath);
    }

    return () => {
      if (pathChangeTimerRef.current) {
        clearTimeout(pathChangeTimerRef.current);
      }
    };
  }, [sshSessionId, currentPath, debouncedLoadDirectory]);

  const refreshTrailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const handleRefreshDirectory = useCallback(() => {
    const now = Date.now();
    const DEBOUNCE_MS = 500;

    // Mutations must always drop stale snapshots, even when the read is throttled.
    if (sshSessionId) invalidateCachedFileList(sshSessionId, currentPath);
    const sessionAtSchedule = sshSessionId;
    const run = () => {
      refreshTrailingTimerRef.current = null;
      // A navigation or session change since scheduling makes this read stale.
      if (
        currentPathRef.current !== currentPath ||
        sshSessionIdRef.current !== sessionAtSchedule
      )
        return;
      setLastRefreshTime(Date.now());
      // Force reset loading state to ensure refresh is not blocked
      setIsLoading(false);
      currentLoadingPathRef.current = "";
      loadDirectory(currentPath, 0, true);
    };

    if (now - lastRefreshTime < DEBOUNCE_MS) {
      // Trailing forced read so the post-mutation listing is never skipped.
      if (refreshTrailingTimerRef.current)
        clearTimeout(refreshTrailingTimerRef.current);
      refreshTrailingTimerRef.current = setTimeout(
        run,
        DEBOUNCE_MS - (now - lastRefreshTime),
      );
      return;
    }
    run();
  }, [currentPath, lastRefreshTime, loadDirectory, sshSessionId]);

  useEffect(
    () => () => {
      if (refreshTrailingTimerRef.current)
        clearTimeout(refreshTrailingTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: number; path: string }>)
        .detail;
      if (!detail || !currentHost?.id) return;
      if (detail.hostId === currentHost.id) {
        handleRefreshDirectory();
      }
    };
    window.addEventListener("file-manager:refresh", handler);
    return () => window.removeEventListener("file-manager:refresh", handler);
  }, [currentHost?.id, handleRefreshDirectory]);

  const localTransfers = useLocalTransfers({
    sshSessionId,
    hostId: currentHost?.id,
    ensureSSHConnection,
    onRemoteChanged: (remoteDir) => {
      if (sshSessionId) invalidateCachedFileList(sshSessionId, remoteDir);
      handleRefreshDirectory();
      setSidebarRefreshTrigger((prev) => prev + 1);
    },
    onLocalChanged: () => setLocalPaneRefreshToken((prev) => prev + 1),
  });

  // Entries dragged from the local pane onto the remote grid (or onto one of
  // its folders) upload into that folder, preserving directory structure.
  const handleLocalFilesDrop = useCallback(
    (localPaths: string[], targetDir?: FileItem) => {
      const remoteDir = targetDir?.path ?? currentPathRef.current;
      void waitForDeletes(pendingDeleteRef).then(() =>
        localTransfers.uploadLocalPaths(localPaths, remoteDir),
      );
    },
    [localTransfers],
  );

  // Remote rows dragged onto the local pane download into the folder shown
  // there (or the folder row they were dropped on).
  const handleRemoteItemsDroppedToLocal = useCallback(
    (remotePaths: string[], localDir: string) => {
      const known = new Map(files.map((f) => [f.path, f]));
      const items: FileItem[] = remotePaths.map(
        (p) =>
          known.get(p) ?? {
            name: p.split("/").filter(Boolean).pop() || p,
            path: p,
            type: "file",
          },
      );
      void localTransfers.downloadRemoteItems(items, localDir);
    },
    [files, localTransfers],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          files: FileItem[];
          operation: "copy" | "cut";
          sourceHostId: number | null;
          sourceSessionId: string | null;
        }>
      ).detail;
      if (!detail) return;
      setClipboard(detail);
    };
    window.addEventListener("file-manager:clipboard", handler);
    return () => window.removeEventListener("file-manager:clipboard", handler);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === "INPUT" ||
          activeElement.tagName === "TEXTAREA" ||
          (activeElement as HTMLElement).contentEditable === "true")
      ) {
        return;
      }

      if (event.key === "T" && event.ctrlKey && event.shiftKey) {
        event.preventDefault();
        handleOpenTerminal(currentPath);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [currentPath]);

  async function handleItemsDropped(entries: FileSystemEntry[]) {
    if (!sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }
    const files: { file: File; relativePath: string }[] = [];
    const emptyDirs: string[] = [];

    async function readEntry(
      entry: FileSystemEntry,
      path: string,
    ): Promise<void> {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        files.push({ file, relativePath: path });
        return;
      }

      if (!entry.isDirectory) return;

      // readEntries only hands back a page at a time and signals the end with an
      // empty batch, so drain it fully before walking into the children.
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        children.push(...batch);
      }

      if (children.length === 0) {
        emptyDirs.push(path);
        return;
      }

      for (const child of children) {
        await readEntry(child, `${path}/${child.name}`);
      }
    }

    try {
      for (const entry of entries) {
        await readEntry(entry, entry.name);
      }
    } catch (error) {
      toast.error(t("fileManager.failedToUploadFile"));
      return;
    }

    if (files.length === 0 && emptyDirs.length === 0) return;
    await waitForDeletes(pendingDeleteRef);

    await uploadBatch(files, emptyDirs);
  }

  async function uploadBatch(
    files: { file: File; relativePath: string }[],
    emptyDirs: string[],
  ) {
    const controller = new AbortController();
    const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
    const toastId = toast.loading(null, { duration: Infinity });
    const sent = new Map<string, number>();
    let doneFiles = 0;
    let lastLoaded = 0;
    let lastTime = Date.now();
    let mbPerSec: number | undefined;

    const render = () => {
      if (controller.signal.aborted) return;
      let loaded = 0;
      for (const v of sent.values()) loaded += v;
      const now = Date.now();
      if (now - lastTime >= 500) {
        mbPerSec =
          ((loaded - lastLoaded) / (now - lastTime) / 1024 / 1024) * 1000;
        lastLoaded = loaded;
        lastTime = now;
      }
      toast.loading(
        <UploadProgressToast
          t={t}
          doneFiles={doneFiles}
          totalFiles={files.length}
          loaded={loaded}
          total={totalBytes}
          mbPerSec={mbPerSec}
          onCancel={() => controller.abort()}
        />,
        { id: toastId, duration: Infinity },
      );
    };
    render();

    const failed: string[] = [];

    try {
      await ensureSSHConnection();

      const base = currentPath.endsWith("/") ? currentPath : currentPath + "/";

      const dirs = new Set<string>();
      for (const relativePath of [
        ...files.map((f) => f.relativePath),
        ...emptyDirs.map((d) => `${d}/`),
      ]) {
        const parts = relativePath.split("/");
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join("/"));
        }
      }

      // Shallowest first so each parent exists before its children.
      const sortedDirs = Array.from(dirs).sort(
        (a, b) =>
          a.split("/").length - b.split("/").length || a.localeCompare(b),
      );
      for (const dir of sortedDirs) {
        controller.signal.throwIfAborted();
        const parentDir = dir.split("/").slice(0, -1).join("/");
        const targetPath = parentDir ? `${base}${parentDir}/` : base;
        const folderName = dir.split("/").pop()!;
        await createSSHFolder(
          sshSessionId,
          targetPath,
          folderName,
          currentHost?.id,
        );
      }

      const ticker = setInterval(render, 500);
      try {
        await runWithConcurrency(files, 4, async ({ file, relativePath }) => {
          controller.signal.throwIfAborted();
          const dirPart = relativePath.includes("/")
            ? relativePath.substring(0, relativePath.lastIndexOf("/"))
            : "";
          const uploadPath = dirPart ? `${base}${dirPart}/` : base;

          try {
            await uploadSSHFile(
              sshSessionId,
              uploadPath,
              file.name,
              file,
              currentHost?.id,
              undefined,
              (p) => sent.set(relativePath, p.bytesSent),
              controller.signal,
            );
            sent.set(relativePath, file.size);
          } catch (error) {
            controller.signal.throwIfAborted();
            failed.push(relativePath);
          }
          doneFiles++;
        });
      } finally {
        clearInterval(ticker);
      }

      controller.signal.throwIfAborted();
      toast.dismiss(toastId);
      if (failed.length === 0) {
        toast.success(
          files.length === 1 && emptyDirs.length === 0
            ? t("fileManager.fileUploadedSuccessfully", {
                name: files[0].file.name,
              })
            : t("fileManager.uploadedFolderFiles", { count: files.length }),
        );
      } else if (failed.length === files.length) {
        toast.error(t("fileManager.failedToUploadFile"));
      } else {
        toast.warning(
          t("fileManager.uploadedFolderPartial", {
            uploaded: files.length - failed.length,
            failed: failed.length,
          }),
        );
      }
      handleRefreshDirectory();
    } catch (error) {
      toast.dismiss(toastId);
      if (controller.signal.aborted) {
        toast.info(t("fileManager.localTransferCancelled"));
        handleRefreshDirectory();
        return;
      }
      const message = error instanceof Error ? error.message : "";
      toast.error(
        message.includes("connection") || message.includes("established")
          ? t("fileManager.sshConnectionFailed", {
              name: currentHost?.name,
              ip: currentHost?.ip,
              port: currentHost?.port,
            })
          : t("fileManager.failedToUploadFile"),
      );
    }
  }

  async function handleFilesDropped(fileList: FileList) {
    if (!sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }
    const dropped = Array.from(fileList);
    await waitForDeletes(pendingDeleteRef);
    await uploadBatch(
      dropped.map((file) => ({ file, relativePath: file.name })),
      [],
    );
  }

  /** A download error's JSON body; it arrives as a Blob. */
  async function downloadErrorBody(
    error: unknown,
  ): Promise<{ needsSudo?: boolean; sudoFailed?: boolean } | null> {
    const data = (error as { response?: { data?: unknown } })?.response?.data;
    try {
      if (data instanceof Blob) return JSON.parse(await data.text());
      if (data && typeof data === "object") return data as never;
    } catch {
      // Not JSON.
    }
    return null;
  }

  async function handleDownloadFile(file: FileItem) {
    if (!sshSessionId) return;

    const toastId = `download-${file.path}-${Date.now()}`;
    const controller = new AbortController();
    const cancel = {
      label: t("fileManager.cancel"),
      onClick: () => controller.abort(),
    };
    let lastLoaded = 0;
    let lastTime = Date.now();
    let mbPerSec: number | undefined;

    try {
      await ensureSSHConnection();

      const { downloadSSHFileStream } =
        await import("./api/ssh-file-operations-api");

      toast.loading(
        <DownloadProgressToast t={t} fileName={file.name} loaded={0} />,
        {
          id: toastId,
          duration: Infinity,
          cancel,
        },
      );

      await downloadSSHFileStream(
        sshSessionId,
        file.path,
        ({ loaded, total }) => {
          if (controller.signal.aborted) return;
          const now = Date.now();
          const deltaMs = now - lastTime;
          if (deltaMs > 200) {
            const deltaBytes = loaded - lastLoaded;
            if (deltaBytes >= 0) {
              mbPerSec = (deltaBytes / deltaMs / 1024 / 1024) * 1000;
            }
            lastLoaded = loaded;
            lastTime = now;
          }

          toast.loading(
            <DownloadProgressToast
              t={t}
              fileName={file.name}
              loaded={loaded}
              total={total}
              mbPerSec={mbPerSec}
            />,
            { id: toastId, duration: Infinity, cancel },
          );
        },
        controller.signal,
      );

      toast.success(
        t("fileManager.fileDownloadedSuccessfully", { name: file.name }),
        { id: toastId, duration: undefined },
      );
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        toast.info(t("fileManager.localTransferCancelled"), {
          id: toastId,
          duration: undefined,
        });
        return;
      }
      const body = await downloadErrorBody(error);
      if (body?.needsSudo) {
        toast.dismiss(toastId);
        if (body.sudoFailed) toast.error(t("fileManager.sudoAuthFailed"));
        setPendingSudoOperation({ type: "download", file });
        setSudoDialogOpen(true);
        return;
      }
      const err = error instanceof Error ? error : null;
      if (
        err?.message?.includes("connection") ||
        err?.message?.includes("established")
      ) {
        toast.error(
          t("fileManager.sshConnectionFailed", {
            name: currentHost?.name,
            ip: currentHost?.ip,
            port: currentHost?.port,
          }),
          { id: toastId, duration: undefined },
        );
      } else {
        toast.error(t("fileManager.failedToDownloadFile"), {
          id: toastId,
          duration: undefined,
        });
      }
    }
  }

  type BulkDeleteOutcome = {
    targets: FileItem[];
    done: Set<FileItem>;
    failed: Set<FileItem>;
    needsSudo: Set<FileItem>;
    itemError?: string;
    thrown?: unknown;
    cancelled: boolean;
  };

  /**
   * Deletes in batches while the rows stay on screen, dimmed, until the server
   * confirms each batch. Cancel also tells the server to stop starting items.
   */
  async function bulkDelete(
    items: FileItem[],
    permanent: boolean,
  ): Promise<BulkDeleteOutcome> {
    const operationPath = currentPath;
    const operationSession = sshSessionId;
    // A selected folder already takes its selected children with it.
    const targets = items.filter(
      (file) =>
        !items.some(
          (other) =>
            other.type === "directory" &&
            file.path.startsWith(other.path.replace(/\/+$/, "") + "/"),
        ),
    );
    const targetPaths = new Set(targets.map((file) => file.path));
    updateDeletingPaths(new Set([...deletingPathsRef.current, ...targetPaths]));
    clearSelection();
    const controller = new AbortController();
    const opId = crypto.randomUUID();
    const labelKey = permanent
      ? "fileManager.deletingItems"
      : "fileManager.movingToTrash";
    const cancel = {
      label: t("fileManager.cancel"),
      onClick: () => {
        controller.abort();
        void cancelDeleteItems(operationSession, opId);
      },
    };
    const progressToast = toast.loading(
      t(labelKey, { done: 0, total: targets.length }),
      { duration: Infinity, cancel },
    );
    try {
      await ensureSSHConnection();
      const result = await trashInBatches(
        targets,
        TRASH_BATCH_SIZE,
        TRASH_BATCHES_IN_FLIGHT,
        (batch) =>
          trashSSHItems(
            operationSession,
            batch.map((file) => file.path),
            {
              permanent,
              opId,
              directories: batch
                .filter((file) => file.type === "directory")
                .map((file) => file.path),
            },
          ),
        {
          signal: controller.signal,
          onBatchDone: (confirmed) =>
            commitFilesForPath(
              operationSession,
              operationPath,
              removePaths(
                filesForPath(operationSession, operationPath),
                new Set(confirmed.map((file) => file.path)),
              ),
            ),
          onProgress: (finished) =>
            !controller.signal.aborted &&
            toast.loading(
              t(labelKey, { done: finished, total: targets.length }),
              {
                id: progressToast,
                duration: Infinity,
                cancel,
              },
            ),
        },
      );
      return { targets, ...result, cancelled: controller.signal.aborted };
    } catch (error) {
      return {
        targets,
        done: new Set(),
        failed: new Set(),
        needsSudo: new Set(),
        thrown: error,
        cancelled: false,
      };
    } finally {
      toast.dismiss(progressToast);
      updateDeletingPaths(
        new Set(
          [...deletingPathsRef.current].filter((p) => !targetPaths.has(p)),
        ),
      );
    }
  }

  /**
   * Uploads, pastes and moves wait for this, so a file re-uploaded under a name
   * still being deleted can't be deleted too. Held through any fallback prompt.
   */
  // Resolved when the sudo dialog is submitted or dismissed, so the delete
  // barrier stays held while the user decides.
  const sudoWaitRef = useRef<(() => void) | null>(null);
  function dismissSudo() {
    setPendingSudoOperation(null);
    sudoWaitRef.current?.();
    sudoWaitRef.current = null;
  }

  function holdDeletes(): () => void {
    let release!: () => void;
    pendingDeleteRef.current = Promise.all([
      pendingDeleteRef.current,
      new Promise<void>((resolve) => (release = resolve)),
    ]);
    return release;
  }

  /** Reports a bulk delete and asks only about items the server actually failed. */
  async function afterBulkDelete(
    outcome: BulkDeleteOutcome,
    permanent: boolean,
  ): Promise<void> {
    const refresh = () => handleRefreshDirectory();
    if (outcome.done.size > 0 && !outcome.cancelled) {
      toast.success(
        t(
          permanent
            ? "fileManager.itemsDeletedSuccessfully"
            : "fileManager.itemsMovedToTrash",
          { count: outcome.done.size },
        ),
      );
    }
    if (outcome.cancelled) {
      toast.info(t("fileManager.localTransferCancelled"));
      refresh();
      return;
    }
    const thrown = outcome.thrown as
      | {
          response?: {
            data?: { trashUnavailable?: boolean; error?: string };
            status?: number;
          };
          message?: string;
        }
      | undefined;
    const trashUnavailable = thrown?.response?.data?.trashUnavailable === true;
    if (thrown && !trashUnavailable) {
      refresh();
      if (
        thrown.response?.status === 403 ||
        thrown.response?.data?.error
          ?.toLowerCase()
          .includes("permission denied")
      ) {
        toast.error(t("fileManager.permissionDenied"));
      } else if (
        thrown.message?.includes("connection") ||
        thrown.message?.includes("established")
      ) {
        toast.error(
          t("fileManager.sshConnectionFailed", {
            name: currentHost?.name,
            ip: currentHost?.ip,
            port: currentHost?.port,
          }),
        );
      } else {
        toast.error(t("fileManager.failedToDeleteItems"));
      }
      return;
    }
    // Only items the server tried and failed: batches never started stay put.
    const failed = [...outcome.failed];
    if (failed.length === 0) {
      refresh();
      return;
    }
    if (permanent) {
      if (outcome.needsSudo.size > 0) {
        setPendingSudoOperation({
          type: "delete",
          files: [...outcome.needsSudo],
        });
        const answered = new Promise<void>((resolve) => {
          sudoWaitRef.current = resolve;
        });
        setSudoDialogOpen(true);
        refresh();
        await answered;
        return;
      }
      toast.error(t("fileManager.failedToDeleteItems"));
      refresh();
      return;
    }
    if (await confirm({ title: t("fileManager.trashUnavailableConfirm") })) {
      await afterBulkDelete(await bulkDelete(failed, true), true);
      return;
    }
    refresh();
    toast.error(t("fileManager.failedToDeleteItems"));
  }

  async function handleDeleteFiles(files: FileItem[]) {
    // Rows already being trashed can't be deleted again.
    files = files.filter((file) => !deletingPathsRef.current.has(file.path));
    if (!sshSessionId || files.length === 0) return;

    let confirmMessage: string;
    if (files.length === 1) {
      const file = files[0];
      if (file.type === "directory") {
        confirmMessage = t("fileManager.confirmDeleteFolder", {
          name: file.name,
        });
      } else {
        confirmMessage = t("fileManager.confirmDeleteSingleItem", {
          name: file.name,
        });
      }
    } else {
      const hasDirectory = files.some((file) => file.type === "directory");
      const translationKey = hasDirectory
        ? "fileManager.confirmDeleteMultipleItemsWithFolders"
        : "fileManager.confirmDeleteMultipleItems";

      confirmMessage = t(translationKey, {
        count: files.length,
      });
    }

    const fullMessage = `${confirmMessage}\n\n${t("fileManager.moveToTrashWarning")}`;

    const moveToTrash = async () => {
      const release = holdDeletes();
      try {
        await afterBulkDelete(await bulkDelete(files, false), false);
      } finally {
        release();
      }
    };
    if (confirmBeforeTrash) {
      confirm({ title: fullMessage }).then((ok) => {
        if (ok) void moveToTrash();
        return ok;
      });
    } else {
      await moveToTrash();
    }
  }

  async function handleSudoPasswordSubmit(password: string) {
    if (!sshSessionId || !pendingSudoOperation) return;

    try {
      await setSudoPassword(sshSessionId, password);
      setSudoDialogOpen(false);

      if (pendingSudoOperation.type === "delete") {
        const sudoFiles = pendingSudoOperation.files;
        // Take the new barrier before the old one is released.
        const release = holdDeletes();
        dismissSudo();
        try {
          await afterBulkDelete(await bulkDelete(sudoFiles, true), true);
        } finally {
          release();
        }
        return;
      } else if (pendingSudoOperation.type === "download") {
        const file = pendingSudoOperation.file;
        dismissSudo();
        void handleDownloadFile(file);
        return;
      } else if (pendingSudoOperation.type === "navigate") {
        const success = await loadDirectory(pendingSudoOperation.path, 0, true);
        if (success) {
          setCurrentPath(pendingSudoOperation.path);
          dismissSudo();
        }
        return;
      }

      dismissSudo();
    } catch (error: unknown) {
      const axiosError = error as {
        response?: { data?: { needsSudo?: boolean; sudoFailed?: boolean } };
        message?: string;
      };

      if (axiosError.response?.data?.sudoFailed) {
        toast.error(t("fileManager.sudoAuthFailed"));
        setSudoDialogOpen(true);
        return;
      }

      toast.error(axiosError.message || t("fileManager.sudoOperationFailed"));
      dismissSudo();
    }
  }

  function handleCreateNewFolder() {
    const defaultName = generateUniqueName(
      t("fileManager.newFolderDefault"),
      "directory",
    );
    setCreateIntent({
      id: Date.now().toString(),
      type: "directory" as const,
      defaultName,
      currentName: defaultName,
    });
  }

  function handleCreateNewFile() {
    const defaultName = generateUniqueName(
      t("fileManager.newFileDefault"),
      "file",
    );
    setCreateIntent({
      id: Date.now().toString(),
      type: "file" as const,
      defaultName,
      currentName: defaultName,
    });
  }

  const handleSymlinkClick = async (file: FileItem) => {
    if (!currentHost || !sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }

    try {
      const currentSessionId = sshSessionId;
      const status = await getSSHStatus(currentSessionId);
      if (!status.connected) {
        const result = await connectSSH(currentSessionId, {
          hostId: currentHost.id,
          connectionOrigin: currentHost.connectionOrigin,
          syncId: currentHost.syncId ?? null,
          ip: currentHost.ip,
          port: currentHost.port,
          username: currentHost.username,
          authType: currentHost.authType,
          password: currentHost.password,
          sshKey: currentHost.key,
          keyPassword: currentHost.keyPassword,
          credentialId: currentHost.credentialId,
          jumpHosts: currentHost.jumpHosts,
          useSocks5: currentHost.useSocks5,
          socks5Host: currentHost.socks5Host,
          socks5Port: currentHost.socks5Port,
          socks5Username: currentHost.socks5Username,
          socks5Password: currentHost.socks5Password,
          socks5ProxyChain: currentHost.socks5ProxyChain,
        });

        if (!result.success) {
          throw new Error(t("fileManager.failedToReconnectSSH"));
        }
      }

      const symlinkInfo = await identifySSHSymlink(currentSessionId, file.path);

      if (symlinkInfo.type === "directory") {
        setCurrentPath(symlinkInfo.target);
      } else if (symlinkInfo.type === "file") {
        const windowCount = Date.now() % 10;
        const offsetX = 120 + windowCount * 30;
        const offsetY = 120 + windowCount * 30;

        const targetFile: FileItem = {
          ...file,
          path: symlinkInfo.target,
        };

        const createWindowComponent = (windowId: string) => (
          <FileWindow
            windowId={windowId}
            file={targetFile}
            sshSessionId={currentSessionId}
            sshHost={currentHost}
            initialX={offsetX}
            initialY={offsetY}
          />
        );

        openWindow({
          title: file.name,
          x: offsetX,
          y: offsetY,
          width: 800,
          height: 600,
          isMaximized: compact,
          isMinimized: false,
          component: createWindowComponent,
        });
      }
    } catch (error: unknown) {
      const httpError = asHttpError(error);
      toast.error(
        httpError.response?.data?.error ||
          httpError.message ||
          t("fileManager.failedToResolveSymlink"),
      );
    }
  };

  function openFileWindow(file: FileItem, sessionId: string) {
    const windowCount = Date.now() % 10;
    const baseOffsetX = 120 + windowCount * 30;
    const baseOffsetY = 120 + windowCount * 30;

    const maxOffsetX = Math.max(0, window.innerWidth - 800 - 100);
    const maxOffsetY = Math.max(0, window.innerHeight - 600 - 100);

    const offsetX = Math.min(baseOffsetX, maxOffsetX);
    const offsetY = Math.min(baseOffsetY, maxOffsetY);

    const createWindowComponent = (windowId: string) => (
      <FileWindow
        windowId={windowId}
        file={file}
        sshSessionId={sessionId}
        sshHost={currentHost}
        initialX={offsetX}
        initialY={offsetY}
        onFileNotFound={handleFileNotFound}
      />
    );

    openWindow({
      title: file.name,
      x: offsetX,
      y: offsetY,
      width: 800,
      height: 600,
      isMaximized: compact,
      isMinimized: false,
      component: createWindowComponent,
    });
  }

  async function confirmLargeFileOpen(file: FileItem) {
    if (!file.size || file.size <= LARGE_FILE_WARNING_SIZE) return true;

    return confirm({
      title: t("fileManager.largeFileWarning"),
      description: t("fileManager.largeFileWarningDesc", {
        size: formatFileSize(file.size),
      }),
      confirmLabel: t("fileManager.confirm"),
      destructive: false,
    });
  }

  // Open editor sessions by remote path. Saves are chained per path (across
  // reopen) so an older queued save can never land after a newer one.
  const externalEditsRef = useRef(
    new Map<string, { editId: string; unsubscribe?: () => void }>(),
  );
  const externalSavesRef = useRef(new Map<string, Promise<void>>());
  const externalOpenTokensRef = useRef(new Map<string, number>());
  const externalMountedRef = useRef(true);

  useEffect(() => {
    externalMountedRef.current = true;
    const edits = externalEditsRef.current;
    return () => {
      externalMountedRef.current = false;
      for (const edit of edits.values()) {
        edit.unsubscribe?.();
        closeExternalEdit(edit.editId);
      }
      edits.clear();
    };
  }, []);

  function closeExternalEdit(editId: string) {
    void fileManagerApi()
      .post("/local/editor/close", { editId })
      .catch(() => {});
  }

  async function handleOpenExternally(file: FileItem) {
    const api = window.electronAPI;
    if (!api?.isElectron) {
      toast.error(t("fileManager.externalEditorDesktopOnly"));
      return;
    }
    const tokens = externalOpenTokensRef.current;
    const token = (tokens.get(file.path) ?? 0) + 1;
    tokens.set(file.path, token);
    // A newer open of this path, or unmounting, makes this request stale.
    const isStale = () =>
      !externalMountedRef.current || tokens.get(file.path) !== token;
    try {
      if (!(await confirmLargeFileOpen(file))) return;
      await ensureSSHConnection();
      // Let saves from a previous session finish before reading the file back.
      await externalSavesRef.current.get(file.path);
      const data = await downloadSSHFile(sshSessionId!, file.path);
      // Saves come back as UTF-8 text, so binary files would be corrupted.
      let text: string;
      try {
        const bytes = base64ToBytes(data.content);
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        toast.error(t("fileManager.externalEditorTextOnly"));
        return;
      }
      if (isStale()) return;
      const { data: result } = await fileManagerApi().post<{
        success: boolean;
        editId?: string;
        error?: string;
      }>("/local/editor/open", {
        fileName: file.name,
        content: text,
        encoding: "utf8",
      });
      if (!result.success || !result.editId) {
        throw new Error(result.error || "Failed to open external editor");
      }
      if (isStale()) {
        closeExternalEdit(result.editId);
        return;
      }
      const previous = externalEditsRef.current.get(file.path);
      if (previous) {
        previous.unsubscribe?.();
        closeExternalEdit(previous.editId);
        externalEditsRef.current.delete(file.path);
      }
      const sessionId = sshSessionId!;
      const saves = externalSavesRef.current;
      const unsubscribe = subscribeLocalEvents((event) => {
        if (event.type !== "editor-saved" || event.editId !== result.editId) {
          return;
        }
        const next = (saves.get(file.path) ?? Promise.resolve()).then(() =>
          writeSSHFile(sessionId, file.path, String(event.content)).then(
            () => void toast.success(t("fileManager.fileSavedSuccessfully")),
            (error: {
              message?: string;
              response?: { data?: { needsSudo?: boolean } };
            }) =>
              void toast.error(
                error.response?.data?.needsSudo
                  ? t("fileManager.permissionDenied")
                  : `${t("fileManager.failedToSaveFile")}: ${error.message || t("fileManager.unknownError")}`,
              ),
          ),
        );
        saves.set(file.path, next);
      });
      externalEditsRef.current.set(file.path, {
        editId: result.editId,
        unsubscribe,
      });
      toast.success(t("fileManager.externalEditorOpened"));
    } catch (error) {
      toast.error(
        `${t("fileManager.failedToOpenExternalEditor")}: ${error instanceof Error && error.message ? error.message : t("fileManager.unknownError")}`,
      );
    }
  }
  async function handleFileOpen(file: FileItem) {
    if (file.type === "directory") {
      directoryPrefetchRef.current?.setForeground(
        file.path !== currentPathRef.current,
      );
      markAdaptiveResourceUsed("network", "directory-list");
      directoryRequestRef.current += 1;
      const cached = sshSessionId
        ? peekCachedFileList(sshSessionId, file.path)
        : null;
      if (cached) setFiles(cached.files);
      setIsLoading(!!sshSessionId && !cached);
      setCurrentPath(file.path);
      return;
    }

    if (file.type === "link") {
      await handleSymlinkClick(file);
      return;
    }

    if (!sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }

    if (!(await confirmLargeFileOpen(file))) return;

    markFilePreviewUsed(file.name);
    markAdaptiveResourceUsed(
      "network",
      file.size && file.size > 128 * 1024
        ? "file-content:medium"
        : "file-content:small",
    );
    await recordRecentFile(file);
    openFileWindow(file, sshSessionId);
  }

  const prefetchFileIntent = useCallback(
    (file: FileItem) => {
      if (!sshSessionId || !isVisible) return;
      if (file.type === "directory") {
        directoryPrefetchRef.current?.intent(file.path);
        return;
      }
      const budget = getAdaptiveResourceBudget("network");
      if (shouldPrefetchFileContent(file, budget.maxPrefetchBytes)) {
        preloadFilePreview(file.name);
        runAdaptiveBackgroundTask(
          "network",
          file.size && file.size > 128 * 1024
            ? "file-content:medium"
            : "file-content:small",
          () => readSSHFile(sshSessionId, file.path),
          { estimatedBytes: file.size },
        );
      }
    },
    [sshSessionId, isVisible],
  );

  function handleContextMenu(event: React.MouseEvent, file?: FileItem) {
    event.preventDefault();

    let files: FileItem[];
    if (file) {
      const isFileSelected = selectedFiles.some((f) => f.path === file.path);
      files = isFileSelected ? selectedFiles : [file];
    } else {
      files = selectedFiles;
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      isVisible: true,
      files,
    });
  }

  function handleSidebarItemContextMenu(
    event: React.MouseEvent,
    item: SidebarItem,
  ) {
    const file: FileItem = {
      name: item.name,
      path: item.path,
      type:
        item.type === "recent" || item.type === "pinned" ? "file" : "directory",
    };
    handleContextMenu(event, file);
  }

  function handleCopyFiles(files: FileItem[]) {
    const entry = {
      files,
      operation: "copy" as const,
      sourceHostId: currentHost?.id ?? null,
      sourceSessionId: sshSessionId,
    };
    setClipboard(entry);
    window.dispatchEvent(
      new CustomEvent("file-manager:clipboard", { detail: entry }),
    );
    toast.success(
      t("fileManager.filesCopiedToClipboard", { count: files.length }),
    );
  }

  function handleCutFiles(files: FileItem[]) {
    const entry = {
      files,
      operation: "cut" as const,
      sourceHostId: currentHost?.id ?? null,
      sourceSessionId: sshSessionId,
    };
    setClipboard(entry);
    window.dispatchEvent(
      new CustomEvent("file-manager:clipboard", { detail: entry }),
    );
    toast.success(
      t("fileManager.filesCutToClipboard", { count: files.length }),
    );
  }

  function handleCopyPath(files: FileItem[]) {
    if (files.length === 0) return;

    const paths = files.map((file) => file.path).join("\n");

    copyToClipboard(paths).then((ok) => {
      if (ok) {
        toast.success(
          files.length === 1
            ? t("fileManager.pathCopiedToClipboard")
            : t("fileManager.pathsCopiedToClipboard", { count: files.length }),
        );
      } else {
        toast.error(t("fileManager.failedToCopyPath"));
      }
    });
  }

  function handleCopyFolderLink(path: string) {
    if (!currentHost?.id) return;
    const params = new URLSearchParams({
      view: "file-manager",
      hostId: String(currentHost.id),
      path,
    });
    const url = `${window.location.origin}?${params.toString()}`;
    copyToClipboard(url).then((ok) => {
      if (ok) {
        toast.success(t("fileManager.folderLinkCopied"));
      } else {
        toast.error(t("fileManager.failedToCopyFolderLink"));
      }
    });
  }

  async function handleCrossHostPaste() {
    if (!clipboard || !sshSessionId || !currentHost) return;

    const { files, operation, sourceSessionId } = clipboard;
    if (!sourceSessionId) return;

    const sourcePaths = files.map((f) => f.path);
    const isSingleFile = files.length === 1 && files[0].type === "file";
    const base = currentPath.replace(/\/+$/, "") || "/";
    const destPath = isSingleFile
      ? base.endsWith("/")
        ? `${base}${files[0].name}`
        : `${base}/${files[0].name}`
      : base;

    try {
      const { transferId } = await transferToHost(
        sourceSessionId,
        sourcePaths,
        sshSessionId,
        destPath,
        operation === "cut",
        "auto",
        2,
      );

      const monitorHandle = beginTransferProgressMonitoring(transferId, t, {
        formatTransferMetrics,
      });
      if (!monitorHandle) return;

      const finalStatus = await monitorHandle.waitForCompletion;

      if (
        finalStatus.status !== "success" &&
        finalStatus.status !== "partial"
      ) {
        return;
      }

      if (operation === "cut") {
        setClipboard(null);
      }

      handleRefreshDirectory();
      clearSelection();
    } catch (error: unknown) {
      const err = error as { message?: string };
      toast.error(
        `${t("transfer.transferError")}: ${err.message || t("fileManager.unknownError")}`,
      );
    }
  }

  async function handlePasteFiles() {
    if (!clipboard || !sshSessionId) return;
    await waitForDeletes(pendingDeleteRef);

    if (
      clipboard.sourceHostId !== null &&
      clipboard.sourceHostId !== currentHost?.id
    ) {
      await handleCrossHostPaste();
      return;
    }

    try {
      await ensureSSHConnection();

      const { files, operation } = clipboard;

      let successCount = 0;
      const copiedItems: string[] = [];

      for (const file of files) {
        try {
          if (operation === "copy") {
            const result = await copySSHItem(
              sshSessionId,
              file.path,
              currentPath,
              currentHost?.id,
              currentHost?.userId?.toString(),
            );
            copiedItems.push(result.uniqueName || file.name);
            successCount++;
          } else {
            const targetPath = currentPath.endsWith("/")
              ? `${currentPath}${file.name}`
              : `${currentPath}/${file.name}`;

            if (file.path !== targetPath) {
              await moveSSHItem(
                sshSessionId,
                file.path,
                targetPath,
                currentHost?.id,
                currentHost?.userId?.toString(),
              );
              successCount++;
            }
          }
        } catch (error: unknown) {
          const axiosError = error as {
            response?: { status?: number; data?: { error?: string } };
          };
          if (
            axiosError.response?.status === 403 ||
            axiosError.response?.data?.error
              ?.toLowerCase()
              .includes("permission denied")
          ) {
            toast.error(t("fileManager.permissionDenied"));
          } else {
            toast.error(
              t("fileManager.operationFailed", {
                operation:
                  operation === "copy"
                    ? t("fileManager.copy")
                    : t("fileManager.move"),
                name: file.name,
                error: getErrorMessage(error, String(error)),
              }),
            );
          }
        }
      }

      if (successCount > 0) {
        if (operation === "copy") {
          const copiedFiles = files
            .slice(0, successCount)
            .map((file, index) => ({
              originalPath: file.path,
              targetPath: `${currentPath}/${copiedItems[index] || file.name}`,
              targetName: copiedItems[index] || file.name,
            }));

          const undoAction: UndoAction = {
            type: "copy",
            description: t("fileManager.copiedItems", { count: successCount }),
            data: {
              operation: "copy",
              copiedFiles,
              targetDirectory: currentPath,
            },
            timestamp: Date.now(),
          };
          setUndoHistory((prev) => [...prev.slice(-9), undoAction]);
        } else if (operation === "cut") {
          const movedFiles = files.slice(0, successCount).map((file) => {
            const targetPath = currentPath.endsWith("/")
              ? `${currentPath}${file.name}`
              : `${currentPath}/${file.name}`;
            return {
              originalPath: file.path,
              targetPath: targetPath,
              targetName: file.name,
            };
          });

          const undoAction: UndoAction = {
            type: "cut",
            description: t("fileManager.movedItems", { count: successCount }),
            data: {
              operation: "cut",
              copiedFiles: movedFiles,
              targetDirectory: currentPath,
            },
            timestamp: Date.now(),
          };
          setUndoHistory((prev) => [...prev.slice(-9), undoAction]);
        }
      }

      if (successCount > 0) {
        const operationText =
          operation === "copy" ? t("fileManager.copy") : t("fileManager.move");
        if (operation === "copy" && copiedItems.length > 0) {
          const hasRenamed = copiedItems.some(
            (name) => !files.some((file) => file.name === name),
          );

          if (hasRenamed) {
            toast.success(
              t("fileManager.operationCompletedSuccessfully", {
                operation: operationText,
                count: successCount,
              }),
            );
          } else {
            toast.success(
              t("fileManager.operationCompleted", {
                operation: operationText,
                count: successCount,
              }),
            );
          }
        } else {
          toast.success(
            t("fileManager.operationCompleted", {
              operation: operationText,
              count: successCount,
            }),
          );
        }
      }

      handleRefreshDirectory();
      clearSelection();

      if (operation === "cut") {
        setClipboard(null);
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, String(error));
      toast.error(`${t("fileManager.pasteFailed")}: ${errorMessage}`);
    }
  }

  async function handleExtractArchive(file: FileItem) {
    if (!sshSessionId) return;

    try {
      await ensureSSHConnection();

      toast.info(t("fileManager.extractingArchive", { name: file.name }));

      await extractSSHArchive(
        sshSessionId,
        file.path,
        undefined,
        currentHost?.id,
        currentHost?.userId?.toString(),
      );

      toast.success(
        t("fileManager.archiveExtractedSuccessfully", { name: file.name }),
      );
      handleRefreshDirectory();
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, String(error));
      toast.error(`${t("fileManager.extractFailed")}: ${errorMessage}`);
    }
  }

  function handleOpenCompressDialog(files: FileItem[]) {
    setCompressDialogFiles(files);
  }

  async function handleCompress(archiveName: string, format: string) {
    if (!sshSessionId || compressDialogFiles.length === 0) return;

    try {
      await ensureSSHConnection();

      const paths = compressDialogFiles.map((f) => f.path);
      const fileNames = compressDialogFiles.map((f) => f.name);

      toast.info(
        t("fileManager.compressingFiles", {
          count: fileNames.length,
          name: archiveName,
        }),
      );

      await compressSSHFiles(
        sshSessionId,
        paths,
        archiveName,
        format,
        currentHost?.id,
        currentHost?.userId?.toString(),
      );

      toast.success(
        t("fileManager.filesCompressedSuccessfully", {
          name: archiveName,
        }),
      );
      handleRefreshDirectory();
      clearSelection();
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, String(error));
      toast.error(`${t("fileManager.compressFailed")}: ${errorMessage}`);
    }
  }

  function handleOpenTransferDialog(files: FileItem[], move: boolean) {
    setTransferFiles(files);
    setTransferMove(move);
    setTransferDialogOpen(true);
  }

  async function handleTransferConfirm(
    destSessionId: string,
    destHostId: number,
    destPath: string,
    destPathLabel: string,
    methodPreference: TransferMethodPreference,
    parallelSegmentCount?: number,
  ) {
    if (!sshSessionId || !currentHost?.id || transferFiles.length === 0) return;

    const sourcePaths = transferFiles.map((f) => f.path);

    try {
      await ensureSSHConnection();

      const { transferId } = await transferToHost(
        sshSessionId,
        sourcePaths,
        destSessionId,
        destPath,
        transferMove,
        methodPreference,
        parallelSegmentCount,
      );

      const monitorHandle = beginTransferProgressMonitoring(transferId, t, {
        formatTransferMetrics,
      });
      if (!monitorHandle) return;

      const finalStatus = await monitorHandle.waitForCompletion;

      if (
        finalStatus.status !== "success" &&
        finalStatus.status !== "partial"
      ) {
        return;
      }

      void addTransferRecent(
        currentHost.id,
        destHostId,
        destPathLabel,
        destPathLabel,
      );

      window.dispatchEvent(
        new CustomEvent("file-manager:refresh", {
          detail: { hostId: destHostId, path: destPathLabel },
        }),
      );

      if (transferMove) {
        handleRefreshDirectory();
        clearSelection();
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      toast.error(
        `${t("transfer.transferError")}: ${err.message || t("fileManager.unknownError")}`,
      );
    }
  }

  async function handleUndo() {
    await waitForDeletes(pendingDeleteRef);
    if (undoHistory.length === 0) {
      toast.info(t("fileManager.noUndoableActions"));
      return;
    }

    const lastAction = undoHistory[undoHistory.length - 1];

    try {
      await ensureSSHConnection();

      switch (lastAction.type) {
        case "copy":
          if (lastAction.data.copiedFiles) {
            let successCount = 0;
            for (const copiedFile of lastAction.data.copiedFiles) {
              try {
                const isDirectory =
                  files.find((f) => f.path === copiedFile.targetPath)?.type ===
                  "directory";
                await deleteSSHItem(
                  sshSessionId!,
                  copiedFile.targetPath,
                  isDirectory,
                  currentHost?.id,
                  currentHost?.userId?.toString(),
                );
                successCount++;
              } catch (error: unknown) {
                toast.error(
                  t("fileManager.deleteCopiedFileFailed", {
                    name: copiedFile.targetName,
                    error: getErrorMessage(error, String(error)),
                  }),
                );
              }
            }

            if (successCount > 0) {
              setUndoHistory((prev) => prev.slice(0, -1));
              toast.success(
                t("fileManager.undoCopySuccess", { count: successCount }),
              );
            } else {
              toast.error(t("fileManager.undoCopyFailedDelete"));
              return;
            }
          } else {
            toast.error(t("fileManager.undoCopyFailedNoInfo"));
            return;
          }
          break;

        case "cut":
          if (lastAction.data.copiedFiles) {
            let successCount = 0;
            for (const movedFile of lastAction.data.copiedFiles) {
              try {
                await moveSSHItem(
                  sshSessionId!,
                  movedFile.targetPath,
                  movedFile.originalPath,
                  currentHost?.id,
                  currentHost?.userId?.toString(),
                );
                successCount++;
              } catch (error: unknown) {
                toast.error(
                  t("fileManager.moveBackFileFailed", {
                    name: movedFile.targetName,
                    error: getErrorMessage(error, String(error)),
                  }),
                );
              }
            }

            if (successCount > 0) {
              setUndoHistory((prev) => prev.slice(0, -1));
              toast.success(
                t("fileManager.undoMoveSuccess", { count: successCount }),
              );
            } else {
              toast.error(t("fileManager.undoMoveFailedMove"));
              return;
            }
          } else {
            toast.error(t("fileManager.undoMoveFailedNoInfo"));
            return;
          }
          break;

        case "delete":
          toast.info(t("fileManager.undoDeleteNotSupported"));
          setUndoHistory((prev) => prev.slice(0, -1));
          return;

        default:
          toast.error(t("fileManager.undoTypeNotSupported"));
          return;
      }

      handleRefreshDirectory();
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, String(error));
      toast.error(`${t("fileManager.undoOperationFailed")}: ${errorMessage}`);
    }
  }

  function handleRenameFile(file: FileItem) {
    setEditingFile(file);
  }

  function handleOpenPermissionsDialog(file: FileItem) {
    setPermissionsDialogFile(file);
  }

  async function handleSavePermissions(file: FileItem, permissions: string) {
    if (!sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }

    try {
      await changeSSHPermissions(
        sshSessionId,
        file.path,
        permissions,
        currentHost?.id,
        currentHost?.userId?.toString(),
      );

      toast.success(t("fileManager.permissionsChangedSuccessfully"));
      await handleRefreshDirectory();
    } catch (error: unknown) {
      toast.error(t("fileManager.failedToChangePermissions"));
      throw error;
    }
  }

  async function ensureSSHConnection() {
    if (!sshSessionId || !currentHost) return;

    const status = await getSSHStatus(sshSessionId);

    if (!status.connected) {
      await connectSSH(sshSessionId, {
        hostId: currentHost.id,
        connectionOrigin: currentHost.connectionOrigin,
        syncId: currentHost.syncId ?? null,
        ip: currentHost.ip,
        port: currentHost.port,
        username: currentHost.username,
        password: currentHost.password,
        sshKey: currentHost.key,
        keyPassword: currentHost.keyPassword,
        authType: currentHost.authType,
        credentialId: currentHost.credentialId,
        userId: currentHost.userId,
        jumpHosts: currentHost.jumpHosts,
        useSocks5: currentHost.useSocks5,
        socks5Host: currentHost.socks5Host,
        socks5Port: currentHost.socks5Port,
        socks5Username: currentHost.socks5Username,
        socks5Password: currentHost.socks5Password,
        socks5ProxyChain: currentHost.socks5ProxyChain,
      });
    }
  }

  async function handleConfirmCreate(name: string) {
    if (!createIntent || !sshSessionId) return;
    await waitForDeletes(pendingDeleteRef);

    const operationPath = currentPath;
    const operationSession = sshSessionId;
    const optimisticPath = childPath(operationPath, name);
    const previousFiles = filesForPath(operationSession, operationPath);
    const optimisticFiles = addOptimisticItem(
      previousFiles,
      operationPath,
      name,
      createIntent.type,
    );
    const didAddOptimistically = optimisticFiles !== previousFiles;
    commitFilesForPath(operationSession, operationPath, optimisticFiles);
    const createdType = createIntent.type;
    setCreateIntent(null);

    try {
      await ensureSSHConnection();

      if (createdType === "file") {
        await createSSHFile(
          sshSessionId,
          currentPath,
          name,
          "",
          currentHost?.id,
          currentHost?.userId?.toString(),
        );
        toast.success(t("fileManager.fileCreatedSuccessfully", { name }));
      } else {
        await createSSHFolder(
          sshSessionId,
          currentPath,
          name,
          currentHost?.id,
          currentHost?.userId?.toString(),
        );
        toast.success(t("fileManager.folderCreatedSuccessfully", { name }));
      }

      if (
        sshSessionIdRef.current === operationSession &&
        currentPathRef.current === operationPath
      ) {
        handleRefreshDirectory();
      } else {
        invalidateCachedFileList(operationSession, operationPath);
      }
    } catch (error: unknown) {
      if (didAddOptimistically) {
        commitFilesForPath(
          operationSession,
          operationPath,
          removePaths(
            filesForPath(operationSession, operationPath),
            new Set([optimisticPath]),
          ),
        );
      }
      const axiosError = error as {
        response?: { status?: number; data?: { error?: string } };
      };
      if (
        axiosError.response?.status === 403 ||
        axiosError.response?.data?.error
          ?.toLowerCase()
          .includes("permission denied")
      ) {
        toast.error(t("fileManager.permissionDenied"));
      } else {
        toast.error(t("fileManager.failedToCreateItem"));
      }
    }
  }

  function handleCancelCreate() {
    setCreateIntent(null);
  }

  async function handleRenameConfirm(file: FileItem, newName: string) {
    if (!sshSessionId) return;
    await waitForDeletes(pendingDeleteRef);

    const operationPath = currentPath;
    const operationSession = sshSessionId;
    const renamedPath = childPath(
      file.path.slice(0, Math.max(1, file.path.lastIndexOf("/"))),
      newName,
    );
    const operationFiles = filesForPath(operationSession, operationPath);
    const didRenameOptimistically = !operationFiles.some(
      (entry) => entry.path === renamedPath && entry.path !== file.path,
    );
    if (didRenameOptimistically) {
      commitFilesForPath(
        operationSession,
        operationPath,
        renameOptimisticItem(operationFiles, file.path, newName),
      );
    }
    setEditingFile(null);

    try {
      await ensureSSHConnection();

      await renameSSHItem(
        sshSessionId,
        file.path,
        newName,
        currentHost?.id,
        currentHost?.userId?.toString(),
      );

      toast.success(
        t("fileManager.itemRenamedSuccessfully", { name: newName }),
      );
      if (
        sshSessionIdRef.current === operationSession &&
        currentPathRef.current === operationPath
      ) {
        handleRefreshDirectory();
      } else {
        invalidateCachedFileList(operationSession, operationPath);
      }
    } catch (error: unknown) {
      if (didRenameOptimistically) {
        commitFilesForPath(
          operationSession,
          operationPath,
          renameOptimisticItem(
            filesForPath(operationSession, operationPath),
            renamedPath,
            file.name,
          ),
        );
      }
      const axiosError = error as {
        response?: { status?: number; data?: { error?: string } };
      };
      if (
        axiosError.response?.status === 403 ||
        axiosError.response?.data?.error
          ?.toLowerCase()
          .includes("permission denied")
      ) {
        toast.error(t("fileManager.permissionDenied"));
      } else {
        toast.error(t("fileManager.failedToRenameItem"));
      }
    }
  }

  function handleStartEdit(file: FileItem) {
    setEditingFile(file);
  }

  function handleCancelEdit() {
    setEditingFile(null);
  }

  async function handleTotpSubmit(code: string) {
    if (!totpSessionId || !code) return;

    try {
      setIsLoading(true);
      const result = await verifySSHTOTP(totpSessionId, code);

      if (result?.status === "success") {
        setTotpRequired(false);
        setTotpPrompt("");
        setSshSessionId(totpSessionId);
        setTotpSessionId(null);
        connectRetryRef.current.markConnected();

        try {
          const authRequestId = ++directoryRequestRef.current;
          const response = await listSSHFiles(totpSessionId, currentPath);
          publishConnectedListing(
            totpSessionId,
            currentPath,
            response,
            authRequestId,
          );
          clearSelection();
          initialLoadDoneRef.current = true;
          toast.success(t("fileManager.connectedSuccessfully"));

          logFileManagerActivity();
        } catch (dirError: unknown) {}
      }
    } catch (error: unknown) {
      toast.error(t("fileManager.totpVerificationFailed"));
    } finally {
      setIsLoading(false);
    }
  }

  function handleTotpCancel() {
    setTotpRequired(false);
    setTotpPrompt("");
    setTotpSessionId(null);
    if (onClose) onClose();
  }

  async function handleBrowserSignInContinue() {
    if (!browserSignInSessionId) return;

    try {
      setIsLoading(true);
      const result = await verifySSHBrowserSignIn(browserSignInSessionId);

      if (result?.status === "success") {
        setBrowserSignInRequired(false);
        setBrowserSignInUrl("");
        setBrowserSignInCode("");
        setSshSessionId(browserSignInSessionId);
        setBrowserSignInSessionId(null);
        connectRetryRef.current.markConnected();

        try {
          const authRequestId = ++directoryRequestRef.current;
          const response = await listSSHFiles(
            browserSignInSessionId,
            currentPath,
          );
          publishConnectedListing(
            browserSignInSessionId,
            currentPath,
            response,
            authRequestId,
          );
          clearSelection();
          initialLoadDoneRef.current = true;
          toast.success(t("fileManager.connectedSuccessfully"));

          logFileManagerActivity();
        } catch (dirError: unknown) {}
      }
    } catch (error: unknown) {
      toast.error(t("fileManager.browserSignInFailed"));
    } finally {
      setIsLoading(false);
    }
  }

  function handleBrowserSignInCancel() {
    setBrowserSignInRequired(false);
    setBrowserSignInUrl("");
    setBrowserSignInCode("");
    setBrowserSignInSessionId(null);
    if (onClose) onClose();
  }

  function handleBrowserSignInOpenUrl() {
    if (browserSignInUrl) {
      window.open(browserSignInUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function handleAuthDialogSubmit(credentials: {
    password?: string;
    sshKey?: string;
    keyPassword?: string;
  }) {
    if (!currentHost) return;

    try {
      setIsLoading(true);
      setShowAuthDialog(false);

      const sessionId = currentHost.id.toString();

      const result = await connectSSH(sessionId, {
        hostId: currentHost.id,
        connectionOrigin: currentHost.connectionOrigin,
        syncId: currentHost.syncId ?? null,
        ip: currentHost.ip,
        port: currentHost.port,
        username: currentHost.username,
        password: credentials.password,
        sshKey: credentials.sshKey,
        keyPassword: credentials.keyPassword,
        authType: credentials.password ? "password" : "key",
        credentialId: currentHost.credentialId,
        userId: currentHost.userId,
        jumpHosts: currentHost.jumpHosts,
        useSocks5: currentHost.useSocks5,
        socks5Host: currentHost.socks5Host,
        socks5Port: currentHost.socks5Port,
        socks5Username: currentHost.socks5Username,
        socks5Password: currentHost.socks5Password,
        socks5ProxyChain: currentHost.socks5ProxyChain,
      });

      if (result?.requires_browser_sign_in) {
        setBrowserSignInRequired(true);
        setBrowserSignInSessionId(sessionId);
        setBrowserSignInUrl(result.url || "");
        setBrowserSignInCode(result.code || "N/A");
        setBrowserSignInLabel(result.label || "");
        setIsLoading(false);
        return;
      }

      if (result?.requires_totp) {
        setTotpRequired(true);
        setTotpSessionId(sessionId);
        setTotpPrompt(result.prompt || t("fileManager.verificationCodePrompt"));
        setIsLoading(false);
        return;
      }

      if (result?.status === "auth_required") {
        setAuthDialogReason(result.reason || "auth_failed");
        setShowAuthDialog(true);
        setIsLoading(false);
        toast.error(t("fileManager.authenticationFailed"));
        return;
      }

      setSshSessionId(sessionId);
      connectRetryRef.current.markConnected();

      try {
        const authRequestId = ++directoryRequestRef.current;
        const response = await listSSHFiles(sessionId, currentPath);
        publishConnectedListing(
          sessionId,
          currentPath,
          response,
          authRequestId,
        );
        clearSelection();
        initialLoadDoneRef.current = true;
        toast.success(t("fileManager.connectedSuccessfully"));
        logFileManagerActivity();
      } catch (dirError: unknown) {}
    } catch (error: unknown) {
      setAuthDialogReason("auth_failed");
      setShowAuthDialog(true);
      toast.error(
        t("fileManager.failedToConnect") +
          ": " +
          getErrorMessage(error, String(error)),
      );
    } finally {
      setIsLoading(false);
    }
  }

  function handleAuthDialogCancel() {
    setShowAuthDialog(false);
    if (onClose) onClose();
  }

  async function handlePassphraseSubmit(passphrase: string) {
    if (!currentHost) return;

    try {
      setIsLoading(true);
      setShowPassphraseDialog(false);

      const sessionId = currentHost.id.toString();

      const result = await connectSSH(sessionId, {
        hostId: currentHost.id,
        connectionOrigin: currentHost.connectionOrigin,
        syncId: currentHost.syncId ?? null,
        ip: currentHost.ip,
        port: currentHost.port,
        username: currentHost.username,
        sshKey: currentHost.key,
        keyPassword: passphrase,
        authType: "key",
        credentialId: currentHost.credentialId,
        userId: currentHost.userId,
        jumpHosts: currentHost.jumpHosts,
        useSocks5: currentHost.useSocks5,
        socks5Host: currentHost.socks5Host,
        socks5Port: currentHost.socks5Port,
        socks5Username: currentHost.socks5Username,
        socks5Password: currentHost.socks5Password,
        socks5ProxyChain: currentHost.socks5ProxyChain,
      });

      if (result?.status === "passphrase_required") {
        setShowPassphraseDialog(true);
        setIsLoading(false);
        toast.error(t("fileManager.incorrectPassphrase"));
        return;
      }

      if (result?.requires_totp) {
        setTotpRequired(true);
        setTotpSessionId(sessionId);
        setTotpPrompt(result.prompt || t("fileManager.verificationCodePrompt"));
        setIsLoading(false);
        return;
      }

      if (result?.status === "auth_required") {
        setAuthDialogReason(result.reason || "auth_failed");
        setShowAuthDialog(true);
        setIsLoading(false);
        return;
      }

      setSshSessionId(sessionId);
      connectRetryRef.current.markConnected();

      try {
        const authRequestId = ++directoryRequestRef.current;
        const response = await listSSHFiles(sessionId, currentPath);
        publishConnectedListing(
          sessionId,
          currentPath,
          response,
          authRequestId,
        );
        clearSelection();
        initialLoadDoneRef.current = true;
        toast.success(t("fileManager.connectedSuccessfully"));
        logFileManagerActivity();
      } catch (dirError: unknown) {}
    } catch (error: unknown) {
      setShowPassphraseDialog(true);
      toast.error(t("fileManager.incorrectPassphrase"));
    } finally {
      setIsLoading(false);
    }
  }

  function handlePassphraseCancel() {
    setShowPassphraseDialog(false);
    if (onClose) onClose();
  }

  function generateUniqueName(
    baseName: string,
    type: "file" | "directory",
  ): string {
    const existingNames = files.map((f) => f.name.toLowerCase());
    let candidateName = baseName;
    let counter = 1;

    while (existingNames.includes(candidateName.toLowerCase())) {
      if (type === "file" && baseName.includes(".")) {
        const lastDotIndex = baseName.lastIndexOf(".");
        const nameWithoutExt = baseName.substring(0, lastDotIndex);
        const extension = baseName.substring(lastDotIndex);
        candidateName = `${nameWithoutExt}${counter}${extension}`;
      } else {
        candidateName = `${baseName}${counter}`;
      }
      counter++;
    }

    return candidateName;
  }

  async function handleFileDrop(
    draggedFiles: FileItem[],
    targetFolder: FileItem,
  ) {
    if (!sshSessionId || targetFolder.type !== "directory") return;
    await waitForDeletes(pendingDeleteRef);

    try {
      await ensureSSHConnection();

      let successCount = 0;
      const movedItems: string[] = [];

      for (const file of draggedFiles) {
        try {
          const targetPath = targetFolder.path.endsWith("/")
            ? `${targetFolder.path}${file.name}`
            : `${targetFolder.path}/${file.name}`;

          if (file.path !== targetPath) {
            await moveSSHItem(
              sshSessionId,
              file.path,
              targetPath,
              currentHost?.id,
              currentHost?.userId?.toString(),
            );
            movedItems.push(file.name);
            successCount++;
          }
        } catch (error: unknown) {
          toast.error(
            t("fileManager.moveFileFailed", { name: file.name }) +
              ": " +
              getErrorMessage(error, String(error)),
          );
        }
      }

      if (successCount > 0) {
        const movedFiles = draggedFiles.slice(0, successCount).map((file) => {
          const targetPath = targetFolder.path.endsWith("/")
            ? `${targetFolder.path}${file.name}`
            : `${targetFolder.path}/${file.name}`;
          return {
            originalPath: file.path,
            targetPath: targetPath,
            targetName: file.name,
          };
        });

        const undoAction: UndoAction = {
          type: "cut",
          description: t("fileManager.dragMovedItems", {
            count: successCount,
            target: targetFolder.name,
          }),
          data: {
            operation: "cut",
            copiedFiles: movedFiles,
            targetDirectory: targetFolder.path,
          },
          timestamp: Date.now(),
        };
        setUndoHistory((prev) => [...prev.slice(-9), undoAction]);

        toast.success(
          t("fileManager.successfullyMovedItems", {
            count: successCount,
            target: targetFolder.name,
          }),
        );
        handleRefreshDirectory();
        clearSelection();
      }
    } catch (error: unknown) {
      toast.error(
        t("fileManager.moveOperationFailed") +
          ": " +
          getErrorMessage(error, String(error)),
      );
    }
  }

  function handleFileDiff(file1: FileItem, file2: FileItem) {
    if (file1.type !== "file" || file2.type !== "file") {
      toast.error(t("fileManager.canOnlyCompareFiles"));
      return;
    }

    if (!sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }

    const offsetX = 100;
    const offsetY = 80;

    const createWindowComponent = (windowId: string) => (
      <DiffWindow
        windowId={windowId}
        file1={file1}
        file2={file2}
        sshSessionId={sshSessionId}
        sshHost={currentHost}
        initialX={offsetX}
        initialY={offsetY}
      />
    );

    openWindow({
      title: t("fileManager.fileComparison", {
        file1: file1.name,
        file2: file2.name,
      }),
      x: offsetX,
      y: offsetY,
      width: 800,
      height: 600,
      isMaximized: compact,
      isMinimized: false,
      component: createWindowComponent,
    });

    toast.success(
      t("fileManager.comparingFiles", { file1: file1.name, file2: file2.name }),
    );
  }

  async function handleDragToDesktop(files: FileItem[]) {
    if (!currentHost || !sshSessionId) {
      toast.error(t("fileManager.noSSHConnection"));
      return;
    }

    try {
      if (systemDrag.isFileSystemAPISupported) {
        await systemDrag.handleDragToSystem(files, {
          enableToast: true,
        });
      } else {
        if (files.length === 1) {
          await dragToDesktop.dragFileToDesktop(files[0]);
        } else if (files.length > 1) {
          await dragToDesktop.dragFilesToDesktop(files);
        }
      }
    } catch (error: unknown) {
      toast.error(
        t("fileManager.dragFailed") +
          ": " +
          getErrorMessage(error, String(error)),
      );
    }
  }

  function handleOpenTerminal(path: string) {
    if (!currentHost) {
      toast.error(t("fileManager.noHostSelected"));
      return;
    }

    const windowCount = Date.now() % 10;
    const offsetX = 200 + windowCount * 40;
    const offsetY = 150 + windowCount * 40;

    const createTerminalComponent = (windowId: string) => (
      <TerminalWindow
        windowId={windowId}
        hostConfig={currentHost}
        initialPath={path}
        initialX={offsetX}
        initialY={offsetY}
        onPromoteToTab={onOpenTerminalTab}
      />
    );

    openWindow({
      title: t("fileManager.terminal", { host: currentHost.name, path }),
      x: offsetX,
      y: offsetY,
      width: 800,
      height: 500,
      isMaximized: compact,
      isMinimized: false,
      component: createTerminalComponent,
    });

    toast.success(
      t("terminal.terminalWithPath", { host: currentHost.name, path }),
    );
  }

  function handleRunExecutable(file: FileItem) {
    if (!currentHost) {
      toast.error(t("fileManager.noHostSelected"));
      return;
    }

    if (file.type !== "file" || !file.executable) {
      toast.error(t("fileManager.onlyRunExecutableFiles"));
      return;
    }

    const fileDir = file.path.substring(0, file.path.lastIndexOf("/"));
    const fileName = file.name;
    const executeCmd = `./${fileName}`;

    const windowCount = Date.now() % 10;
    const offsetX = 250 + windowCount * 40;
    const offsetY = 200 + windowCount * 40;

    const createExecutionTerminal = (windowId: string) => (
      <TerminalWindow
        windowId={windowId}
        hostConfig={currentHost}
        initialPath={fileDir}
        initialX={offsetX}
        initialY={offsetY}
        executeCommand={executeCmd}
        onPromoteToTab={onOpenTerminalTab}
      />
    );

    openWindow({
      title: t("fileManager.runningFile", { file: file.name }),
      x: offsetX,
      y: offsetY,
      width: 800,
      height: 500,
      isMaximized: compact,
      isMinimized: false,
      component: createExecutionTerminal,
    });

    toast.success(t("fileManager.runningFile", { file: file.name }));
  }

  async function loadPinnedFiles() {
    if (!currentHost?.id) return;

    try {
      const pinnedData = await getPinnedFiles(currentHost.id);
      const pinnedPaths = new Set(pinnedData.map((item) => item.path));
      setPinnedFiles(pinnedPaths);
    } catch (error) {
      console.error("Failed to load pinned files:", error);
    }
  }

  async function handlePinFile(file: FileItem) {
    if (!currentHost?.id) return;

    try {
      await addPinnedFile(currentHost.id, file.path, file.name);
      setPinnedFiles((prev) => new Set([...prev, file.path]));
      setSidebarRefreshTrigger((prev) => prev + 1);
      toast.success(
        t("fileManager.filePinnedSuccessfully", { name: file.name }),
      );
    } catch (error) {
      toast.error(t("fileManager.pinFileFailed"));
    }
  }

  async function handleUnpinFile(file: FileItem) {
    if (!currentHost?.id) return;

    try {
      await removePinnedFile(currentHost.id, file.path);
      setPinnedFiles((prev) => {
        const newSet = new Set(prev);
        newSet.delete(file.path);
        return newSet;
      });
      setSidebarRefreshTrigger((prev) => prev + 1);
      toast.success(
        t("fileManager.fileUnpinnedSuccessfully", { name: file.name }),
      );
    } catch (error) {
      toast.error(t("fileManager.unpinFileFailed"));
    }
  }

  async function handleAddShortcut(path: string) {
    if (!currentHost?.id) return;

    try {
      const folderName = path.split("/").pop() || path;
      await addFolderShortcut(currentHost.id, path, folderName);
      setSidebarRefreshTrigger((prev) => prev + 1);
      toast.success(
        t("fileManager.shortcutAddedSuccessfully", { name: folderName }),
      );
    } catch (error) {
      toast.error(t("fileManager.addShortcutFailed"));
    }
  }

  function isPinnedFile(file: FileItem): boolean {
    return pinnedFiles.has(file.path);
  }

  async function recordRecentFile(file: FileItem) {
    if (!currentHost?.id || file.type === "directory") return;

    try {
      await addRecentFile(currentHost.id, file.path, file.name);
      setSidebarRefreshTrigger((prev) => prev + 1);
    } catch {
      // Only the recent and pinned lists, safe to skip
    }
  }

  async function handleSidebarFileOpen(sidebarItem: SidebarItem) {
    const file: FileItem = {
      name: sidebarItem.name,
      path: sidebarItem.path,
      type: "file",
    };

    await handleFileOpen(file);
  }

  async function handleFileNotFound(file: FileItem) {
    if (!currentHost) return;

    try {
      await removeRecentFile(currentHost.id, file.path);

      await removePinnedFile(currentHost.id, file.path);

      setSidebarRefreshTrigger((prev) => prev + 1);
    } catch {
      // Only the recent and pinned lists, safe to skip
    }
  }

  useEffect(() => {
    setCreateIntent(null);
  }, [currentPath]);

  useEffect(() => {
    if (currentHost?.id) loadPinnedFiles();
  }, [currentHost?.id]);

  useEffect(() => {
    let cancelled = false;
    setDiskInfo(null);
    if (currentHost?.id) {
      // Undefined while the host-metrics plugin is off: no disk bar then.
      invokeAction("host-metrics.disk", currentHost.id)
        .then((result) => {
          if (cancelled) return;
          const disk = result as HostDiskInfo | null | undefined;
          if (disk?.percent != null && disk.usedHuman && disk.totalHuman) {
            setDiskInfo({
              usedHuman: disk.usedHuman,
              totalHuman: disk.totalHuman,
              percent: disk.percent,
              mount: disk.mount ?? null,
              filesystems: disk.filesystems ?? [],
            });
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [currentHost?.id, lastRefreshTime]);

  useEffect(() => {
    localStorage.setItem("fileManagerDensity", density);
  }, [density]);

  useEffect(() => {
    localStorage.setItem("fileManagerSortBy", sortBy);
    localStorage.setItem("fileManagerSortOrder", sortOrder);
  }, [sortBy, sortOrder]);

  const filteredFiles = useMemo(
    () => filterAndSortFiles(files, searchQuery, sortBy, sortOrder),
    [files, searchQuery, sortBy, sortOrder],
  );

  if (!currentHost) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-muted-foreground mb-4">
            {t("fileManager.selectHostToStart")}
          </p>
        </div>
      </div>
    );
  }

  // No session yet: the connection screen stays up through failures and
  // retries, instead of falling through to an empty file tree. A login
  // prompt still gets the main view, which draws it.
  const awaitingPrompt =
    totpRequired ||
    browserSignInRequired ||
    showAuthDialog ||
    showPassphraseDialog;
  if (currentHost && !sshSessionId && !awaitingPrompt) {
    return (
      <div className="h-full w-full flex flex-col bg-background relative">
        <ConnectionScreen
          status={
            isReconnecting || isLoading ? "connecting" : connectRetry.status
          }
          message={t("fileManager.connecting")}
          detail={
            currentHost.ip
              ? `${currentHost.username ? `${currentHost.username}@` : ""}${currentHost.ip}${currentHost.port ? `:${currentHost.port}` : ""}`
              : undefined
          }
          errorDetail={lastConnectionError}
          attempt={connectRetry.attempt}
          maxAttempts={connectRetry.maxAttempts}
          nextRetryInMs={connectRetry.nextRetryInMs}
          onManualRetry={connectRetry.retryNow}
          logPosition={hasConnectionError ? "top" : "bottom"}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background relative overflow-hidden isolate">
      <PanelShell
        icon={<Folder className="size-4" />}
        title={t("nav.files")}
        status={
          currentHost
            ? currentHost.name || `${currentHost.username}@${currentHost.ip}`
            : undefined
        }
        scroll={false}
      >
        <FileManagerToolbar
          t={t}
          currentPath={currentPath}
          navIndex={navIndex}
          navHistoryLength={navHistory.length}
          isLoading={isLoading}
          sshSessionId={sshSessionId}
          selectedFiles={selectedFiles}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          viewMode={viewMode}
          setViewMode={setViewMode}
          density={density}
          setDensity={setDensity}
          sortBy={sortBy}
          setSortBy={setSortBy}
          sortOrder={sortOrder}
          setSortOrder={setSortOrder}
          setMobileSidebarOpen={setMobileSidebarOpen}
          goBack={goBack}
          goForward={goForward}
          goUp={goUp}
          navigateTo={navigateTo}
          handleRefreshDirectory={handleRefreshDirectory}
          handleDeleteFiles={handleDeleteFiles}
          handleCopyFiles={handleCopyFiles}
          handleFilesDropped={handleFilesDropped}
          handleCreateNewFolder={handleCreateNewFolder}
          handleCreateNewFile={handleCreateNewFile}
          showLocalPaneToggle={localPaneAvailable}
          localPaneOpen={localPaneAvailable && localPaneOpen}
          onToggleLocalPane={toggleLocalPane}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          compact={compact}
        />

        <div
          ref={panesRowRef}
          className="flex-1 flex min-h-0 relative"
          {...dragHandlers}
        >
          {/* Mobile sidebar backdrop */}
          {mobileSidebarOpen && (
            <div
              className="fixed inset-0 z-20 bg-black/40 md:hidden"
              onClick={() => setMobileSidebarOpen(false)}
            />
          )}

          {/* Sidebar: fixed overlay on mobile, static on desktop */}
          <div
            className={cn(
              "flex-shrink-0 h-full flex flex-col",
              mobileSidebarOpen
                ? "fixed left-0 top-0 bottom-0 w-64 z-30 flex"
                : sidebarOpen
                  ? "hidden md:flex"
                  : "hidden",
            )}
            style={
              mobileSidebarOpen
                ? undefined
                : { width: sidebarSize.width, minWidth: SIDEBAR_MIN_WIDTH }
            }
          >
            <div className="flex-1 flex flex-col overflow-hidden min-h-0 border-r border-border bg-background">
              <FileManagerSidebar
                density={density}
                currentHost={currentHost}
                currentPath={currentPath}
                onPathChange={navigateTo}
                onFileOpen={handleSidebarFileOpen}
                onItemContextMenu={handleSidebarItemContextMenu}
                sshSessionId={sshSessionId}
                refreshTrigger={sidebarRefreshTrigger}
                onOpenTrash={() => setTrashOpen(true)}
                diskInfo={diskInfo ?? undefined}
              />
            </div>
          </div>
          {sidebarOpen && !mobileSidebarOpen && (
            <PaneResizeHandle
              label={t("fileManager.resizeSidebar")}
              onMouseDown={sidebarSize.startResize}
              onDoubleClick={sidebarSize.resetWidth}
              active={sidebarSize.isResizing}
            />
          )}

          {localPaneAvailable && localPaneOpen && (
            <>
              <div
                className="hidden md:flex flex-shrink-0 relative overflow-hidden min-h-0 flex-col border-r border-border bg-background"
                style={{
                  width: localPaneSize.width,
                  minWidth: LOCAL_PANE_MIN_WIDTH,
                  maxWidth: "65%",
                }}
              >
                <LocalFilePane
                  refreshToken={localPaneRefreshToken}
                  onClose={toggleLocalPane}
                  onRemoteItemsDropped={handleRemoteItemsDroppedToLocal}
                  onUploadToRemote={handleLocalFilesDrop}
                />
              </div>
              <PaneResizeHandle
                label={t("fileManager.resizeLocalPane")}
                onMouseDown={localPaneSize.startResize}
                onDoubleClick={localPaneSize.resetWidth}
                active={localPaneSize.isResizing}
              />
            </>
          )}

          <div className="flex-1 basis-0 relative overflow-hidden min-h-0 flex flex-col bg-background">
            <div className="flex-1 relative min-h-0 h-full">
              <FileManagerGrid
                files={filteredFiles}
                isLoading={isLoading}
                selectedFiles={selectedFiles}
                deletingPaths={deletingPaths}
                onFileOpen={handleFileOpen}
                onFileIntent={prefetchFileIntent}
                onDirectoryHover={(file) =>
                  isVisible && directoryPrefetchRef.current?.hover(file.path)
                }
                onDirectoryLeave={(file) =>
                  directoryPrefetchRef.current?.cancelIntent(file.path)
                }
                onSelectionChange={setSelection}
                onRefresh={handleRefreshDirectory}
                onUpload={handleFilesDropped}
                onUploadItems={handleItemsDropped}
                onLocalFilesDrop={
                  localPaneAvailable ? handleLocalFilesDrop : undefined
                }
                parentPath={
                  currentPath === "/"
                    ? null
                    : currentPath.substring(0, currentPath.lastIndexOf("/")) ||
                      "/"
                }
                onNavigateUp={goUp}
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSortChange={(field) => {
                  if (field === sortBy) {
                    setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                  } else {
                    setSortBy(field);
                    setSortOrder("asc");
                  }
                }}
                onDownload={(files) =>
                  files
                    .filter((f) => f.type === "file")
                    .forEach(handleDownloadFile)
                }
                onContextMenu={handleContextMenu}
                viewMode={viewMode}
                density={density}
                onRename={handleRenameConfirm}
                editingFile={editingFile}
                onStartEdit={handleStartEdit}
                onCancelEdit={handleCancelEdit}
                onDelete={handleDeleteFiles}
                onCopy={handleCopyFiles}
                onCut={handleCutFiles}
                onPaste={handlePasteFiles}
                onUndo={handleUndo}
                hasClipboard={!!clipboard}
                onFileDrop={handleFileDrop}
                onFileDiff={handleFileDiff}
                onSystemDragStart={handleFileDragStart}
                onSystemDragEnd={handleFileDragEnd}
                createIntent={createIntent}
                onConfirmCreate={handleConfirmCreate}
                onCancelCreate={handleCancelCreate}
                onNewFile={handleCreateNewFile}
                onNewFolder={handleCreateNewFolder}
              />

              <FileManagerContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                files={contextMenu.files}
                isVisible={contextMenu.isVisible}
                onClose={() =>
                  setContextMenu((prev) => ({ ...prev, isVisible: false }))
                }
                onDownload={(files) =>
                  files
                    .filter((f) => f.type === "file")
                    .forEach(handleDownloadFile)
                }
                onPreview={handleFileOpen}
                onOpenExternally={handleOpenExternally}
                onRename={handleRenameFile}
                onCopy={handleCopyFiles}
                onCut={handleCutFiles}
                onPaste={handlePasteFiles}
                onDelete={handleDeleteFiles}
                onUpload={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.multiple = true;
                  input.onchange = (e) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files) handleFilesDropped(files);
                  };
                  input.click();
                }}
                onNewFolder={handleCreateNewFolder}
                onNewFile={handleCreateNewFile}
                onRefresh={handleRefreshDirectory}
                hasClipboard={!!clipboard}
                onDragToDesktop={() => handleDragToDesktop(contextMenu.files)}
                onOpenTerminal={(path) => handleOpenTerminal(path)}
                onRunExecutable={(file) => handleRunExecutable(file)}
                onPinFile={handlePinFile}
                onUnpinFile={handleUnpinFile}
                onAddShortcut={handleAddShortcut}
                isPinned={isPinnedFile}
                currentPath={currentPath}
                onProperties={handleOpenPermissionsDialog}
                onExtractArchive={handleExtractArchive}
                onCompress={handleOpenCompressDialog}
                onCopyPath={handleCopyPath}
                onCopyFolderLink={handleCopyFolderLink}
                onTransferToHost={handleOpenTransferDialog}
              />
            </div>
          </div>
        </div>

        <FileManagerTrashDialog
          open={trashOpen}
          onOpenChange={setTrashOpen}
          sessionId={sshSessionId}
          onChanged={() => {
            if (sshSessionId)
              invalidateCachedFileList(sshSessionId, currentPath);
            void handleRefreshDirectory();
          }}
        />
      </PanelShell>

      {currentHost && (
        <TransferToHostDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          files={transferFiles}
          move={transferMove}
          sourceHost={currentHost}
          sourceSessionId={sshSessionId}
          onConfirm={handleTransferConfirm}
        />
      )}

      {currentHost && (
        <PassphraseDialog
          isOpen={showPassphraseDialog}
          onSubmit={handlePassphraseSubmit}
          onCancel={handlePassphraseCancel}
          hostInfo={{
            ip: currentHost.ip,
            port: currentHost.port,
            username: currentHost.username,
            name: currentHost.name,
          }}
          backgroundColor="var(--bg-canvas)"
        />
      )}

      <FileManagerDialogs
        compressDialogFiles={compressDialogFiles}
        setCompressDialogFiles={setCompressDialogFiles}
        handleCompress={handleCompress}
        totpRequired={totpRequired}
        totpPrompt={totpPrompt}
        handleTotpSubmit={handleTotpSubmit}
        handleTotpCancel={handleTotpCancel}
        browserSignInRequired={browserSignInRequired}
        browserSignInUrl={browserSignInUrl}
        browserSignInCode={browserSignInCode}
        browserSignInLabel={browserSignInLabel}
        handleBrowserSignInContinue={handleBrowserSignInContinue}
        handleBrowserSignInCancel={handleBrowserSignInCancel}
        handleBrowserSignInOpenUrl={handleBrowserSignInOpenUrl}
        currentHost={currentHost}
        showAuthDialog={showAuthDialog}
        authDialogReason={authDialogReason}
        handleAuthDialogSubmit={handleAuthDialogSubmit}
        handleAuthDialogCancel={handleAuthDialogCancel}
        permissionsDialogFile={permissionsDialogFile}
        setPermissionsDialogFile={setPermissionsDialogFile}
        handleSavePermissions={handleSavePermissions}
        sudoDialogOpen={sudoDialogOpen}
        setSudoDialogOpen={setSudoDialogOpen}
        setPendingSudoOperation={(op) =>
          op ? setPendingSudoOperation(op) : dismissSudo()
        }
        handleSudoPasswordSubmit={handleSudoPasswordSubmit}
      />
      <ConnectionLogPanel
        isConnecting={isReconnecting || isLoading}
        isConnected={!!sshSessionId && !isReconnecting}
        hasConnectionError={hasConnectionError}
        position={hasConnectionError ? "top" : "bottom"}
      />
    </div>
  );
}

function FileManagerInner({
  initialHost,
  initialFilePath,
  initialPath,
  onClose,
  onOpenTerminalTab,
  isVisible = true,
  compact,
  externalPath,
  onPathChange,
}: FileManagerProps) {
  return (
    <WindowManager>
      <FileManagerContent
        initialHost={initialHost}
        initialFilePath={initialFilePath}
        initialPath={initialPath}
        onClose={onClose}
        onOpenTerminalTab={onOpenTerminalTab}
        isVisible={isVisible}
        compact={compact}
        externalPath={externalPath}
        onPathChange={onPathChange}
      />
    </WindowManager>
  );
}

export function FileManager(props: FileManagerProps) {
  return (
    <ConnectionLogProvider>
      <FileManagerInner {...props} />
    </ConnectionLogProvider>
  );
}
