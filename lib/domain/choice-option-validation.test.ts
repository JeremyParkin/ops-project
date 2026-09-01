import { describe, expect, it } from "vitest";
import { validateChoiceOptionFormData } from "./choice-option-validation";

function formData(entries: Record<string, string>) {
  const data = new FormData();
  Object.entries(entries).forEach(([key, value]) => data.set(key, value));
  return data;
}

describe("validateChoiceOptionFormData", () => {
  it("accepts a label with no color", () => {
    const result = validateChoiceOptionFormData(formData({ optionLabel: "High" }));

    expect(result).toEqual({ success: true, values: { label: "High", color: undefined } });
  });

  it("trims the label and accepts a valid color", () => {
    const result = validateChoiceOptionFormData(
      formData({ optionLabel: "  High  ", optionColor: "amber" }),
    );

    expect(result).toEqual({ success: true, values: { label: "High", color: "amber" } });
  });

  it("rejects an empty label", () => {
    const result = validateChoiceOptionFormData(formData({ optionLabel: "   " }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.optionLabel).toBeTruthy();
    }
  });

  it("rejects a color outside the fixed palette", () => {
    const result = validateChoiceOptionFormData(
      formData({ optionLabel: "High", optionColor: "not-a-real-color" }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.optionColor).toBeTruthy();
    }
  });
});
