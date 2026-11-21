import type { FileProtocol, RemoteProtocolId } from "./lib/file-protocol";

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
    | "ftpAllowSelfSigned"
    | "enableWebdav"
    | "enableSmb",
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

const ENABLE_KEY = {
  ftp: "enableFtp",
  webdav: "enableWebdav",
  smb: "enableSmb",
} as const;

/** The protocols other than SFTP switched on for a host, in a fixed order. */
export function remoteProtocols(
  host: object | null | undefined,
): RemoteProtocolId[] {
  return (Object.keys(ENABLE_KEY) as RemoteProtocolId[]).filter(
    (id) =>
      fileManagerHostSetting<boolean>(host, ENABLE_KEY[id], false) === true,
  );
}

/** Every way the files tab can open a host, SFTP first. */
export function availableProtocols(
  host: object | null | undefined,
): FileProtocol[] {
  return [
    ...(canBrowseFiles(host) ? (["sftp"] as const) : []),
    ...remoteProtocols(host),
  ];
}

/** The protocol to use: the picked one when it is still on, else the first. */
export function fileProtocol(
  host: object | null | undefined,
  preferred?: FileProtocol | null,
): FileProtocol | null {
  const available = availableProtocols(host);
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

/** A protocol other than SFTP is used for this host. */
export function usesFtp(
  host: object | null | undefined,
  preferred?: FileProtocol | null,
): boolean {
  const protocol = fileProtocol(host, preferred);
  return !!protocol && protocol !== "sftp";
}

/** Whether the files tab can open the host at all. */
export function canOpenFiles(host: object | null | undefined): boolean {
  return availableProtocols(host).length > 0;
}
