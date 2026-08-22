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
import type {
  WorkflowAction,
  WorkflowActionResult,
  WorkflowDefinition,
  WorkflowTriggerType,
} from "./workflow-types";

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
  action,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  triggerRecord: EntityRecord;
  action: WorkflowAction;
}) {
  if (!action.actionTargetEntityTypeId) {
    throw new Error("Create-record action is missing its target entity.");
  }

  const targetContext = await getEntityContext({
    workspaceId,
    entityTypeId: action.actionTargetEntityTypeId,
    includeArchivedFields: true,
  });

  if (targetContext.entityType.archivedAt) {
    throw new Error("Workflow target entity is archived.");
  }

  // Reload the latest triggering record, same as update_record/
  // update_related_record already do, so a create_record action positioned
  // after an earlier action that modified the triggering record sees that
  // effect rather than the original triggering snapshot.
  const latestTriggerRecord = await getEntityRecord({
    workspaceId,
    entityTypeId: sourceContext.entityType.id,
    recordId: triggerRecord.id,
    fields: sourceContext.fields,
  });
  const activeTargetFields = targetContext.fields.filter(
    (field) => !field.archivedAt,
  );
  const relationLabelCache = new Map<string, string>();
  const targetValues = await buildTargetValuesFromWorkflowConfig({
    fieldMappings: action.fieldMappings,
    sourceEntityType: sourceContext.entityType,
    sourceFields: sourceContext.fields,
    targetFields: targetContext.fields,
    sourceRecord: latestTriggerRecord,
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
        relationContext.entityType,
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
    const label = getRelationOptionLabel(
      relationContext.entityType,
      relationContext.fields,
      relationRecord,
    );

    relationLabelCache.set(cacheKey, label);
    return label;
  };
}

class RelatedTargetResolvedError extends Error {
  constructor(
    cause: unknown,
    readonly actionEntityTypeId: string,
    readonly actionRecordId: string,
  ) {
    super(getErrorMessage(cause));
  }
}

async function executeRecordUpdate({
  workspaceId,
  sourceContext,
  sourceRecord,
  targetContext,
  targetRecord,
  action,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  sourceRecord: EntityRecord;
  targetContext: Awaited<ReturnType<typeof getEntityContext>>;
  targetRecord: EntityRecord;
  action: WorkflowAction;
}) {
  const sourceFieldById = new Map(
    sourceContext.fields.map((field) => [field.id, field]),
  );
  const targetFieldById = new Map(
    targetContext.fields.map((field) => [field.id, field]),
  );
  const proposedValues: EntityRecord["values"] = { ...targetRecord.values };
  const touchedFields: typeof targetContext.fields = [];

  for (const mapping of action.fieldMappings) {
    const targetField = targetFieldById.get(mapping.targetFieldDefinitionId);

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
      const sourceField = sourceFieldById.get(mapping.source.sourceFieldDefinitionId);

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

      proposedValues[targetField.key] = sourceRecord.values[sourceField.key] ?? null;
      continue;
    }

    const targetValues = await buildTargetValuesFromWorkflowConfig({
      fieldMappings: [mapping],
      sourceEntityType: sourceContext.entityType,
      sourceFields: sourceContext.fields,
      targetFields: targetContext.fields,
      sourceRecord,
      resolveRelationLabel: await createRelationLabelResolver(workspaceId),
    });

    proposedValues[targetField.key] = targetValues[targetField.key] ?? null;
  }

  const changedFields = touchedFields.filter(
    (field) => !valuesEqual(targetRecord.values[field.key], proposedValues[field.key]),
  );

  if (changedFields.length === 0) {
    return {
      actionRecordId: targetRecord.id,
      actionEntityTypeId: targetContext.entityType.id,
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
    entityTypeId: targetContext.entityType.id,
    recordId: targetRecord.id,
    fields: targetContext.fields,
    values: proposedValues,
  });

  return {
    actionRecordId: targetRecord.id,
    actionEntityTypeId: targetContext.entityType.id,
    changed: true,
  };
}

async function executeUpdateRecordAction({
  workspaceId,
  sourceContext,
  triggerRecord,
  action,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  triggerRecord: EntityRecord;
  action: WorkflowAction;
}) {
  const latestRecord = await getEntityRecord({
    workspaceId,
    entityTypeId: sourceContext.entityType.id,
    recordId: triggerRecord.id,
    fields: sourceContext.fields,
  });

  return executeRecordUpdate({
    workspaceId,
    sourceContext,
    sourceRecord: latestRecord,
    targetContext: sourceContext,
    targetRecord: latestRecord,
    action,
  });
}

