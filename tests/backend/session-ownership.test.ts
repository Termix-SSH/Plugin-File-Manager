import { describe, expect, it } from "vitest";
import { isSessionHeldByOther } from "../../src/backend/session.js";

describe("isSessionHeldByOther", () => {
  it("flags a live session owned by another user", () => {
    expect(isSessionHeldByOther({ userId: "a" }, undefined, "b")).toBe(true);
  });

  it("flags a login step another user is waiting on", () => {
    expect(isSessionHeldByOther(undefined, { userId: "a" }, "b")).toBe(true);
  });

  it("lets the owner reconnect", () => {
    expect(isSessionHeldByOther({ userId: "a" }, { userId: "a" }, "a")).toBe(
      false,
    );
    expect(isSessionHeldByOther(undefined, undefined, "a")).toBe(false);
  });
});
