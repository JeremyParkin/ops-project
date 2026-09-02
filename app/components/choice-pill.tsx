import {
  CHOICE_OPTION_ARCHIVED_PILL_CLASSES,
  choiceOptionPillClasses,
} from "@/lib/domain/choice-colors";
import type { ChoiceOption } from "@/lib/domain/types";

export function ChoicePill({ option }: { option: ChoiceOption }) {
  const classes = option.archivedAt
    ? CHOICE_OPTION_ARCHIVED_PILL_CLASSES
    : choiceOptionPillClasses(option.color);

  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2.5 py-1 text-xs font-medium ${classes}`}
      title={option.archivedAt ? `${option.label} (Archived)` : option.label}
    >
      {option.label}
      {option.archivedAt ? <span className="sr-only"> (Archived)</span> : null}
    </span>
  );
}