async function executeUpdateRelatedRecordAction({
  workspaceId,
  sourceContext,
  triggerRecord,
  action,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  triggerRecord: EntityRecord;
  action: WorkflowAction;
}) {
  const latestTriggerRecord = await getEntityRecord({
    workspaceId,
    entityTypeId: sourceContext.entityType.id,
    recordId: triggerRecord.id,
    fields: sourceContext.fields,
  });
  const relatedField = sourceContext.fields.find(
    (field) => field.id === action.relatedFieldDefinitionId,
  );

  if (!relatedField || relatedField.type !== "relation" || !relatedField.relatedEntityTypeId) {
    throw new Error("Workflow related record field is invalid.");
  }

  if (relatedField.archivedAt) {
    throw new Error(`Workflow references archived related field ${relatedField.name}.`);
  }

  const relatedRecordId = latestTriggerRecord.values[relatedField.key];

  if (typeof relatedRecordId !== "string" || !relatedRecordId) {
    throw new Error(`Related record field ${relatedField.name} has no record.`);
  }

  const targetContext = await getEntityContext({
    workspaceId,
    entityTypeId: relatedField.relatedEntityTypeId,
    includeArchivedFields: true,
  });
  const targetRecord = await getEntityRecord({
    workspaceId,
    entityTypeId: targetContext.entityType.id,
    recordId: relatedRecordId,
    fields: targetContext.fields,
  });

  if (targetContext.entityType.archivedAt) {
    throw new RelatedTargetResolvedError(
      new Error("Workflow related target entity is archived."),
      targetContext.entityType.id,
      targetRecord.id,
    );
  }

  if (targetRecord.archivedAt) {
    throw new RelatedTargetResolvedError(
      new Error("Workflow related target record is archived."),
      targetContext.entityType.id,
      targetRecord.id,
    );
  }

  try {
    return await executeRecordUpdate({
      workspaceId,
      sourceContext,
      sourceRecord: latestTriggerRecord,
      targetContext,
      targetRecord,
      action,
    });
  } catch (error) {
    throw new RelatedTargetResolvedError(
      error,
      targetContext.entityType.id,
      targetRecord.id,
    );
  }
}

async function executeSingleAction({
  workspaceId,
  sourceContext,
  triggerRecord,
  action,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  triggerRecord: EntityRecord;
  action: WorkflowAction;
}) {
  const actionResult =
    action.actionType === "update_record"
      ? await executeUpdateRecordAction({ workspaceId, sourceContext, triggerRecord, action })
      : action.actionType === "update_related_record"
        ? await executeUpdateRelatedRecordAction({
            workspaceId,
            sourceContext,
            triggerRecord,
            action,
          })
        : await executeCreateRecordAction({ workspaceId, sourceContext, triggerRecord, action });

  return {
    createdRecordId:
      "createdRecordId" in actionResult ? actionResult.createdRecordId : undefined,
    actionRecordId:
      "createdRecordId" in actionResult
        ? actionResult.createdRecordId
        : actionResult.actionRecordId,
    actionEntityTypeId:
      "targetEntityTypeId" in actionResult
        ? actionResult.targetEntityTypeId
        : actionResult.actionEntityTypeId,
    resultMessage:
      "changed" in actionResult && !actionResult.changed
        ? "No changes required."
        : undefined,
  };
}

class WorkflowActionsFailedError extends Error {
  constructor(
    message: string,
    readonly actionResults: WorkflowActionResult[],
  ) {
    super(message);
  }
}

