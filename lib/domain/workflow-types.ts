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
  | "update_related_record";
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

export type WorkflowActionConfig = {
  relatedFieldDefinitionId?: FieldDefinition["id"];
  triggerConfig?: {
    watchedFieldDefinitionIds?: FieldDefinition["id"][];
  };
  conditions?: WorkflowCondition[];
  fieldMappings: WorkflowFieldMapping[];
};

export type WorkflowDefinition = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  triggerType: WorkflowTriggerType;
  triggerEntityTypeId: EntityType["id"];
  actionType: WorkflowActionType;
  actionTargetEntityTypeId?: EntityType["id"];
  actionConfig: WorkflowActionConfig;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
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
  createdRecordId?: string;
  actionEntityTypeId?: EntityType["id"];
  actionRecordId?: EntityRecord["id"];
  startedAt: IsoUtcTimestamp;
  completedAt: IsoUtcTimestamp;
};
