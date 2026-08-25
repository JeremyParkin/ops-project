import type {
  ProcessBranchCondition,
  ProcessBranchConditionOperator,
  ProcessNodeType,
} from "@/lib/domain/process-types";
import type {
  ProcessTemplateRouteFormValue,
} from "@/lib/domain/process-validation";
import type { EntityType, FieldDefinition } from "@/lib/domain/types";
import type { RelationRecordOption } from "@/lib/domain/record-repository";
import {
  getProcessConditionDefaultOperator,
  processConditionOperatorNeedsValue,
} from "@/lib/domain/process-conditions";

export type ProcessTemplateEntityContext = {
  entityType: EntityType;
  fields: FieldDefinition[];
  relationOptionsByFieldId: Record<string, RelationRecordOption[]>;
};

export type LocalCondition = {
  id: string;
  sourceFieldDefinitionId: string;
  operator: ProcessBranchConditionOperator;
  value: string;
};

export type LocalRoute = {
  id: string;
  targetStepKey: string;
  isDefault: boolean;
  isParallel: boolean;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
  conditions: LocalCondition[];
};

export type LocalStep = {
  key: string;
  nodeId: string;
  nodeType: ProcessNodeType;
  parallelGroupId: string;
  name: string;
  assigneeUserId: string;
  dueAmount: string;
  dueUnit: "hours" | "days";
  waitKind: "duration" | "weekdays" | "calendar_target";
  waitAmount: string;
  waitUnit: "hours" | "calendar_days";
  waitTarget: "nth_weekday_next_month" | "first_day_of_week_next_month" | "specific_datetime";
  waitOrdinal: string;
  waitWeekday: string;
  waitDate: string;
  waitTime: string;
  waitTimeZone: string;
  conditionWaitTargetKind?: "origin" | "related";
  conditionWaitRelationFieldDefinitionId?: string;
  conditionWaitTargetEntityTypeId?: string;
  conditionWaitConditions?: LocalCondition[];
  routes: LocalRoute[];
};

export function createKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createParallelGroupId() {
  return crypto.randomUUID();
}

export function waitDefaults() {
  return {
    waitKind: "duration" as const,
    waitAmount: "",
    waitUnit: "hours" as const,
    waitTarget: "nth_weekday_next_month" as const,
    waitOrdinal: "1",
    waitWeekday: "1",
    waitDate: "",
    waitTime: "09:00",
    waitTimeZone: "America/Toronto",
  };
}

export function conditionWaitDefaults() {
  return {
    conditionWaitTargetKind: "origin" as const,
    conditionWaitRelationFieldDefinitionId: "",
    conditionWaitTargetEntityTypeId: "",
    conditionWaitConditions: [] as LocalCondition[],
  };
}

export function toLocalCondition(condition: ProcessBranchCondition, index: number): LocalCondition {
  return {
    id: `condition-${index}-${condition.sourceFieldDefinitionId}`,
    sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
    operator: condition.operator,
    value:
      condition.value === null || condition.value === undefined ? "" : String(condition.value),
  };
}

export function toLocalRoute(route: ProcessTemplateRouteFormValue, index: number): LocalRoute {
  return {
    id: route.id || `route-${index}`,
    targetStepKey: route.targetStepKey,
    isDefault: route.isDefault,
    isParallel: route.isParallel === true,
    approvalOutcomeId: route.approvalOutcomeId ?? "",
    approvalOutcomeLabel: route.approvalOutcomeLabel ?? "",
    conditions: route.conditions.map(toLocalCondition),
  };
}

export function serializeCondition(
  condition: LocalCondition,
  fields: FieldDefinition[],
): ProcessBranchCondition {
  const field = fields.find((candidate) => candidate.id === condition.sourceFieldDefinitionId);
  const needsValue = processConditionOperatorNeedsValue(condition.operator);

  if (!needsValue) {
    return {
      sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
      operator: condition.operator,
    };
  }

  let value: string | number | boolean = condition.value;

  if (field?.type === "number") {
    value = Number(condition.value);
  } else if (field?.type === "boolean") {
    value = condition.value === "true";
  }

  return {
    sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
    operator: condition.operator,
    value,
  };
}

// Node types that insert-on-edge can splice in directly. Split/join always
// come from the dedicated "+ Add parallel paths" control, since a region has
// structural invariants (matched group id, non-nesting) a single splice
// can't safely express.
export type InsertableNodeType = "human_task" | "approval" | "wait" | "condition_wait";

export function createDefaultStep(
  nodeType: InsertableNodeType,
  key: string,
  activeFields: FieldDefinition[],
): LocalStep {
  const step: LocalStep = {
    key,
    nodeId: "",
    nodeType,
    parallelGroupId: "",
    name:
      nodeType === "approval"
        ? "Approval"
        : nodeType === "wait"
          ? "Wait"
          : nodeType === "condition_wait"
            ? "Wait for condition"
            : "",
    assigneeUserId: "",
    dueAmount: "",
    dueUnit: "days",
    ...waitDefaults(),
    ...conditionWaitDefaults(),
    routes: [],
  };

  if (nodeType === "wait") {
    step.waitAmount = "1";
  }

  if (nodeType === "condition_wait") {
    const field = activeFields[0];
    step.conditionWaitConditions = field
      ? [
          {
            id: createKey("condition"),
            sourceFieldDefinitionId: field.id,
            operator: getProcessConditionDefaultOperator(field),
            value: "",
          },
        ]
      : [];
  }

  return step;
}

// Adjacent-swap safety: swapping the steps at `index` and its up/down
// neighbor is only unsafe when the step currently at the lower of the two
// positions has a route that directly targets the step at the higher
// position — swapping would put that route's target before its source.
// Every other route stays valid by construction (see 6B plan for the proof:
// any route from a third step is unaffected, and any route from the moving
// step to a third step already satisfied source < target and that third
// step's own index doesn't change).
export function canSwapAdjacent(
  steps: LocalStep[],
  index: number,
  direction: "up" | "down",
): { allowed: true } | { allowed: false; reason: string } {
  const swapWith = direction === "up" ? index - 1 : index + 1;

  if (index < 0 || swapWith < 0 || swapWith >= steps.length) {
    return { allowed: false, reason: "" };
  }

  const lowerIndex = Math.min(index, swapWith);
  const higherIndex = Math.max(index, swapWith);
  const lower = steps[lowerIndex];
  const higher = steps[higherIndex];
  const breakingRoute = lower.routes.find((route) => route.targetStepKey === higher.key);

  if (breakingRoute) {
    return {
      allowed: false,
      reason: `Can't reorder: "${lower.name || "This step"}" routes directly to "${higher.name || "the next step"}".`,
    };
  }

  return { allowed: true };
}
