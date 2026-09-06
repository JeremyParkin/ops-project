import {
  CHOICE_OPTION_ARCHIVED_PILL_CLASSES,
  choiceOptionPillClasses,
} from "@/lib/domain/choice-colors";
import type { ChoiceOption } from "@/lib/domain/types";

export function ChoicePill({
  option,
  className = "",
}: {
  // Only label/color/archivedAt are ever read here, so any caller that has
  // just those three (e.g. a Result option resolved by a narrow read RPC,
  // not a full ChoiceOption row) can render a pill without fabricating the
  // rest of the shape.
  option: Pick<ChoiceOption, "label" | "color" | "archivedAt">;
  // Lets a clickable wrapper (see EditableTableCell) add its own
  // hover/focus affordance to the pill itself -- unused by the plain,
  // non-interactive rendering in entity-records-table.tsx.
  className?: string;
}) {
  const classes = option.archivedAt
    ? CHOICE_OPTION_ARCHIVED_PILL_CLASSES
    : choiceOptionPillClasses(option.color);

  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2.5 py-1 text-xs font-medium ${classes} ${className}`}
      title={option.archivedAt ? `${option.label} (Archived)` : option.label}
    >
      {option.label}
      {option.archivedAt ? <span className="sr-only"> (Archived)</span> : null}
    </span>
  );
}
