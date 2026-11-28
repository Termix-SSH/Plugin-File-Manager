import { getFileManagerApiForSession } from "./client";

export interface FileProperties {
  path: string;
  name: string;
  type: "file" | "directory" | "link";
  targetIsDirectory?: boolean;
  linkTarget?: string;
  size: number;
  /** Unix seconds. */
  modified: number;
  accessed: number;
  created?: number;
  permissions: string;
  octal: string;
  uid: number;
  gid: number;
  owner?: string;
  group?: string;
}

export async function getFileProperties(
  sessionId: string,
  path: string,
): Promise<FileProperties> {
  const res = await getFileManagerApiForSession(sessionId).post("/properties", {
    sessionId,
    path,
  });
  return res.data as FileProperties;
}

/** Folder path -> bytes; folders that could not be measured are missing. */
export async function getDirectorySizes(
  sessionId: string,
  paths: string[],
): Promise<Record<string, number>> {
  const res = await getFileManagerApiForSession(sessionId).post(
    "/dirSizes",
    { sessionId, paths },
    { timeout: 70000 },
  );
  return (res.data as { sizes: Record<string, number> }).sizes ?? {};
}
