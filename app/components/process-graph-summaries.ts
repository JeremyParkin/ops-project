import { processConditionOperatorLabels } from "@/lib/domain/process-conditions";
import type { ProcessNodeType } from "@/lib/domain/process-types";
import type { FieldDefinition } from "@/lib/domain/types";
import type { LocalCondition, LocalRoute, LocalStep } from "./process-template-shared";

export const NODE_TYPE_LABELS: Record<ProcessNodeType, string> = {
  human_task: "Human task",
  approval: "Approval",
  wait: "Wait",
  condition_wait: "Wait for condition",
  external_event_wait: "Wait for external event",
  action: "Action",
  parallel_split: "Parallel paths",
  parallel_join: "Join parallel paths",
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinalWord(value: number) {
  const suffixes: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : suffixes[value % 10] ?? "th";

  return `${value}${suffix}`;
}

export function summarizeExternalEventWait(): string {
  return "Waiting for external event";
}

export function summarizeWaitRule(step: LocalStep): string {
  if (step.waitKind === "duration") {
    const unit = step.waitUnit === "calendar_days" ? "calendar day" : "hour";
    const amount = step.waitAmount || "0";

    return `Wait ${amount} ${unit}${amount === "1" ? "" : "s"}`;
  }

  if (step.waitKind === "weekdays") {
    const amount = step.waitAmount || "0";

    return `Wait ${amount} weekday${amount === "1" ? "" : "s"}`;
  }

  if (step.waitTarget === "nth_weekday_next_month") {
    return `Wait until the ${ordinalWord(Number(step.waitOrdinal) || 1)} weekday of next month, ${step.waitTime}`;
  }

  if (step.waitTarget === "first_day_of_week_next_month") {
    const weekday = WEEKDAY_NAMES[Number(step.waitWeekday) || 0] ?? "Monday";

    return `Wait until the first ${weekday} of next month, ${step.waitTime}`;
  }

  return step.waitDate ? `Wait until ${step.waitDate} ${step.waitTime}` : "Wait until a specific date";
}

export function summarizeConditionWaitRule(step: LocalStep): string {
  const target = step.conditionWaitTargetKind === "related" ? "a related record" : "this process record";
  const count = (step.conditionWaitConditions ?? []).length;

  return `Watching ${target} · ${count} condition${count === 1 ? "" : "s"}`;
}

export function summarizeCondition(condition: LocalCondition, fields: FieldDefinition[]): string {
  const field = fields.find((candidate) => candidate.id === condition.sourceFieldDefinitionId);
  const fieldLabel = field?.name ?? "field";
  const operatorLabel = processConditionOperatorLabels[condition.operator] ?? condition.operator;

  if (condition.operator === "is_set" || condition.operator === "is_not_set") {
    return `${fieldLabel} ${operatorLabel}`;
  }

  return `${fieldLabel} ${operatorLabel} ${condition.value}`;
}

export function summarizeRouteLabel(
  route: LocalRoute,
  step: LocalStep,
  fields: FieldDefinition[],
): string | undefined {
  if (route.isParallel) {
    return undefined;
  }

  if (step.nodeType === "approval") {
    return route.approvalOutcomeLabel || "Outcome";
  }

  if (route.isDefault) {
    const hasConditionalSiblings = step.routes.some((candidate) => !candidate.isDefault);

    return hasConditionalSiblings ? "Otherwise" : undefined;
  }

  if (route.conditions.length === 0) {
    return undefined;
  }

  const [first, ...rest] = route.conditions.map((condition) => summarizeCondition(condition, fields));

  return rest.length > 0 ? `${first} +${rest.length} more` : first;
}
