import { describe, expect, it } from "vitest";
import { contentDisposition } from "../../src/backend/download-routes.js";

describe("contentDisposition", () => {
  it("sends the UTF-8 name with an ASCII fallback", () => {
    expect(contentDisposition("中文.txt")).toBe(
      "attachment; filename=\"__.txt\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.txt",
    );
  });

  it("keeps quotes out of the plain name", () => {
    expect(contentDisposition('it\'s "a".txt')).toBe(
      "attachment; filename=\"it's _a_.txt\"; filename*=UTF-8''it%27s%20%22a%22.txt",
    );
  });
});
