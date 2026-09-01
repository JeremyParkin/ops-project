// Fixed, small color-key palette for Choice options. Kept in sync with the
// `field_choice_options.color` check constraint (migration 0080). Not a
// theming system: builders pick from these swatches, never a hex value, and
// the Tailwind classes below are a static, fully-enumerated map -- never
// constructed as `bg-${color}-100`, since a dynamically-built class name
// isn't guaranteed to survive Tailwind's build-time class extraction.
export const CHOICE_OPTION_COLORS = [
  "gray",
  "red",
  "amber",
  "emerald",
  "blue",
  "violet",
] as const;

export type ChoiceOptionColor = (typeof CHOICE_OPTION_COLORS)[number];

export function isChoiceOptionColor(value: unknown): value is ChoiceOptionColor {
  return (
    typeof value === "string" &&
    (CHOICE_OPTION_COLORS as readonly string[]).includes(value)
  );
}

export const CHOICE_OPTION_COLOR_LABELS: Record<ChoiceOptionColor, string> = {
  gray: "Gray",
  red: "Red",
  amber: "Amber",
  emerald: "Emerald",
  blue: "Blue",
  violet: "Violet",
};

// Same light-background/dark-text/matching-border pairing already used for
// the "Archived" badge elsewhere in this app (e.g. FieldEditForm's
// border-amber-300 bg-amber-50 text-amber-800), applied per color key.
export const CHOICE_OPTION_PILL_CLASSES: Record<ChoiceOptionColor, string> = {
  gray: "border-slate-300 bg-slate-50 text-slate-800",
  red: "border-red-300 bg-red-50 text-red-800",
  amber: "border-amber-300 bg-amber-50 text-amber-800",
  emerald: "border-emerald-300 bg-emerald-50 text-emerald-800",
  blue: "border-blue-300 bg-blue-50 text-blue-800",
  violet: "border-violet-300 bg-violet-50 text-violet-800",
};

export const CHOICE_OPTION_DEFAULT_PILL_CLASSES = CHOICE_OPTION_PILL_CLASSES.gray;

export function choiceOptionPillClasses(color: string | undefined | null): string {
  if (isChoiceOptionColor(color)) {
    return CHOICE_OPTION_PILL_CLASSES[color];
  }

  return CHOICE_OPTION_DEFAULT_PILL_CLASSES;
}

// A muted variant for a selected-but-archived option, so it stays legible
// as "this was picked" without pretending the option is still active.
export const CHOICE_OPTION_ARCHIVED_PILL_CLASSES =
  "border-slate-300 bg-slate-100 text-slate-500 line-through decoration-slate-400";
