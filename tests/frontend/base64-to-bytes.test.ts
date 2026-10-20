import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../../src/frontend/file-manager-utils";

describe("base64ToBytes", () => {
  it.each([0, 1, 2, 3, 4, 100, 3 * 1024 * 1024 + 5])(
    "round-trips %i bytes across slice boundaries",
    (n) => {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7) % 256);
      const b64 = Buffer.from(bytes).toString("base64");
      expect(base64ToBytes(b64)).toEqual(bytes);
    },
    30_000,
  );
});
