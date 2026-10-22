import { describe, expect, it } from "vitest";
import { trashInBatches } from "../../src/frontend/file-manager-utils";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const ok = (batch: unknown[]) => batch.map(() => ({}));

describe("trashInBatches", () => {
  it("batches, caps batches in flight and reports progress", async () => {
    let running = 0;
    let peak = 0;
    const sizes: number[] = [];
    const progress: number[] = [];
    const items = Array.from({ length: 1050 }, (_, i) => i);
    const { done, thrown } = await trashInBatches(
      items,
      200,
      3,
      async (batch) => {
        peak = Math.max(peak, ++running);
        sizes.push(batch.length);
        await tick();
        running--;
        return ok(batch);
      },
      { onProgress: (n) => progress.push(n) },
    );
    expect(thrown).toBeUndefined();
    expect(done.size).toBe(1050);
    expect(sizes.sort((a, b) => a - b)).toEqual([50, 200, 200, 200, 200, 200]);
    expect(peak).toBe(3);
    expect(Math.max(...progress)).toBe(1050);
  });

  it("keeps going past a failed item and reports exactly the failed ones", async () => {
    const { done, itemError, thrown } = await trashInBatches(
      [1, 2, 3, 4],
      2,
      1,
      async (batch) => batch.map((i) => (i === 2 ? { error: "nope" } : {})),
    );
    expect(thrown).toBeUndefined();
    expect(itemError).toBe("nope");
    expect([...done].sort()).toEqual([1, 3, 4]);
  });

  it("separates failed items from items never started when cancelled", async () => {
    const controller = new AbortController();
    const { done, failed } = await trashInBatches(
      [1, 2, 3, 4, 5, 6],
      2,
      1,
      async (batch) => {
        controller.abort();
        return batch.map((i) => (i === 2 ? { error: "nope" } : {}));
      },
      { signal: controller.signal },
    );
    expect([...done]).toEqual([1]);
    expect([...failed]).toEqual([2]);
    // 3..6 were never started: neither done nor failed, so they go back to the list.
  });

  it("reports only confirmed items per batch as each one returns", async () => {
    const seen: number[][] = [];
    await trashInBatches(
      [1, 2, 3, 4],
      2,
      1,
      async (batch) => batch.map((i) => (i === 2 ? { error: "nope" } : {})),
      { onBatchDone: (trashed) => seen.push(trashed) },
    );
    expect(seen).toEqual([[1], [3, 4]]);
  });

  it("starts no new batch after one throws", async () => {
    const started: number[][] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);
    const { done, thrown } = await trashInBatches(
      items,
      5,
      1,
      async (batch) => {
        started.push(batch);
        if (batch[0] === 5) throw new Error("boom");
        return ok(batch);
      },
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(started).toHaveLength(2);
    expect([...done]).toEqual([0, 1, 2, 3, 4]);
  });

  it("starts no new batch once aborted", async () => {
    const controller = new AbortController();
    const started: number[][] = [];
    const { done } = await trashInBatches(
      Array.from({ length: 20 }, (_, i) => i),
      5,
      1,
      async (batch) => {
        started.push(batch);
        controller.abort();
        return ok(batch);
      },
      { signal: controller.signal },
    );
    expect(started).toHaveLength(1);
    expect(done.size).toBe(5);
  });

  it("handles an empty list", async () => {
    const { done } = await trashInBatches([], 5, 3, async () => {
      throw new Error("never");
    });
    expect(done.size).toBe(0);
  });
});
