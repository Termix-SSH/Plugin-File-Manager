import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import type { FilesService } from "./service.js";

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

export function cleanPath(value: unknown): string {
  const path = String(value ?? "").trim();
  if (!path.startsWith("/"))
    throw new Error("Use a full path that starts with /");
  if (path.includes("\0")) throw new Error("The path is not valid");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** File actions that need no open session. */
export function registerOperations(
  ctx: PluginContext,
  files: FilesService,
): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("file-manager.list-files", {
    run: async (input, context) => {
      const path = cleanPath(input.path);
      const entries = await files.list(requireHost(context), path);
      return {
        summary: `${entries.length} items in ${path}`,
        data: {
          rows: entries.map((entry) => ({
            id: entry.name,
            name: entry.name,
            type: entry.type,
            size: entry.size ?? "",
          })),
        },
      };
    },
  });

  ctx.operations.register("file-manager.path-info", {
    run: async (input, context) => {
      const path = cleanPath(input.path);
      const stats = await files.stat(requireHost(context), path);
      const kind = stats.isDirectory ? "folder" : "file";
      return {
        summary: `${path} is a ${kind} of ${stats.size} bytes`,
        data: {
          ...stats,
          value: stats.size,
          status: "ok",
          label: kind,
          modified: new Date(stats.mtime * 1000).toISOString(),
        },
      };
    },
  });

  ctx.operations.register("file-manager.make-folder", {
    describe: (input) => `Would make the folder ${cleanPath(input.path)}`,
    run: async (input, context) => {
      const path = cleanPath(input.path);
      const hostId = requireHost(context);
      const existing = await files.stat(hostId, path).catch(() => null);
      if (existing?.isDirectory) return { summary: `${path} already exists` };
      await files.mkdir(hostId, path);
      return { summary: `Made ${path}`, changed: true };
    },
  });

  ctx.operations.register("file-manager.delete-path", {
    describe: (input) => `Would delete ${cleanPath(input.path)}`,
    run: async (input, context) => {
      const path = cleanPath(input.path);
      if (path === "/") throw new Error("Will not delete /");
      await files.delete(requireHost(context), path);
      return { summary: `Deleted ${path}`, changed: true };
    },
  });
}
