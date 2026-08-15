import { getEntityContext } from "./metadata-repository";
import {
  createEntityRecord,
  entityRecordExists,
  getEntityRecord,
  getRelationOptionLabel,
} from "./record-repository";
import { validateRecordValues } from "./record-validation";
import type { EntityRecord } from "./types";
import { watchedFieldsChanged } from "./workflow-change-detection";
import {
  evaluateWorkflowConditions,
  validateWorkflowConditions,
} from "./workflow-conditions";
import {
  createWorkflowExecutionLog,
  listEnabledRecordCreatedWorkflows,
  listEnabledWorkflowsForTrigger,
} from "./workflow-repository";
import { buildTargetValuesFromWorkflowConfig } from "./workflow-validation";
import type { WorkflowDefinition } from "./workflow-types";

export type WorkflowExecutionSummary = {
  succeeded: number;
  failed: number;
  targetEntityTypeIds: string[];
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown workflow error.";
}

async function executeCreateRecordAction({
  workspaceId,
  sourceContext,
  triggerRecord,
  workflow,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  triggerRecord: EntityRecord;
  workflow: WorkflowDefinition;
}) {
  const targetContext = await getEntityContext({
    workspaceId,
    entityTypeId: workflow.actionTargetEntityTypeId,
    includeArchivedFields: true,
  });

  if (targetContext.entityType.archivedAt) {
    throw new Error("Workflow target entity is archived.");
  }

  const activeTargetFields = targetContext.fields.filter(
    (field) => !field.archivedAt,
  );
  const relationLabelCache = new Map<string, string>();
  const targetValues = await buildTargetValuesFromWorkflowConfig({
    actionConfig: workflow.actionConfig,
    sourceEntityType: sourceContext.entityType,
    sourceFields: sourceContext.fields,
    targetFields: targetContext.fields,
    sourceRecord: triggerRecord,
    resolveRelationLabel: async (field, recordId) => {
      if (!field.relatedEntityTypeId) {
        return "";
      }

      const cacheKey = `${field.relatedEntityTypeId}:${recordId}`;
      const cachedLabel = relationLabelCache.get(cacheKey);

      if (cachedLabel) {
        return cachedLabel;
      }

      const relationContext = await getEntityContext({
        workspaceId,
        entityTypeId: field.relatedEntityTypeId,
        includeArchivedFields: true,
      });
      const relationRecord = await getEntityRecord({
        workspaceId,
        entityTypeId: field.relatedEntityTypeId,
        recordId,
        fields: relationContext.fields,
      });
      const label = getRelationOptionLabel(
        relationContext.fields,
        relationRecord,
      );

      relationLabelCache.set(cacheKey, label);
      return label;
    },
  });
  const validation = await validateRecordValues(
    activeTargetFields,
    targetValues,
    async (field, value) => {
      if (!field.relatedEntityTypeId) {
        return false;
      }

      return entityRecordExists({
        workspaceId,
        entityTypeId: field.relatedEntityTypeId,
        recordId: value,
      });
    },
  );

  if (!validation.success) {
    throw new Error(
      Object.values(validation.errors)[0] ?? "Workflow record is invalid.",
    );
  }

  const createdRecordId = await createEntityRecord({
    workspaceId,
    entityTypeId: targetContext.entityType.id,
    fields: activeTargetFields,
    values: validation.values,
  });

  return {
    createdRecordId,
    targetEntityTypeId: targetContext.entityType.id,
  };
}

async function validateAndEvaluateConditions({
  workspaceId,
  sourceFields,
  triggerRecord,
  workflow,
}: {
  workspaceId: string;
  sourceFields: Awaited<ReturnType<typeof getEntityContext>>["fields"];
  triggerRecord: EntityRecord;
  workflow: WorkflowDefinition;
}) {
  const conditions = workflow.actionConfig.conditions ?? [];
  const conditionValidation = await validateWorkflowConditions({
    conditions,
    sourceFields,
    validateRelationValue: async (field, value) => {
      if (!field.relatedEntityTypeId) {
        return false;
      }

      return entityRecordExists({
        workspaceId,
        entityTypeId: field.relatedEntityTypeId,
        recordId: value,
      });
    },
  });

  if (!conditionValidation.success) {
    throw new Error(conditionValidation.error);
  }

  return evaluateWorkflowConditions({
    conditions,
    sourceFields,
    sourceRecord: triggerRecord,
  });
}

