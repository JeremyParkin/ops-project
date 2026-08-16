import { getEntityContext } from "./metadata-repository";
import {
  createEntityRecord,
  entityRecordExists,
  getEntityRecord,
  getRelationOptionLabel,
  updateEntityRecord,
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
import {
  areFieldsCompatible,
  buildTargetValuesFromWorkflowConfig,
} from "./workflow-validation";
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
  if (!workflow.actionTargetEntityTypeId) {
    throw new Error("Create-record workflow is missing its target entity.");
  }

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

function valuesEqual(left: unknown, right: unknown) {
  const normalizedLeft = left === undefined ? null : left;
  const normalizedRight = right === undefined ? null : right;

  return normalizedLeft === normalizedRight;
}

async function createRelationLabelResolver(workspaceId: string) {
  const relationLabelCache = new Map<string, string>();

  return async (field: Awaited<ReturnType<typeof getEntityContext>>["fields"][number], recordId: string) => {
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
    const label = getRelationOptionLabel(relationContext.fields, relationRecord);

    relationLabelCache.set(cacheKey, label);
    return label;
  };
}

async function executeUpdateRecordAction({
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
  const latestRecord = await getEntityRecord({
    workspaceId,
    entityTypeId: sourceContext.entityType.id,
    recordId: triggerRecord.id,
    fields: sourceContext.fields,
  });
  const fieldById = new Map(sourceContext.fields.map((field) => [field.id, field]));
  const proposedValues: EntityRecord["values"] = { ...latestRecord.values };
  const touchedFields: typeof sourceContext.fields = [];

  for (const mapping of workflow.actionConfig.fieldMappings) {
    const targetField = fieldById.get(mapping.targetFieldDefinitionId);

    if (!targetField) {
      throw new Error("Workflow references a target field that no longer exists.");
    }

    if (targetField.archivedAt) {
      throw new Error(
        `Workflow references archived target field ${targetField.name}.`,
      );
    }

    if (mapping.source.type === "leave_unchanged") {
      continue;
    }

    touchedFields.push(targetField);

    if (mapping.source.type === "unset") {
      throw new Error(
        "Workflow create-only Unset mapping cannot be used to update records.",
      );
    }

    if (mapping.source.type === "clear") {
      if (targetField.required) {
        throw new Error(`${targetField.name} is required and cannot be cleared.`);
      }

      proposedValues[targetField.key] = null;
      continue;
    }

    if (mapping.source.type === "constant") {
      proposedValues[targetField.key] = mapping.source.value;
      continue;
    }

    if (mapping.source.type === "source_field") {
      const sourceField = fieldById.get(mapping.source.sourceFieldDefinitionId);

      if (!sourceField) {
        throw new Error("Workflow references a source field that no longer exists.");
      }

      if (sourceField.archivedAt) {
        throw new Error(
          `Workflow references archived source field ${sourceField.name}.`,
        );
      }

      if (!areFieldsCompatible(sourceField, targetField)) {
        throw new Error(
          `${sourceField.name} is no longer compatible with ${targetField.name}.`,
        );
      }

      proposedValues[targetField.key] = latestRecord.values[sourceField.key] ?? null;
      continue;
    }

    const targetValues = await buildTargetValuesFromWorkflowConfig({
      actionConfig: {
        fieldMappings: [mapping],
      },
      sourceEntityType: sourceContext.entityType,
      sourceFields: sourceContext.fields,
      targetFields: sourceContext.fields,
      sourceRecord: latestRecord,
      resolveRelationLabel: await createRelationLabelResolver(workspaceId),
    });

    proposedValues[targetField.key] = targetValues[targetField.key] ?? null;
  }

  const changedFields = touchedFields.filter(
    (field) => !valuesEqual(latestRecord.values[field.key], proposedValues[field.key]),
  );

  if (changedFields.length === 0) {
    return {
      actionRecordId: latestRecord.id,
      actionEntityTypeId: sourceContext.entityType.id,
      changed: false,
    };
  }

  const validationValues = Object.fromEntries(
    touchedFields.map((field) => [field.key, proposedValues[field.key]]),
  );
  const validation = await validateRecordValues(
    touchedFields,
    validationValues,
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
      Object.values(validation.errors)[0] ?? "Workflow record update is invalid.",
    );
  }

  await updateEntityRecord({
    workspaceId,
    entityTypeId: sourceContext.entityType.id,
    recordId: latestRecord.id,
    fields: sourceContext.fields,
    values: proposedValues,
  });

  return {
    actionRecordId: latestRecord.id,
    actionEntityTypeId: sourceContext.entityType.id,
    changed: true,
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
    let actionRecordId: string | undefined;
    let actionEntityTypeId: string | undefined;
    let resultMessage: string | undefined;
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

      // Eligibility and conditions above use the original triggering event
      // snapshot. If this workflow updates the triggering record, the action
      // reloads the latest persisted record before resolving mappings.
      const actionResult =
        workflow.actionType === "update_record"
          ? await executeUpdateRecordAction({
              workspaceId,
              sourceContext,
              triggerRecord,
              workflow,
            })
          : await executeCreateRecordAction({
              workspaceId,
              sourceContext,
              triggerRecord,
              workflow,
            });

      createdRecordId =
        "createdRecordId" in actionResult ? actionResult.createdRecordId : undefined;
      actionRecordId =
        "createdRecordId" in actionResult
          ? actionResult.createdRecordId
          : actionResult.actionRecordId;
      actionEntityTypeId =
        "targetEntityTypeId" in actionResult
          ? actionResult.targetEntityTypeId
          : actionResult.actionEntityTypeId;
      resultMessage =
        "changed" in actionResult && !actionResult.changed
          ? "No changes required."
          : undefined;
      summary.succeeded += 1;
      summary.targetEntityTypeIds.push(actionEntityTypeId);
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
        resultMessage,
        createdRecordId,
        actionEntityTypeId,
        actionRecordId,
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
    let actionRecordId: string | undefined;
    let actionEntityTypeId: string | undefined;
    let resultMessage: string | undefined;
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
        // Workflows are eligible based on the original persisted user edit:
        // watched-field detection and conditions do not get re-evaluated after
        // earlier workflow actions. Matching workflows still execute in
        // deterministic order, and update_record actions reload the latest
        // authoritative record before resolving their mappings.
        const actionResult =
          workflow.actionType === "update_record"
            ? await executeUpdateRecordAction({
                workspaceId,
                sourceContext,
                triggerRecord,
                workflow,
              })
            : await executeCreateRecordAction({
                workspaceId,
                sourceContext,
                triggerRecord,
                workflow,
              });

        createdRecordId =
          "createdRecordId" in actionResult
            ? actionResult.createdRecordId
            : undefined;
        actionRecordId =
          "createdRecordId" in actionResult
            ? actionResult.createdRecordId
            : actionResult.actionRecordId;
        actionEntityTypeId =
          "targetEntityTypeId" in actionResult
            ? actionResult.targetEntityTypeId
            : actionResult.actionEntityTypeId;
        resultMessage =
          "changed" in actionResult && !actionResult.changed
            ? "No changes required."
            : undefined;
        summary.succeeded += 1;
        summary.targetEntityTypeIds.push(actionEntityTypeId);
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
        resultMessage,
        createdRecordId,
        actionEntityTypeId,
        actionRecordId,
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
