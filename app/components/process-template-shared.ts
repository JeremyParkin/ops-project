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
import { processConditionOperatorNeedsValue } from "@/lib/domain/process-conditions";

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
