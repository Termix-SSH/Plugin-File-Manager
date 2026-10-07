import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePlus,
  Folder,
  FolderPlus,
  Laptop,
  Layout,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PanelSearch,
  ViewToggle,
} from "@termix-ssh/plugin-sdk/ui";
import type { FileItem } from "./host-types";

type SortBy = "name" | "modified" | "size";
type SortOrder = "asc" | "desc";
type ViewMode = "grid" | "list";
type Density = "comfortable" | "compact";

type FileManagerToolbarProps = {
  t: (key: string) => string;
  currentPath: string;
  navIndex: number;
  navHistoryLength: number;
  isLoading: boolean;
  sshSessionId: string | null;
  selectedFiles: FileItem[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  density: Density;
  setDensity: (density: Density) => void;
  sortBy: SortBy;
  setSortBy: (sortBy: SortBy) => void;
  sortOrder: SortOrder;
  setSortOrder: (sortOrder: SortOrder) => void;
  setMobileSidebarOpen: (updater: (open: boolean) => boolean) => void;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  navigateTo: (path: string) => void;
  handleRefreshDirectory: () => void;
  handleDeleteFiles: (files: FileItem[]) => void;
  handleCopyFiles: (files: FileItem[]) => void;
  handleFilesDropped: (fileList: FileList) => void;
  handleCreateNewFolder: () => void;
  handleCreateNewFile: () => void;
  /** Desktop app only: show the Local | Remote split-view toggle. */
  showLocalPaneToggle?: boolean;
  localPaneOpen?: boolean;
  onToggleLocalPane?: () => void;
  /** Desktop directories sidebar (mobile uses the overlay instead). */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
};

function Breadcrumb({
  currentPath,
  navigateTo,
  t,
}: Pick<FileManagerToolbarProps, "currentPath" | "navigateTo" | "t">) {
  return (
    <>
      <Folder className="size-3.5 text-accent-brand shrink-0" />
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none text-xs whitespace-nowrap">
        {currentPath.split("/").map((part, i, arr) => (
          <React.Fragment key={i}>
            {part === "" && i === 0 ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigateTo("/");
                }}
                className="hover:text-accent-brand transition-colors"
              >
                {t("fileManager.root")}
              </button>
            ) : part !== "" ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigateTo(arr.slice(0, i + 1).join("/") || "/");
                }}
                className="hover:text-accent-brand transition-colors"
              >
                {part}
              </button>
            ) : null}
            {i < arr.length - 1 && part !== "" && (
              <ChevronRight className="size-3 text-muted-foreground shrink-0" />
            )}
            {i === 0 && arr.length > 1 && part === "" && (
              <ChevronRight className="size-3 text-muted-foreground shrink-0" />
            )}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

function PathBar({
  currentPath,
  navigateTo,
  t,
  className,
}: Pick<FileManagerToolbarProps, "currentPath" | "navigateTo" | "t"> & {
  className: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(currentPath);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    doneRef.current = false;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, [isEditing]);

  const commit = (path: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setIsEditing(false);
    const trimmed = path.trim();
    if (trimmed && trimmed !== currentPath) {
      navigateTo(trimmed);
    }
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className={className}>
        <Folder className="size-3.5 text-accent-brand shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={() => commit(value)}
          className="flex-1 min-w-0 bg-transparent text-xs font-semibold tracking-wide outline-none text-foreground"
        />
      </div>
    );
  }

  return (
    <div
      className={`${className} cursor-text`}
      onClick={() => {
        setValue(currentPath);
        setIsEditing(true);
      }}
    >
      <Breadcrumb currentPath={currentPath} navigateTo={navigateTo} t={t} />
    </div>
  );
}