// Executes a workflow's actions strictly in order. Each action reloads the
// latest authoritative record before it runs (already true of the
// individual action executors), so later actions naturally see earlier
// actions' committed effects without any explicit state hand-off. The first
// action to throw stops the remaining actions for this workflow run; prior
// successful writes are not rolled back. Records an ordered result only for
// actions that actually began execution.
async function executeWorkflowActions({
  workspaceId,
  sourceContext,
  triggerRecord,
  actions,
}: {
  workspaceId: string;
  sourceContext: Awaited<ReturnType<typeof getEntityContext>>;
  triggerRecord: EntityRecord;
  actions: WorkflowAction[];
}): Promise<{
  actionResults: WorkflowActionResult[];
  targetEntityTypeIds: string[];
}> {
  const actionResults: WorkflowActionResult[] = [];
  const targetEntityTypeIds: string[] = [];

  for (const [index, action] of actions.entries()) {
    try {
      const result = await executeSingleAction({
        workspaceId,
        sourceContext,
        triggerRecord,
        action,
      });

      actionResults.push({
        index,
        actionType: action.actionType,
        status: "succeeded",
        actionEntityTypeId: result.actionEntityTypeId,
        actionRecordId: result.actionRecordId,
        createdRecordId: result.createdRecordId,
        resultMessage: result.resultMessage,
      });

      if (result.actionEntityTypeId) {
        targetEntityTypeIds.push(result.actionEntityTypeId);
      }
    } catch (error) {
      const resolvedEntityTypeId =
        error instanceof RelatedTargetResolvedError
          ? error.actionEntityTypeId
          : undefined;
      const resolvedRecordId =
        error instanceof RelatedTargetResolvedError ? error.actionRecordId : undefined;
      const errorMessage = getErrorMessage(error);

      actionResults.push({
        index,
        actionType: action.actionType,
        status: "failed",
        actionEntityTypeId: resolvedEntityTypeId,
        actionRecordId: resolvedRecordId,
        errorMessage,
      });

      // A single-action workflow's error message stays exactly as today
      // (no prefix); a multi-action workflow's message identifies which
      // action failed, since action_results may not be surfaced everywhere
      // the plain error message is read.
      const message =
        actions.length === 1
          ? errorMessage
          : `Action ${index + 1} (${action.actionType}) failed: ${errorMessage}`;

      throw new WorkflowActionsFailedError(message, actionResults);
    }
  }

  return { actionResults, targetEntityTypeIds };
}

function describeActionOutcome(result: WorkflowActionResult) {
  if (result.resultMessage) {
    return result.resultMessage;
  }

  switch (result.actionType) {
    case "create_record":
      return "created a record.";
    case "update_record":
      return "updated the triggering record.";
    case "update_related_record":
      return "updated a related record.";
  }
}

function buildSuccessResultMessage(actionResults: WorkflowActionResult[]) {
  if (actionResults.length === 0) {
    return undefined;
  }

  // Single-action workflows keep today's exact message (or lack thereof):
  // undefined unless that one action was a no-op update.
  if (actionResults.length === 1) {
    return actionResults[0].resultMessage;
  }

  return actionResults
    .map((result) => `Action ${result.index + 1}: ${describeActionOutcome(result)}`)
    .join(" ");
}

// Legacy singular log fields, retained for backward compatibility. A
// single-action workflow populates them exactly as before. A multi-action
// workflow leaves them null on a fully successful run (no single action to
// point at without being misleading) and, on failure, describes the failed
// action specifically (a genuinely resolved, non-arbitrary target) —
// action_results is authoritative in both cases.
function buildLegacySingularFields({
  actions,
  actionResults,
  failed,
}: {
  actions: WorkflowAction[];
  actionResults: WorkflowActionResult[];
  failed: boolean;
}) {
  if (actions.length === 1) {
    const onlyResult = actionResults[0];

    return {
      createdRecordId: onlyResult?.createdRecordId,
      actionEntityTypeId: onlyResult?.actionEntityTypeId,
      actionRecordId: onlyResult?.actionRecordId,
    };
  }

  if (!failed) {
    return {
      createdRecordId: undefined,
      actionEntityTypeId: undefined,
      actionRecordId: undefined,
    };
  }

  const failedResult = actionResults.at(-1);

  return {
    createdRecordId: undefined,
    actionEntityTypeId: failedResult?.actionEntityTypeId,
    actionRecordId: failedResult?.actionRecordId,
  };
}

