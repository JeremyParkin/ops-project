import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  FieldValue,
  IsoUtcTimestamp,
} from "./types";

export type WorkflowTriggerType = "record_created" | "record_updated";
export type WorkflowActionType =
  | "create_record"
  | "update_record"
  | "update_related_record"
  | "start_process";
export type WorkflowExecutionStatus = "succeeded" | "failed" | "skipped";
export type WorkflowConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "before"
  | "after"
  | "is_set"
  | "is_not_set"
  | "changed"
  | "changed_from"
  | "changed_to"
  | "changed_from_to";

export type WorkflowCondition = {
  sourceFieldDefinitionId: FieldDefinition["id"];
  operator: WorkflowConditionOperator;
  // The current/next persisted value. Used by every non-transition operator,
  // and by changed_to / changed_from_to as the "to" comparison value.
  value?: FieldValue;
  // The previous persisted value, from the original user edit event.
  // Only meaningful for changed_from and changed_from_to (the "from" value).
  previousValue?: FieldValue;
};

export type WorkflowFieldMapping =
  | {
      targetFieldDefinitionId: FieldDefinition["id"];
      source: {
        type: "unset";
      };
    }
  | {
      targetFieldDefinitionId: FieldDefinition["id"];
      source: {
        type: "constant";
        value: FieldValue;
      };
    }
  | {
      targetFieldDefinitionId: FieldDefinition["id"];
      source: {
        type: "source_field";
        sourceFieldDefinitionId: FieldDefinition["id"];
      };
    }
  | {
      targetFieldDefinitionId: FieldDefinition["id"];
      source: {
        type: "template";
        template: string;
      };
    }
  | {
      targetFieldDefinitionId: FieldDefinition["id"];
      source: {
        type: "leave_unchanged";
      };
    }
  | {
      targetFieldDefinitionId: FieldDefinition["id"];
      source: {
        type: "clear";
      };
    };

export type WorkflowTriggerConfig = {
  watchedFieldDefinitionIds?: FieldDefinition["id"][];
};

// One step in a workflow's ordered action list. Everything here is
// action-specific: which kind of action, its target, and its field
// mappings. Eligibility (trigger config / conditions) lives on the
// workflow itself, evaluated once, not per action.
export type WorkflowAction = {
  actionType: WorkflowActionType;
  actionTargetEntityTypeId?: EntityType["id"];
  relatedFieldDefinitionId?: FieldDefinition["id"];
  processTemplateId?: string;
  fieldMappings: WorkflowFieldMapping[];
};

export type WorkflowDefinition = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  triggerType: WorkflowTriggerType;
  triggerEntityTypeId: EntityType["id"];
  triggerConfig?: WorkflowTriggerConfig;
  conditions?: WorkflowCondition[];
  // Ordered, at least one. Executed sequentially; the first action to fail
  // stops the rest for that workflow run.
  actions: WorkflowAction[];
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

// Outcome of one action within a workflow run. Only recorded for actions
// that actually began execution — never for actions skipped because an
// earlier action in the same run failed.
export type WorkflowActionResult = {
  index: number;
  actionType: WorkflowActionType;
  status: "succeeded" | "failed";
  actionEntityTypeId?: EntityType["id"];
  actionRecordId?: EntityRecord["id"];
  createdRecordId?: EntityRecord["id"];
  // Process-start actions retain their explicit process identifiers and
  // origin context without overloading the legacy record-action fields.
  processTemplateId?: string;
  processRunId?: string;
  originEntityTypeId?: EntityType["id"];
  originRecordId?: EntityRecord["id"];
  resultMessage?: string;
  errorMessage?: string;
};

export type WorkflowExecutionLog = {
  id: string;
  workspaceId: string;
  workflowId: string;
  triggerEntityTypeId: EntityType["id"];
  triggerRecordId: string;
  status: WorkflowExecutionStatus;
  errorMessage?: string;
  resultMessage?: string;
  // Legacy singular fields, retained for backward compatibility. For a
  // single-action workflow they describe that one action, exactly as
  // before. For a multi-action workflow they are null on a fully
  // successful run (no single action to misleadingly point at) and
  // describe the failed action on a failed run (a genuinely resolved,
  // non-arbitrary target). action_results is authoritative either way.
  createdRecordId?: string;
  actionEntityTypeId?: EntityType["id"];
  actionRecordId?: EntityRecord["id"];
  actionResults: WorkflowActionResult[];
  startedAt: IsoUtcTimestamp;
  completedAt: IsoUtcTimestamp;
};
