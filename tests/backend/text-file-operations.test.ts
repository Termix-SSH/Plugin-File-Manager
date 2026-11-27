import { describe, expect, it, vi } from "vitest";
import type {
  PluginContext,
  PluginOperationContext,
  PluginOperationHandler,
} from "@termix-ssh/plugin-sdk/backend";
import { registerOperations } from "../../src/backend/operations.js";
import type { FilesService } from "../../src/backend/service.js";

function setup(stat: { isDirectory: boolean; size: number }) {
  const handlers = new Map<string, PluginOperationHandler>();
  const files = {
    stat: vi.fn(async () => ({ ...stat, mtime: 0 })),
    read: vi.fn(async () => "hello"),
    write: vi.fn(async () => {}),
  };
  registerOperations(
    {
      operations: {
        register: (id: string, handler: PluginOperationHandler) =>
          handlers.set(id, handler),
      },
    } as unknown as PluginContext,
    files as unknown as FilesService,
  );
  const run = (id: string, input: Record<string, unknown>) =>
    handlers.get(id)!.run(input, { hostId: 1 } as PluginOperationContext);
  return { files, run };
}

describe("text file actions", () => {
  it("reads a small file", async () => {
    const { run } = setup({ isDirectory: false, size: 5 });
    expect(
      await run("file-manager.read-file", { path: "/etc/hosts" }),
    ).toMatchObject({ data: { content: "hello" } });
  });

  it("refuses a folder and a file too big for a model", async () => {
    const folder = setup({ isDirectory: true, size: 0 });
    await expect(
      folder.run("file-manager.read-file", { path: "/etc" }),
    ).rejects.toThrow("folder");
    const big = setup({ isDirectory: false, size: 300 * 1024 });
    await expect(
      big.run("file-manager.read-file", { path: "/var/log/syslog" }),
    ).rejects.toThrow("over");
    expect(big.files.read).not.toHaveBeenCalled();
  });

  it("writes text to a full path only", async () => {
    const { files, run } = setup({ isDirectory: false, size: 0 });
    expect(
      await run("file-manager.write-file", { path: "/tmp/a", content: "x" }),
    ).toMatchObject({ changed: true });
    expect(files.write).toHaveBeenCalledWith(1, "/tmp/a", "x");
    await expect(
      run("file-manager.write-file", { path: "a", content: "x" }),
    ).rejects.toThrow();
  });
});
