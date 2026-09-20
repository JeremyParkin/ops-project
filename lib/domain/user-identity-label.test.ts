import { describe, expect, it } from "vitest";
import {
  deactivatedUserLabel,
  pickerUserLabel,
  primaryUserLabel,
} from "./user-identity-label";

describe("user identity labels", () => {
  it("prefers display name for ordinary display", () => {
    expect(primaryUserLabel({ displayName: "Jeremy Parkin", email: "djplana@gmail.com" })).toBe("Jeremy Parkin");
  });

  it("falls back to email when display name is blank or absent", () => {
    expect(primaryUserLabel({ displayName: "   ", email: "djplana@gmail.com" })).toBe("djplana@gmail.com");
    expect(primaryUserLabel({ email: "djplana@gmail.com" })).toBe("djplana@gmail.com");
  });

  it("includes email for picker disambiguation only when a display name exists", () => {
    expect(pickerUserLabel({ displayName: "Jeremy Parkin", email: "djplana@gmail.com" })).toBe("Jeremy Parkin — djplana@gmail.com");
    expect(pickerUserLabel({ displayName: null, email: "djplana@gmail.com" })).toBe("djplana@gmail.com");
  });

  it("formats deactivated references with the current primary label", () => {
    expect(deactivatedUserLabel({ displayName: "Jeremy Parkin", email: "djplana@gmail.com" })).toBe("Jeremy Parkin (Deactivated)");
    expect(deactivatedUserLabel({ displayName: null, email: "djplana@gmail.com" })).toBe("djplana@gmail.com (Deactivated)");
  });
});
