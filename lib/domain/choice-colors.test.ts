import { describe, expect, it } from "vitest";
import {
  CHOICE_OPTION_ARCHIVED_PILL_CLASSES,
  CHOICE_OPTION_COLOR_LABELS,
  CHOICE_OPTION_COLORS,
  CHOICE_OPTION_DEFAULT_PILL_CLASSES,
  CHOICE_OPTION_PILL_CLASSES,
  CHOICE_OPTION_SWATCH_CLASSES,
  choiceOptionPillClasses,
  isChoiceOptionColor,
} from "./choice-colors";

describe("CHOICE_OPTION_COLORS", () => {
  it("is the full 12-key fixed palette, in the approved order", () => {
    expect(CHOICE_OPTION_COLORS).toEqual([
      "gray",
      "red",
      "amber",
      "emerald",
      "blue",
      "violet",
      "orange",
      "teal",
      "cyan",
      "indigo",
      "rose",
      "lime",
    ]);
  });

  it("gives every color a literal (non-metaphor) label, a pill class string, and a swatch class string", () => {
    // "gray" is the one color key whose Tailwind class family is "slate",
    // not "gray" -- matching the cool-toned neutrals (grit/stone/graphite)
    // already used everywhere else in this app, rather than Tailwind's own
    // warmer "gray" palette. Every other key's Tailwind class family
    // matches its color-key name directly.
    CHOICE_OPTION_COLORS.forEach((color) => {
      const tailwindFamily = color === "gray" ? "slate" : color;

      expect(CHOICE_OPTION_COLOR_LABELS[color]).toBe(
        color.charAt(0).toUpperCase() + color.slice(1),
      );
      expect(CHOICE_OPTION_PILL_CLASSES[color]).toMatch(
        new RegExp(`border-${tailwindFamily}-400.*bg-${tailwindFamily}-100.*text-${tailwindFamily}-900`),
      );
      expect(CHOICE_OPTION_SWATCH_CLASSES[color]).toMatch(
        new RegExp(`border-${tailwindFamily}-600.*bg-${tailwindFamily}-400`),
      );
    });
  });
});

describe("isChoiceOptionColor", () => {
  it("accepts every palette color", () => {
    CHOICE_OPTION_COLORS.forEach((color) => {
      expect(isChoiceOptionColor(color)).toBe(true);
    });
  });

  it("rejects a color outside the fixed palette, and non-string values", () => {
    expect(isChoiceOptionColor("magenta")).toBe(false);
    expect(isChoiceOptionColor(undefined)).toBe(false);
    expect(isChoiceOptionColor(null)).toBe(false);
    expect(isChoiceOptionColor(42)).toBe(false);
  });
});

describe("choiceOptionPillClasses", () => {
  it("resolves each of the 12 colors to its own distinct class string", () => {
    const resolved = CHOICE_OPTION_COLORS.map((color) => choiceOptionPillClasses(color));
    expect(new Set(resolved).size).toBe(CHOICE_OPTION_COLORS.length);
  });

  it("falls back to the default (gray) classes for null, undefined, or an unknown color", () => {
    expect(choiceOptionPillClasses(null)).toBe(CHOICE_OPTION_DEFAULT_PILL_CLASSES);
    expect(choiceOptionPillClasses(undefined)).toBe(CHOICE_OPTION_DEFAULT_PILL_CLASSES);
    expect(choiceOptionPillClasses("not-a-real-color")).toBe(CHOICE_OPTION_DEFAULT_PILL_CLASSES);
  });
});

describe("CHOICE_OPTION_ARCHIVED_PILL_CLASSES", () => {
  it("stays a distinct, muted, non-color-keyed treatment", () => {
    expect(CHOICE_OPTION_ARCHIVED_PILL_CLASSES).toContain("line-through");
    CHOICE_OPTION_COLORS.forEach((color) => {
      expect(CHOICE_OPTION_ARCHIVED_PILL_CLASSES).not.toBe(CHOICE_OPTION_PILL_CLASSES[color]);
    });
  });
});
