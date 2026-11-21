import { describe, expect, it } from "vitest";
import { opensExternally } from "../../../src/frontend/lib/open-externally";

describe("opensExternally", () => {
  it("matches listed endings in any case and form", () => {
    expect(opensExternally("logo.PSD", "psd, .jpg")).toBe(true);
    expect(opensExternally("a.jpg", "*.jpg")).toBe(true);
    expect(opensExternally("notes.txt", "psd jpg")).toBe(false);
  });

  it("opens everything with * and nothing when empty", () => {
    expect(opensExternally("Makefile", "*")).toBe(true);
    expect(opensExternally("a.jpg", "")).toBe(false);
    expect(opensExternally(".bashrc", "bashrc")).toBe(false);
  });
});