export function FileManagerToolbar({
  t,
  currentPath,
  navIndex,
  navHistoryLength,
  isLoading,
  sshSessionId,
  selectedFiles,
  searchQuery,
  setSearchQuery,
  viewMode,
  setViewMode,
  density,
  setDensity,
  sortBy,
  setSortBy,
  sortOrder,
  setSortOrder,
  setMobileSidebarOpen,
  goBack,
  goForward,
  goUp,
  navigateTo,
  handleRefreshDirectory,
  handleDeleteFiles,
  handleCopyFiles,
  handleFilesDropped,
  handleCreateNewFolder,
  handleCreateNewFile,
  showLocalPaneToggle = false,
  localPaneOpen = false,
  onToggleLocalPane,
  sidebarOpen = true,
  onToggleSidebar,
}: FileManagerToolbarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      )
        return;

      const input = searchInputRef.current;
      if (!input) return;
      const visible =
        typeof input.checkVisibility === "function"
          ? input.checkVisibility({ visibilityProperty: true })
          : input.offsetParent !== null;
      if (!visible) return;
      const active = document.activeElement;
      if (
        active !== input &&
        active?.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"]',
        )
      )
        return;

      event.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", handleSearchShortcut);
    return () => document.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
      <div className="flex w-full flex-row items-center gap-2">
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              // Below md the sidebar is an overlay; above it, a persisted
              // show/hide of the directories panel.
              const isDesktop =
                typeof window !== "undefined" &&
                window.matchMedia("(min-width: 768px)").matches;
              if (isDesktop && onToggleSidebar) onToggleSidebar();
              else setMobileSidebarOpen((open) => !open);
            }}
            className={
              sidebarOpen ? "" : "md:bg-accent-brand/10 md:text-accent-brand"
            }
            title={t("fileManager.toggleSidebar")}
            aria-pressed={!sidebarOpen}
          >
            <Layout className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={goBack}
            disabled={navIndex <= 0}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={goForward}
            disabled={navIndex >= navHistoryLength - 1}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={goUp}
            disabled={currentPath === "/"}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleRefreshDirectory}>
            <RefreshCw
              className={`size-4 ${isLoading && !!sshSessionId ? "animate-spin [animation-duration:0.5s]" : ""}`}
            />
          </Button>
        </div>

        <PathBar
          currentPath={currentPath}
          navigateTo={navigateTo}
          t={t}
          className="hidden h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden border border-border px-2.5 md:flex"
        />

        <div className="flex shrink-0 items-center gap-2">
          {selectedFiles.length > 0 && (
            <div className="flex items-center gap-1 border border-accent-brand/30 bg-accent-brand/10 pl-2 pr-1">
              <span className="text-[10px] tabular-nums text-accent-brand">
                {selectedFiles.length}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                title={t("fileManager.delete")}
                className="text-accent-brand hover:bg-accent-brand/20"
                onClick={() => handleDeleteFiles(selectedFiles)}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={t("fileManager.copy")}
                className="text-accent-brand hover:bg-accent-brand/20"
                onClick={() => handleCopyFiles(selectedFiles)}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          )}

          <PanelSearch
            inputRef={searchInputRef}
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t("fileManager.searchFiles")}
            className="w-28 md:w-44"
          />

          {showLocalPaneToggle && (
            <Button
              variant="outline"
              size="icon"
              onClick={onToggleLocalPane}
              title={
                localPaneOpen
                  ? t("fileManager.hideLocalFiles")
                  : t("fileManager.showLocalFiles")
              }
              aria-pressed={localPaneOpen}
              className={`hidden md:inline-flex ${localPaneOpen ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand hover:text-accent-brand dark:border-accent-brand/40 dark:bg-accent-brand/10" : ""}`}
            >
              <Laptop className="size-4" />
            </Button>
          )}

          <ViewToggle
            view={viewMode}
            onView={setViewMode}
            density={density}
            onDensity={setDensity}
          />

          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files) handleFilesDropped(files);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            onClick={() => uploadInputRef.current?.click()}
            className="hidden md:flex"
            title={t("fileManager.upload")}
          >
            <Upload className="size-3.5" />
            {t("fileManager.upload")}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand dark:border-accent-brand/40"
              >
                <Plus className="size-3.5" />
                {t("fileManager.new")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44 bg-card"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <DropdownMenuItem
                onSelect={() => {
                  setTimeout(() => handleCreateNewFolder(), 0);
                }}
                className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
              >
                <FolderPlus className="size-4 text-accent-brand" />
                {t("fileManager.newFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setTimeout(() => handleCreateNewFile(), 0);
                }}
                className="gap-2 focus:bg-accent-brand/10 focus:text-accent-brand"
              >
                <FilePlus className="size-4 text-muted-foreground" />
                {t("fileManager.newFile")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="py-1 text-[10px] uppercase tracking-widest text-muted-foreground/70">
                {t("fileManager.sortBy")}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortBy}
                onValueChange={(value) => setSortBy(value as SortBy)}
              >
                <DropdownMenuRadioItem value="name">
                  {t("fileManager.sortByName")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="modified">
                  {t("fileManager.sortByDate")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="size">
                  {t("fileManager.sortBySize")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={sortOrder}
                onValueChange={(value) => setSortOrder(value as SortOrder)}
              >
                <DropdownMenuRadioItem value="asc">
                  {t("fileManager.ascending")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="desc">
                  {t("fileManager.descending")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-2 md:hidden">
        <PathBar
          currentPath={currentPath}
          navigateTo={navigateTo}
          t={t}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 overflow-hidden border border-border px-2.5"
        />
      </div>
    </div>
  );
}
