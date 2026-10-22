import { describe, expect, it } from "vitest";
import { waitForDeletes } from "../../src/frontend/file-manager-utils";

/** Mirrors how handleDeleteFiles chains a delete onto the shared barrier. */
function startDelete(ref: { current: Promise<unknown> }) {
  let release!: () => void;
  ref.current = Promise.all([
    ref.current,
    new Promise<void>((resolve) => (release = resolve)),
  ]);
  return release;
}

describe("waitForDeletes", () => {
  it("resolves immediately when nothing is deleting", async () => {
    await expect(
      waitForDeletes({ current: Promise.resolve() }),
    ).resolves.toBeUndefined();
  });

  it("stays closed until the longer of two overlapping deletes finishes", async () => {
    const ref = { current: Promise.resolve() as Promise<unknown> };
    const releaseLong = startDelete(ref);
    const releaseShort = startDelete(ref);
    let open = false;
    void waitForDeletes(ref).then(() => (open = true));
    releaseShort();
    await new Promise((r) => setTimeout(r, 5));
    expect(open).toBe(false);
    releaseLong();
    await new Promise((r) => setTimeout(r, 5));
    expect(open).toBe(true);
  });

  it("also waits for a delete that starts while it is already waiting", async () => {
    const ref = { current: Promise.resolve() as Promise<unknown> };
    const releaseA = startDelete(ref);
    let open = false;
    void waitForDeletes(ref).then(() => (open = true));
    const releaseB = startDelete(ref);
    releaseA();
    await new Promise((r) => setTimeout(r, 5));
    expect(open).toBe(false);
    releaseB();
    await new Promise((r) => setTimeout(r, 5));
    expect(open).toBe(true);
  });
});
