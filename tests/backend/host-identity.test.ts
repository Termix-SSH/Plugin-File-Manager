import { describe, expect, it } from "vitest";
import {
  HostLoginRequiredError,
  HostNotOnThisServerError,
} from "../../src/backend/host-identity.js";

describe("HostLoginRequiredError", () => {
  it("is refused like an unknown host but says a login is needed", () => {
    const error = new HostLoginRequiredError();
    // Callers rethrow HostNotOnThisServerError, so this one must pass too.
    expect(error).toBeInstanceOf(HostNotOnThisServerError);
    expect(error.name).toBe("HostLoginRequiredError");
    expect(error.message).toContain("no login for this shared host");
  });
});
