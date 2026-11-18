import { describe, expect, it } from "vitest";
import { shortcutKey } from "../../../src/frontend/lib/shortcut-key";

describe("shortcutKey", () => {
  it("reads a non-Latin letter as the Latin one on the same key", () => {
    // Russian layout: Ctrl+S types "ы", Ctrl+Shift+T types "Е".
    expect(shortcutKey({ key: "ы", code: "KeyS" })).toBe("s");
    expect(shortcutKey({ key: "Е", code: "KeyT" })).toBe("t");
    expect(shortcutKey({ key: "α", code: "KeyA" })).toBe("a");
  });

  it("keeps Latin letters, so other Latin layouts mean what they type", () => {
    // Dvorak: the key labelled S sits where QWERTY has O.
    expect(shortcutKey({ key: "s", code: "KeyO" })).toBe("s");
    expect(shortcutKey({ key: "A", code: "KeyA" })).toBe("A");
  });

  it("leaves named keys and non-letter keys alone", () => {
    expect(shortcutKey({ key: "Escape", code: "Escape" })).toBe("Escape");
    expect(shortcutKey({ key: "F5", code: "F5" })).toBe("F5");
    expect(shortcutKey({ key: "ё", code: "Backquote" })).toBe("ё");
  });
});
