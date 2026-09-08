import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "./user-preferences-types";

describe("user preference defaults", () => {
  it("uses system theme and browser-local display time by default", () => {
    expect(DEFAULT_USER_PREFERENCES).toEqual({
      theme: "system",
      timezone: null,
      notifyCommentMentions: true,
      notifyInputRequestStatusUpdates: true,
    });
  });
});