async function validateAndEvaluateConditions({
  workspaceId,
  sourceFields,
  triggerRecord,
  previousRecord,
  triggerType,
  watchedFieldDefinitionIds,
  workflow,
}: {
  workspaceId: string;
  sourceFields: Awaited<ReturnType<typeof getEntityContext>>["fields"];
  triggerRecord: EntityRecord;
  previousRecord?: EntityRecord;
  triggerType: WorkflowTriggerType;
  watchedFieldDefinitionIds: string[];
  workflow: WorkflowDefinition;
}) {
  const conditions = workflow.conditions ?? [];
  const conditionValidation = await validateWorkflowConditions({
    conditions,
    sourceFields,
    triggerType,
    watchedFieldDefinitionIds,
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
    previousRecord,
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
    let resultMessage: string | undefined;
    let errorMessage: string | undefined;
    let actionResults: WorkflowActionResult[] = [];

    try {
      if (
        !(await validateAndEvaluateConditions({
          workspaceId,
          sourceFields: sourceContext.fields,
          triggerRecord,
          triggerType: "record_created",
          watchedFieldDefinitionIds: [],
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
          actionResults: [],
          startedAt,
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Eligibility and conditions above use the original triggering event
      // snapshot and are evaluated once, before any action runs. Actions
      // execute sequentially in configured order below; a later action
      // never causes conditions to be re-evaluated.
      const executionResult = await executeWorkflowActions({
        workspaceId,
        sourceContext,
        triggerRecord,
        actions: workflow.actions,
      });

      actionResults = executionResult.actionResults;
      resultMessage = buildSuccessResultMessage(actionResults);
      summary.succeeded += 1;
      executionResult.targetEntityTypeIds.forEach((id) =>
        summary.targetEntityTypeIds.push(id),
      );
    } catch (error) {
      if (error instanceof WorkflowActionsFailedError) {
        actionResults = error.actionResults;
      }
      errorMessage = getErrorMessage(error);
      summary.failed += 1;
    }

    const legacyFields = buildLegacySingularFields({
      actions: workflow.actions,
      actionResults,
      failed: Boolean(errorMessage),
    });

    try {
      await createWorkflowExecutionLog({
        workspaceId,
        workflowId: workflow.id,
        triggerEntityTypeId,
        triggerRecordId: triggerRecord.id,
        status: errorMessage ? "failed" : "succeeded",
        errorMessage,
        resultMessage,
        createdRecordId: legacyFields.createdRecordId,
        actionEntityTypeId: legacyFields.actionEntityTypeId,
        actionRecordId: legacyFields.actionRecordId,
        actionResults,
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
    workflow.triggerConfig?.watchedFieldDefinitionIds ?? [];
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
  previousRecord,
  changedFieldDefinitionIds,
}: {
  workspaceId: string;
  triggerEntityTypeId: string;
  triggerRecord: EntityRecord;
  previousRecord: EntityRecord;
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
    let resultMessage: string | undefined;
    let errorMessage: string | undefined;
    let actionResults: WorkflowActionResult[] = [];
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
          previousRecord,
          triggerType: "record_updated",
          watchedFieldDefinitionIds,
          workflow,
        }))
      ) {
        status = "skipped";
        errorMessage = "Workflow conditions did not match.";
      } else {
        // Workflows are eligible based on the original persisted user edit:
        // watched-field detection and conditions do not get re-evaluated
        // after any action runs, and are only ever checked once, before the
        // first action. Matching workflows execute their actions in
        // deterministic configured order below; update_record/
        // update_related_record actions each reload the latest
        // authoritative record before resolving their own mappings, so a
        // later action sees an earlier action's committed effects.
        const executionResult = await executeWorkflowActions({
          workspaceId,
          sourceContext,
          triggerRecord,
          actions: workflow.actions,
        });

        actionResults = executionResult.actionResults;
        resultMessage = buildSuccessResultMessage(actionResults);
        summary.succeeded += 1;
        executionResult.targetEntityTypeIds.forEach((id) =>
          summary.targetEntityTypeIds.push(id),
        );
      }
    } catch (error) {
      if (error instanceof WorkflowActionsFailedError) {
        actionResults = error.actionResults;
      }
      status = "failed";
      errorMessage = getErrorMessage(error);
      summary.failed += 1;
    }

    const legacyFields = buildLegacySingularFields({
      actions: workflow.actions,
      actionResults,
      failed: status === "failed",
    });

    try {
      await createWorkflowExecutionLog({
        workspaceId,
        workflowId: workflow.id,
        triggerEntityTypeId,
        triggerRecordId: triggerRecord.id,
        status,
        errorMessage,
        resultMessage,
        createdRecordId: legacyFields.createdRecordId,
        actionEntityTypeId: legacyFields.actionEntityTypeId,
        actionRecordId: legacyFields.actionRecordId,
        actionResults,
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
