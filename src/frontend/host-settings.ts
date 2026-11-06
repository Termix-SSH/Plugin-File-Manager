/** One of this plugin's host settings, from the host payload. */
export function fileManagerHostSetting<T>(
  host: object | null | undefined,
  key:
    | "enableFileManager"
    | "defaultPath"
    | "scpLegacy"
    | "showPanel"
    | "enableFtp"
    | "ftpPort"
    | "ftpSecure"
    | "ftpAllowSelfSigned",
  fallback: T,
): T {
  const settings = (
    host as { pluginSettings?: Record<string, Record<string, unknown>> } | null
  )?.pluginSettings;
  const value = settings?.["file-manager"]?.[key];
  return value === undefined || value === null || value === ""
    ? fallback
    : (value as T);
}

/** Whether files can be browsed on a host: it needs SSH and the plugin on. */
export function canBrowseFiles(host: object | null | undefined): boolean {
  return (
    !!host &&
    (host as { enableSsh?: boolean }).enableSsh !== false &&
    fileManagerHostSetting(host, "enableFileManager", true)
  );
}

/** Whether the host has FTP switched on. */
export function ftpEnabled(host: object | null | undefined): boolean {
  return fileManagerHostSetting<boolean>(host, "enableFtp", false) === true;
}

/** FTP is used when the host cannot be browsed over SFTP. */
export function usesFtp(host: object | null | undefined): boolean {
  return ftpEnabled(host) && !canBrowseFiles(host);
}

/** Whether the files tab can open the host, over SFTP or FTP. */
export function canOpenFiles(host: object | null | undefined): boolean {
  return canBrowseFiles(host) || ftpEnabled(host);
}
