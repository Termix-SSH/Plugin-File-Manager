import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

// Response bodies are typed at each call site's return type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

interface ClientResponse<T> {
  data: T;
  status: number;
  headers: Record<string, unknown>;
}

/** The plugin client is axios underneath; these are the parts used here. */
export interface FileManagerClient {
  get<T = Body>(url: string, config?: unknown): Promise<ClientResponse<T>>;
  delete<T = Body>(url: string, config?: unknown): Promise<ClientResponse<T>>;
  post<T = Body>(
    url: string,
    body?: unknown,
    config?: unknown,
  ): Promise<ClientResponse<T>>;
  put<T = Body>(
    url: string,
    body?: unknown,
    config?: unknown,
  ): Promise<ClientResponse<T>>;
  patch<T = Body>(
    url: string,
    body?: unknown,
    config?: unknown,
  ): Promise<ClientResponse<T>>;
  postForm<T = Body>(
    url: string,
    body?: unknown,
    config?: unknown,
  ): Promise<ClientResponse<T>>;
}

let current: TermixApp | null = null;

/** Set in activate, cleared on deactivate. */
export function setFileManagerApp(app: TermixApp | null): void {
  current = app;
}

function app(): TermixApp {
  if (!current) throw new Error("The file manager plugin is not active");
  return current;
}

export function fileManagerApp(): TermixApp {
  return app();
}

export function listHosts(): ReturnType<TermixApp["listHosts"]> {
  return app().listHosts();
}

export function fileManagerApi(): FileManagerClient {
  return app().api as unknown as FileManagerClient;
}

// A live SSH session (keyed by sessionId) remembers which backend holds it,
// so every later call for that session reaches the same server.
const sessionOrigins = new Map<string, "local" | "remote">();

export function setSessionOrigin(
  sessionId: string,
  origin: "local" | "remote",
): void {
  sessionOrigins.set(sessionId, origin);
}

export function clearSessionOrigin(sessionId: string): void {
  sessionOrigins.delete(sessionId);
  ftpSessions.delete(sessionId);
}

export function getSessionOrigin(sessionId: string): "local" | "remote" {
  return sessionOrigins.get(sessionId) === "remote" ? "remote" : "local";
}

// Sessions opened over FTP talk to the /ftp routes of the same plugin API.
const ftpSessions = new Set<string>();

export function setSessionFtp(sessionId: string, ftp: boolean): void {
  if (ftp) ftpSessions.add(sessionId);
  else ftpSessions.delete(sessionId);
}

export function isFtpSession(sessionId: string): boolean {
  return ftpSessions.has(sessionId);
}

function ftpClient(base: FileManagerClient): FileManagerClient {
  const at = (url: string) => `/ftp${url}`;
  return {
    get: (url, config) => base.get(at(url), config),
    delete: (url, config) => base.delete(at(url), config),
    post: (url, body, config) => base.post(at(url), body, config),
    put: (url, body, config) => base.put(at(url), body, config),
    patch: (url, body, config) => base.patch(at(url), body, config),
    postForm: (url, body, config) => base.postForm(at(url), body, config),
  };
}

export function getFileManagerApiForSession(
  sessionId: string,
): FileManagerClient {
  const base = app().apiFor(
    getSessionOrigin(sessionId),
  ) as unknown as FileManagerClient;
  return ftpSessions.has(sessionId) ? ftpClient(base) : base;
}

function fileManagerApiFor(
  origin: "local" | "remote" | undefined,
): FileManagerClient {
  return app().apiFor(origin ?? "local") as unknown as FileManagerClient;
}

class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface AxiosLikeError {
  message?: string;
  response?: {
    status?: number;
    data?: { message?: string; error?: string; code?: string };
  };
}

/** Turns an axios failure into an Error carrying the server's message. */
export function handleApiError(error: unknown, operation: string): never {
  const e = error as AxiosLikeError;
  if (e?.response) {
    const status = e.response.status;
    const data = e.response.data ?? {};
    const message =
      data.message || data.error || e.message || `Failed to ${operation}`;
    const apiError = new ApiError(message, status, data.code || data.error);
    (apiError as ApiError & { response?: unknown }).response = e.response;
    throw apiError;
  }
  if (error instanceof Error) throw error;
  throw new ApiError(`Failed to ${operation}`);
}
