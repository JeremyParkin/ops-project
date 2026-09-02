// Fixed, small color-key palette for Choice options. Kept in sync with the
// `field_choice_options.color` check constraint (migration 0080, widened to
// this full 12-key set by migration 0084). Not a theming system: builders
// pick from these swatches, never a hex value, and the Tailwind classes
// below are a static, fully-enumerated map -- never constructed as
// `bg-${color}-100`, since a dynamically-built class name isn't guaranteed
// to survive Tailwind's build-time class extraction.
export const CHOICE_OPTION_COLORS = [
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
] as const;

export type ChoiceOptionColor = (typeof CHOICE_OPTION_COLORS)[number];

export function isChoiceOptionColor(value: unknown): value is ChoiceOptionColor {
  return (
    typeof value === "string" &&
    (CHOICE_OPTION_COLORS as readonly string[]).includes(value)
  );
}

// Literal color names, not product metaphors -- builders are picking a
// visual key, not a meaning.
export const CHOICE_OPTION_COLOR_LABELS: Record<ChoiceOptionColor, string> = {
  gray: "Gray",
  red: "Red",
  amber: "Amber",
  emerald: "Emerald",
  blue: "Blue",
  violet: "Violet",
  orange: "Orange",
  teal: "Teal",
  cyan: "Cyan",
  indigo: "Indigo",
  rose: "Rose",
  lime: "Lime",
};

// Stronger tint than the app's other light-background badges (e.g.
// FieldEditForm's border-amber-300 bg-amber-50 text-amber-800): a Choice
// pill is the record's own data, shown at high repetition down a table
// column, so it needs to read as a deliberate color chip rather than a
// muted status badge. -100/-400/-900 keeps every pair comfortably past
// WCAG AA (verified per color, not assumed from the shade numbers alone).
export const CHOICE_OPTION_PILL_CLASSES: Record<ChoiceOptionColor, string> = {
  gray: "border-slate-400 bg-slate-100 text-slate-900",
  red: "border-red-400 bg-red-100 text-red-900",
  amber: "border-amber-400 bg-amber-100 text-amber-900",
  emerald: "border-emerald-400 bg-emerald-100 text-emerald-900",
  blue: "border-blue-400 bg-blue-100 text-blue-900",
  violet: "border-violet-400 bg-violet-100 text-violet-900",
  orange: "border-orange-400 bg-orange-100 text-orange-900",
  teal: "border-teal-400 bg-teal-100 text-teal-900",
  cyan: "border-cyan-400 bg-cyan-100 text-cyan-900",
  indigo: "border-indigo-400 bg-indigo-100 text-indigo-900",
  rose: "border-rose-400 bg-rose-100 text-rose-900",
  lime: "border-lime-400 bg-lime-100 text-lime-900",
};

export const CHOICE_OPTION_DEFAULT_PILL_CLASSES = CHOICE_OPTION_PILL_CLASSES.gray;

// A solid, higher-saturation chip for the option-management swatch picker
// (see choice-option-management.tsx) -- deliberately more saturated than
// the pale pill tint above, since a config-time swatch needs to read as a
// distinct color choice at a glance, not blend into the same restrained
// pill look it's configuring.
export const CHOICE_OPTION_SWATCH_CLASSES: Record<ChoiceOptionColor, string> = {
  gray: "border-slate-600 bg-slate-400",
  red: "border-red-600 bg-red-400",
  amber: "border-amber-600 bg-amber-400",
  emerald: "border-emerald-600 bg-emerald-400",
  blue: "border-blue-600 bg-blue-400",
  violet: "border-violet-600 bg-violet-400",
  orange: "border-orange-600 bg-orange-400",
  teal: "border-teal-600 bg-teal-400",
  cyan: "border-cyan-600 bg-cyan-400",
  indigo: "border-indigo-600 bg-indigo-400",
  rose: "border-rose-600 bg-rose-400",
  lime: "border-lime-600 bg-lime-400",
};

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
