import { describe, expect, it } from "vitest";
import {
  needsUsername,
  setAskedUsername,
  usernameFor,
} from "../../../src/frontend/lib/ask-username";

describe("ask for username", () => {
  it("swaps $ask for the typed name per session only", () => {
    expect(needsUsername("5", "$ask")).toBe(true);
    expect(needsUsername("5", "root")).toBe(false);
    setAskedUsername("5", "site1");
    expect(needsUsername("5", "$ask")).toBe(false);
    expect(usernameFor("5", "$ask")).toBe("site1");
    expect(usernameFor("6", "$ask")).toBe("$ask");
    expect(usernameFor("5", "root")).toBe("root");
  });
});
