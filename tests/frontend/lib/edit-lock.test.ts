import { afterEach, describe, expect, it } from "vitest";
import {
  isEditLocked,
  setEditLocked,
} from "../../../src/frontend/lib/edit-lock";

describe("edit lock", () => {
  afterEach(() => localStorage.clear());

  it("locks and unlocks one host at a time", () => {
    expect(isEditLocked(1)).toBe(false);
    setEditLocked(1, true);
    expect(isEditLocked(1)).toBe(true);
    expect(isEditLocked(2)).toBe(false);
    setEditLocked(1, false);
    expect(isEditLocked(1)).toBe(false);
  });

  it("never locks without a host", () => {
    setEditLocked(null, true);
    expect(isEditLocked(null)).toBe(false);
  });
});