export async function executeRecordCreatedWorkflows({
  workspaceId,
  triggerEntityTypeId,
  triggerRecord,
}: {
  workspaceId: string;
  triggerEntityTypeId: string;
  triggerRecord: EntityRecord;
}): Promise<WorkflowExecutionSummary> {
  const sourceContext = await getEntityContext({
    workspaceId,
    entityTypeId: triggerEntityTypeId,
    includeArchivedFields: true,
  });

  if (sourceContext.entityType.archivedAt) {
    return {
      succeeded: 0,
      failed: 0,
      targetEntityTypeIds: [],
    };
  }

  const workflows = await listEnabledRecordCreatedWorkflows({
    workspaceId,
    triggerEntityTypeId,
  });
  const summary: WorkflowExecutionSummary = {
    succeeded: 0,
    failed: 0,
    targetEntityTypeIds: [],
  };

  for (const workflow of workflows) {
    const startedAt = new Date().toISOString();
    let createdRecordId: string | undefined;
    let errorMessage: string | undefined;

    try {
      if (
        !(await validateAndEvaluateConditions({
          workspaceId,
          sourceFields: sourceContext.fields,
          triggerRecord,
          workflow,
        }))
      ) {
        errorMessage = "Workflow conditions did not match.";
        await createWorkflowExecutionLog({
          workspaceId,
          workflowId: workflow.id,
          triggerEntityTypeId,
          triggerRecordId: triggerRecord.id,
          status: "skipped",
          errorMessage,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      const actionResult = await executeCreateRecordAction({
        workspaceId,
        sourceContext,
        triggerRecord,
        workflow,
      });
      createdRecordId = actionResult.createdRecordId;
      summary.succeeded += 1;
      summary.targetEntityTypeIds.push(actionResult.targetEntityTypeId);
    } catch (error) {
      errorMessage = getErrorMessage(error);
      summary.failed += 1;
    }

    try {
      await createWorkflowExecutionLog({
        workspaceId,
        workflowId: workflow.id,
        triggerEntityTypeId,
        triggerRecordId: triggerRecord.id,
        status: errorMessage ? "failed" : "succeeded",
        errorMessage,
        createdRecordId,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    } catch {
      // Keep workflow execution isolated even if logging itself fails.
    }
  }

  return {
    ...summary,
    targetEntityTypeIds: [...new Set(summary.targetEntityTypeIds)],
  };
}

function validateWatchedFieldConfig({
  workflow,
  sourceFields,
}: {
  workflow: WorkflowDefinition;
  sourceFields: Awaited<ReturnType<typeof getEntityContext>>["fields"];
}) {
  const watchedFieldDefinitionIds =
    workflow.actionConfig.triggerConfig?.watchedFieldDefinitionIds ?? [];
  const watchedFieldIds = new Set(watchedFieldDefinitionIds);

  if (workflow.triggerType !== "record_updated") {
    throw new Error("Workflow trigger type is not record_updated.");
  }

  if (watchedFieldDefinitionIds.length === 0) {
    throw new Error("Record-updated workflow must watch at least one field.");
  }

  if (watchedFieldIds.size !== watchedFieldDefinitionIds.length) {
    throw new Error("Record-updated workflow has duplicate watched fields.");
  }

  for (const watchedFieldDefinitionId of watchedFieldDefinitionIds) {
    const watchedField = sourceFields.find(
      (field) => field.id === watchedFieldDefinitionId,
    );

    if (!watchedField) {
      throw new Error(
        "Record-updated workflow watches a trigger field that no longer exists.",
      );
    }

    if (watchedField.archivedAt) {
      throw new Error(
        `Record-updated workflow watches archived field ${watchedField.name}.`,
      );
    }
  }

  return watchedFieldDefinitionIds;
}

export async function executeRecordUpdatedWorkflows({
  workspaceId,
  triggerEntityTypeId,
  triggerRecord,
  changedFieldDefinitionIds,
}: {
  workspaceId: string;
  triggerEntityTypeId: string;
  triggerRecord: EntityRecord;
  changedFieldDefinitionIds: string[];
}): Promise<WorkflowExecutionSummary> {
  const sourceContext = await getEntityContext({
    workspaceId,
    entityTypeId: triggerEntityTypeId,
    includeArchivedFields: true,
  });

  if (sourceContext.entityType.archivedAt) {
    return {
      succeeded: 0,
      failed: 0,
      targetEntityTypeIds: [],
    };
  }

  const workflows = await listEnabledWorkflowsForTrigger({
    workspaceId,
    triggerType: "record_updated",
    triggerEntityTypeId,
  });
  const summary: WorkflowExecutionSummary = {
    succeeded: 0,
    failed: 0,
    targetEntityTypeIds: [],
  };

  for (const workflow of workflows) {
    const startedAt = new Date().toISOString();
    let createdRecordId: string | undefined;
    let errorMessage: string | undefined;
    let status: "succeeded" | "failed" | "skipped" = "succeeded";

    try {
      const watchedFieldDefinitionIds = validateWatchedFieldConfig({
        workflow,
        sourceFields: sourceContext.fields,
      });

      if (
        !watchedFieldsChanged({
          watchedFieldDefinitionIds,
          changedFieldDefinitionIds,
        })
      ) {
        status = "skipped";
        errorMessage = "Watched fields did not change.";
      } else if (
        !(await validateAndEvaluateConditions({
          workspaceId,
          sourceFields: sourceContext.fields,
          triggerRecord,
          workflow,
        }))
      ) {
        status = "skipped";
        errorMessage = "Workflow conditions did not match.";
      } else {
        const actionResult = await executeCreateRecordAction({
          workspaceId,
          sourceContext,
          triggerRecord,
          workflow,
        });
        createdRecordId = actionResult.createdRecordId;
        summary.succeeded += 1;
        summary.targetEntityTypeIds.push(actionResult.targetEntityTypeId);
      }
    } catch (error) {
      status = "failed";
      errorMessage = getErrorMessage(error);
      summary.failed += 1;
    }

    try {
      await createWorkflowExecutionLog({
        workspaceId,
        workflowId: workflow.id,
        triggerEntityTypeId,
        triggerRecordId: triggerRecord.id,
        status,
        errorMessage,
        createdRecordId,
        startedAt,
        completedAt: new Date().toISOString(),
      });
    } catch {
      // Keep workflow execution isolated even if logging itself fails.
    }
  }

  return {
    ...summary,
    targetEntityTypeIds: [...new Set(summary.targetEntityTypeIds)],
  };
}
