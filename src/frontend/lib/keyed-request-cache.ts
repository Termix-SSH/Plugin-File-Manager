export interface KeyedRequestCache<T> {
  get(
    key: string,
    loader: () => Promise<T>,
    options?: { force?: boolean },
  ): Promise<T>;
  peek(key: string, maxAgeMs?: number): T | null;
  set(key: string, value: T): void;
  invalidate(key?: string): void;
  invalidateMatching(matches: (key: string) => boolean): void;
}

/** Bounded per-key cache with in-flight request coalescing. */
export function createKeyedRequestCache<T>(
  ttlMs: number,
  maxEntries = 100,
): KeyedRequestCache<T> {
  const values = new Map<string, { value: T; storedAt: number }>();
  const inflight = new Map<string, { promise: Promise<T>; forced: boolean }>();

  const store = (key: string, value: T) => {
    values.delete(key);
    values.set(key, { value, storedAt: Date.now() });
    while (values.size > Math.max(1, maxEntries)) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) break;
      values.delete(oldest);
    }
  };

  return {
    get(key, loader, options = {}) {
      const cached = values.get(key);
      if (!options.force && cached && Date.now() - cached.storedAt < ttlMs) {
        return Promise.resolve(cached.value);
      }

      const pending = inflight.get(key);
      if (pending && (!options.force || pending.forced)) return pending.promise;

      // Only the request still registered for this key may write the cache, so
      // invalidate/set/forced replacement make older reads stale without metadata.
      const entry = {
        promise: undefined as unknown as Promise<T>,
        forced: !!options.force,
      };
      const request = loader()
        .then((value) => {
          if (inflight.get(key) === entry) store(key, value);
          return value;
        })
        .finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
        });
      entry.promise = request;
      inflight.set(key, entry);
      return request;
    },

    peek(key, maxAgeMs = Number.POSITIVE_INFINITY) {
      const cached = values.get(key);
      if (!cached || Date.now() - cached.storedAt > maxAgeMs) return null;
      values.delete(key);
      values.set(key, cached);
      return cached.value;
    },

    set(key, value) {
      inflight.delete(key);
      store(key, value);
    },

    invalidate(key) {
      if (key === undefined) {
        values.clear();
        inflight.clear();
      } else {
        values.delete(key);
        inflight.delete(key);
      }
    },

    invalidateMatching(matches) {
      for (const key of new Set([...values.keys(), ...inflight.keys()])) {
        if (!matches(key)) continue;
        values.delete(key);
        inflight.delete(key);
      }
    },
  };
}
