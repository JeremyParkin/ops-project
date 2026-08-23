"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import type { EntityRecord, FieldDefinition } from "@/lib/domain/types";
import {
  type EntityDefinitionFormState,
  validateEntityDefinitionFormData,
} from "@/lib/domain/entity-definition-validation";
import {
  type EntityMetadataFormState,
  validateEntityMetadataFormData,
} from "@/lib/domain/entity-metadata-validation";
import {
  type FieldDefinitionFormState,
  initialFieldDefinitionFormState,
  validateFieldDefinitionFormData,
} from "@/lib/domain/field-definition-validation";
import {
  type FieldEditFormState,
  validateFieldEditFormData,
} from "@/lib/domain/field-edit-validation";
import {
  initialRecordFormState,
  type RecordFormState,
  validateRecordFormData,
} from "@/lib/domain/record-validation";
import {
  executeRecordCreatedWorkflows,
  executeRecordUpdatedWorkflows,
} from "@/lib/domain/workflow-engine";
import {
  getChangedFieldDefinitionIds,
  valuesAreEqual,
} from "@/lib/domain/workflow-change-detection";
import {
  createWorkflowFormStateFromDefinition,
  type WorkflowFormState,
  validateWorkflowFormData,
} from "@/lib/domain/workflow-validation";
import {
  archiveFieldDefinition,
  archiveEntityType,
  createFieldDefinition,
  createEntityTypesWithFieldsAuthorized,
  createEntityTypeWithFields,
  deleteFieldDefinition,
  deleteEntityType,
  getEntityTypeRelationFieldSummary,
  getEntityTypeWorkflowTargetSummary,
  getEntityContext,
  listEntityTypes,
  restoreFieldDefinition,
  restoreEntityType,
  setEntityDisplayField,
  updateEntityTypeMetadata,
  updateFieldDefinition as updateFieldDefinitionInRepository,
} from "@/lib/domain/metadata-repository";
import {
  buildStarterEntities,
  parseStarterOptionIds,
  type WorkspaceSetupFormState,
} from "@/lib/domain/workspace-onboarding";
import {
  archiveEntityRecord,
  countEntityRecords,
  createEntityRecord,
  deleteEntityRecord,
  entityRecordExists,
  getEntityRecord,
  getIncomingReferenceSummary,
  restoreEntityRecord,
  type RecordActionState,
  updateEntityRecord as updateEntityRecordInRepository,
} from "@/lib/domain/record-repository";
import {
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflow,
  setWorkflowEnabled,
  updateWorkflowDefinition,
} from "@/lib/domain/workflow-repository";
import {
  createEntityView,
  deleteEntityView,
  updateEntityView,
} from "@/lib/domain/view-repository";
import {
  createInitialViewFormState,
  type ViewFormState,
  validateViewFormData,
} from "@/lib/domain/view-validation";

type CreateRecordContext = {
  workspaceId: string;
  entityTypeId: string;
  relatedCreateOrigin?: {
    entityTypeId: string;
    recordId: string;
  };
};

type EntityTypeContext = CreateRecordContext;

type UpdateRecordContext = CreateRecordContext & {
  recordId: string;
};

type UpdateFieldDefinitionContext = CreateRecordContext & {
  fieldDefinitionId: string;
};

type EntityViewContext = CreateRecordContext & {
  viewId?: string;
};

export type EntityTypeActionState = {
  success: boolean;
  message: string;
};

export type WorkflowActionState = {
  success: boolean;
  message: string;
};

export type FieldLifecycleActionState = {
  success: boolean;
  message: string;
};

export type DeleteViewActionState = {
  success: boolean;
  message: string;
};

async function validateRecordSubmission(
  context: CreateRecordContext,
  formData: FormData,
  existingRecordId?: string,
) {
  const entityContext = await getEntityContext(context);
  const existingRecord = existingRecordId
    ? await getEntityRecord({
        ...context,
        recordId: existingRecordId,
        fields: entityContext.fields,
      })
    : undefined;
  const validation = await validateRecordFormData(
    entityContext.fields,
    formData,
    async (field, value) => {
      if (!field.relatedEntityTypeId) {
        return false;
      }

      if (existingRecord?.values[field.key] === value) {
        return entityRecordExists({
          workspaceId: context.workspaceId,
          entityTypeId: field.relatedEntityTypeId,
          recordId: value,
          includeArchived: true,
        });
      }

      return entityRecordExists({
        workspaceId: context.workspaceId,
        entityTypeId: field.relatedEntityTypeId,
        recordId: value,
      });
    },
  );

  return {
    ...entityContext,
    validation,
  };
}

async function isActiveEntityType(workspaceId: string, entityTypeId: string) {
  const entityTypes = await listEntityTypes({ workspaceId });

  return entityTypes.some((entityType) => entityType.id === entityTypeId);
}

async function findInactiveRelationTarget(
  workspaceId: string,
  fields: Array<{
    type: string;
    relatedEntityTypeId: string;
  }>,
) {
  for (const field of fields) {
    if (
      field.type === "relation" &&
      !(await isActiveEntityType(workspaceId, field.relatedEntityTypeId))
    ) {
      return field.relatedEntityTypeId;
    }
  }

  return null;
}

export async function createRecord(
  context: CreateRecordContext,
  _previousState: RecordFormState,
  formData: FormData,
): Promise<RecordFormState> {
  const { entityType, fields, validation } = await validateRecordSubmission(
    context,
    formData,
  );

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before editing records.",
      errors: {
        _form: "Archived entities are read-only.",
      },
      values: validation.success ? validation.submittedValues : validation.submittedValues,
    };
  }

  if (!validation.success) {
    return {
      success: false,
      message: "Please fix the highlighted fields.",
      errors: validation.errors,
      values: validation.submittedValues,
    };
  }

  let createdRecordId: string;

  try {
    createdRecordId = await createEntityRecord({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      fields,
      values: validation.values,
    });
  } catch {
    return {
      success: false,
      message: "Unable to create the record. Please try again.",
      errors: {
        _form: "The database rejected the record.",
      },
      values: validation.submittedValues,
    };
  }

  let workflowMessage = "";

  try {
    const workflowSummary = await executeRecordCreatedWorkflows({
      workspaceId: entityType.workspaceId,
      triggerEntityTypeId: entityType.id,
      triggerRecord: {
        id: createdRecordId,
        workspaceId: entityType.workspaceId,
        entityTypeId: entityType.id,
        values: validation.values,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    workflowSummary.targetEntityTypeIds.forEach((targetEntityTypeId) => {
      revalidatePath(`/entities/${targetEntityTypeId}`);
    });

    if (workflowSummary.succeeded > 0 || workflowSummary.failed > 0) {
      workflowMessage = ` ${workflowSummary.succeeded} workflow${
        workflowSummary.succeeded === 1 ? "" : "s"
      } succeeded`;

      if (workflowSummary.failed > 0) {
        workflowMessage += `, ${workflowSummary.failed} failed`;
      }

      workflowMessage += ".";
    }
  } catch {
    workflowMessage = " Workflow execution could not be checked.";
  }

  revalidatePath(`/entities/${entityType.id}`);

  if (context.relatedCreateOrigin) {
    const originPath = `/entities/${context.relatedCreateOrigin.entityTypeId}/records/${context.relatedCreateOrigin.recordId}`;

    revalidatePath(`/entities/${context.relatedCreateOrigin.entityTypeId}`);
    revalidatePath(originPath);
    redirect(originPath);
  }

  return {
    ...initialRecordFormState,
    success: true,
    message: `${entityType.name} created.${workflowMessage}`,
  };
}

export async function archiveRecord(
  context: UpdateRecordContext,
  previousState: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  void previousState;
  void formData;

  try {
    const { entityType } = await getEntityContext(context);

    if (entityType.archivedAt) {
      return {
        success: false,
        message:
          "Archived entities are read-only. Restore this entity before editing records.",
      };
    }

    await archiveEntityRecord(context);
  } catch {
    return {
      success: false,
      message: "Unable to archive the record. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);
  revalidatePath(`/entities/${context.entityTypeId}/records/${context.recordId}`);

  return {
    success: true,
    message: "Record archived.",
  };
}

export async function restoreRecord(
  context: UpdateRecordContext,
  previousState: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  void previousState;
  void formData;

  try {
    const { entityType } = await getEntityContext(context);

    if (entityType.archivedAt) {
      return {
        success: false,
        message:
          "Archived entities are read-only. Restore this entity before editing records.",
      };
    }

    await restoreEntityRecord(context);
  } catch {
    return {
      success: false,
      message: "Unable to restore the record. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);
  revalidatePath(`/entities/${context.entityTypeId}/records/${context.recordId}`);

  return {
    success: true,
    message: "Record restored.",
  };
}

function formatReferenceSummary(
  entityName: string,
  summary: Awaited<ReturnType<typeof getIncomingReferenceSummary>>,
) {
  const pluralize = (name: string, count: number) => {
    if (count === 1 || name.endsWith("s")) {
      return name;
    }

    return `${name}s`;
  };
  const groups = summary.groups
    .map(
      (group) =>
        `${group.count} ${pluralize(group.entityTypeName, group.count)}`,
    )
    .join(" and ");

  return `Cannot delete this ${entityName} because it is referenced by ${
    groups || `${summary.total} record${summary.total === 1 ? "" : "s"}`
  }.`;
}

export async function deleteRecord(
  context: UpdateRecordContext,
  previousState: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  void previousState;
  void formData;

  const { entityType } = await getEntityContext(context);

  if (entityType.archivedAt) {
    return {
      success: false,
      message:
        "Archived entities are read-only. Restore this entity before editing records.",
    };
  }

  try {
    const result = await deleteEntityRecord(context);

    if (!result.deleted) {
      const summary = await getIncomingReferenceSummary(context);

      return {
        success: false,
        message: formatReferenceSummary(entityType.name, {
          ...summary,
          total: result.referenceCount,
        }),
      };
    }
  } catch {
    return {
      success: false,
      message: "Unable to delete the record. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Record deleted.",
  };
}

export async function deleteRecordFromDetail(
  context: UpdateRecordContext,
  previousState: RecordActionState,
  formData: FormData,
): Promise<RecordActionState> {
  const result = await deleteRecord(context, previousState, formData);

  if (!result.success) {
    return result;
  }

  redirect(`/entities/${context.entityTypeId}`);
}

export async function updateRecord(
  context: UpdateRecordContext,
  _previousState: RecordFormState,
  formData: FormData,
): Promise<RecordFormState> {
  const { entityType, fields, validation } = await validateRecordSubmission(
    context,
    formData,
    context.recordId,
  );

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before editing records.",
      errors: {
        _form: "Archived entities are read-only.",
      },
      values: validation.success ? validation.submittedValues : validation.submittedValues,
    };
  }

  if (!validation.success) {
    return {
      success: false,
      message: "Please fix the highlighted fields.",
      errors: validation.errors,
      values: validation.submittedValues,
    };
  }

  let previousRecord;

  try {
    previousRecord = await getEntityRecord({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      recordId: context.recordId,
      fields,
    });
  } catch {
    return {
      success: false,
      message: "Unable to load the existing record. Please try again.",
      errors: {
        _form: "The existing record could not be loaded.",
      },
      values: validation.submittedValues,
    };
  }

  try {
    await updateEntityRecordInRepository({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      recordId: context.recordId,
      fields,
      values: validation.values,
    });
  } catch {
    return {
      success: false,
      message: "Unable to update the record. Please try again.",
      errors: {
        _form: "The database rejected the record update.",
      },
      values: validation.submittedValues,
    };
  }

  try {
    const nextRecord = await getEntityRecord({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      recordId: context.recordId,
      fields,
    });
    const changedFieldDefinitionIds = getChangedFieldDefinitionIds({
      fields,
      previousRecord,
      nextRecord,
    });
    const workflowSummary = await executeRecordUpdatedWorkflows({
      workspaceId: entityType.workspaceId,
      triggerEntityTypeId: entityType.id,
      triggerRecord: nextRecord,
      previousRecord,
      changedFieldDefinitionIds,
    });

    workflowSummary.targetEntityTypeIds.forEach((targetEntityTypeId) => {
      revalidatePath(`/entities/${targetEntityTypeId}`);
    });
  } catch {
    // Workflow execution must not roll back or block a successful user edit.
  }

  revalidatePath(`/entities/${entityType.id}`);
  revalidatePath(`/entities/${entityType.id}/records/${context.recordId}`);

  if (formData.get("returnTo") === "detail") {
    redirect(`/entities/${entityType.id}/records/${context.recordId}`);
  }

  redirect(`/entities/${entityType.id}`);
}

export type RecordFieldFormState = {
  success: boolean;
  message: string;
  value: string;
  blocked?: boolean;
};

const initialRecordFieldFormState: RecordFieldFormState = {
  success: false,
  message: "",
  value: "",
};

function stringifyFieldValueForForm(
  field: FieldDefinition,
  record: EntityRecord,
) {
  const value = record.values[field.key];

  if (field.type === "boolean") {
    return value === true ? "true" : "false";
  }

  return value === null || value === undefined ? "" : String(value);
}

// The update RPC replaces the entire primitive values object rather than
// patching a single key (see update_entity_record_with_relations), so an
// inline single-field edit must be validated and submitted as a full record:
// the current persisted values for every other active field, plus the one
// edited value. This reuses the exact FormData-based validator the full edit
// form uses, so required-field and per-type validation stay identical.
function buildMergedFormData(
  fields: FieldDefinition[],
  previousRecord: EntityRecord,
  editedField: FieldDefinition,
  rawValue: string,
) {
  const formData = new FormData();

  fields.forEach((field) => {
    formData.set(
      field.key,
      field.id === editedField.id
        ? rawValue
        : stringifyFieldValueForForm(field, previousRecord),
    );
  });

  return formData;
}

export async function updateRecordField(
  context: UpdateRecordContext,
  _previousState: RecordFieldFormState,
  formData: FormData,
): Promise<RecordFieldFormState> {
  const fieldKey = formData.get("fieldKey");
  // The boolean control submits a hidden "false" fallback alongside the
  // checkbox's "true" value under the same name (see record-edit-form.tsx),
  // so the last submitted "value" entry is the one that reflects intent.
  const rawValue = formData.getAll("value").at(-1);

  if (typeof fieldKey !== "string" || typeof rawValue !== "string") {
    return {
      ...initialRecordFieldFormState,
      message: "Invalid submission.",
    };
  }

  const { entityType, fields } = await getEntityContext(context);

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only.",
      value: rawValue,
    };
  }

  const field = fields.find(
    (candidate) => candidate.key === fieldKey && !candidate.archivedAt,
  );

  if (!field || field.type === "relation") {
    return {
      success: false,
      message: "This field can't be edited inline.",
      value: rawValue,
    };
  }

  let previousRecord;

  try {
    previousRecord = await getEntityRecord({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      recordId: context.recordId,
      fields,
    });
  } catch {
    return {
      success: false,
      message: "Unable to load the existing record. Please try again.",
      value: rawValue,
    };
  }

  if (previousRecord.archivedAt) {
    return {
      success: false,
      message: "Archived records are read-only.",
      value: rawValue,
    };
  }

  const mergedFormData = buildMergedFormData(fields, previousRecord, field, rawValue);
  const validation = await validateRecordFormData(
    fields,
    mergedFormData,
    async (relationField, value) => {
      if (!relationField.relatedEntityTypeId) {
        return false;
      }

      if (previousRecord.values[relationField.key] === value) {
        return entityRecordExists({
          workspaceId: context.workspaceId,
          entityTypeId: relationField.relatedEntityTypeId,
          recordId: value,
          includeArchived: true,
        });
      }

      return entityRecordExists({
        workspaceId: context.workspaceId,
        entityTypeId: relationField.relatedEntityTypeId,
        recordId: value,
      });
    },
  );

  if (!validation.success) {
    const ownFieldError = validation.errors[field.key];

    if (ownFieldError) {
      return {
        success: false,
        message: ownFieldError,
        value: rawValue,
      };
    }

    return {
      success: false,
      message: "This record needs additional changes. Open full edit.",
      value: rawValue,
      blocked: true,
    };
  }

  if (valuesAreEqual(previousRecord.values[field.key], validation.values[field.key])) {
    return {
      success: true,
      message: "",
      value: validation.submittedValues[field.key] ?? rawValue,
    };
  }

  try {
    await updateEntityRecordInRepository({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      recordId: context.recordId,
      fields,
      values: validation.values,
    });
  } catch {
    return {
      success: false,
      message: "Unable to update the record. Please try again.",
      value: rawValue,
    };
  }

  try {
    const nextRecord = await getEntityRecord({
      workspaceId: entityType.workspaceId,
      entityTypeId: entityType.id,
      recordId: context.recordId,
      fields,
    });
    const changedFieldDefinitionIds = getChangedFieldDefinitionIds({
      fields,
      previousRecord,
      nextRecord,
    });
    const workflowSummary = await executeRecordUpdatedWorkflows({
      workspaceId: entityType.workspaceId,
      triggerEntityTypeId: entityType.id,
      triggerRecord: nextRecord,
      previousRecord,
      changedFieldDefinitionIds,
    });

    workflowSummary.targetEntityTypeIds.forEach((targetEntityTypeId) => {
      revalidatePath(`/entities/${targetEntityTypeId}`);
    });
  } catch {
    // Workflow execution must not roll back or block a successful inline edit.
  }

  revalidatePath(`/entities/${entityType.id}`);
  revalidatePath(`/entities/${entityType.id}/records/${context.recordId}`);

  return {
    success: true,
    message: "",
    value: validation.submittedValues[field.key] ?? rawValue,
  };
}

export async function createEntityDefinition(
  previousState: EntityDefinitionFormState,
  formData: FormData,
): Promise<EntityDefinitionFormState> {
  const { workspaceId } = await getActiveWorkspaceId();
  const nextFormVersion = previousState.formVersion + 1;
  const validation = validateEntityDefinitionFormData(formData, nextFormVersion);

  if (!validation.success) {
    return validation.state;
  }

  const inactiveRelationTarget = await findInactiveRelationTarget(
    workspaceId,
    validation.definition.fields,
  );

  if (inactiveRelationTarget) {
    return {
      success: false,
      formVersion: nextFormVersion,
      message: "Relation fields must target an active entity.",
      errors: {
        _form: "Archived entities cannot be used as new relation targets.",
      },
      entity: {
        name: validation.definition.name,
        description: validation.definition.description,
      },
      fields: validation.definition.fields,
    };
  }

  let entityTypeId: string;

  try {
    entityTypeId = await createEntityTypeWithFields({
      workspaceId,
      name: validation.definition.name,
      description: validation.definition.description,
      fields: validation.definition.fields.map((field) => ({
        name: field.name,
        type: field.type,
        relatedEntityTypeId: field.relatedEntityTypeId,
        required: field.required,
      })),
    });
  } catch {
    return {
      success: false,
      formVersion: nextFormVersion,
      message: "Unable to create the entity type. Please try again.",
      errors: {
        _form: "The database rejected the entity definition.",
      },
      entity: {
        name: validation.definition.name,
        description: validation.definition.description,
      },
      fields: validation.definition.fields,
    };
  }

  revalidatePath("/");
  revalidatePath("/entities");
  redirect(`/entities/${entityTypeId}`);
}

export async function createWorkspaceStarterStructure(
  _previousState: WorkspaceSetupFormState,
  formData: FormData,
): Promise<WorkspaceSetupFormState> {
  const selectedOptionIds = parseStarterOptionIds(formData.getAll("starterOption"));

  if (selectedOptionIds.length === 0) {
    return {
      success: false,
      message: "Choose at least one starting structure.",
      selectedOptionIds,
    };
  }

  const { workspaceId } = await getActiveWorkspaceId();
  const existingEntities = await listEntityTypes({
    workspaceId,
    includeArchived: true,
  });

  if (existingEntities.length > 0) {
    return {
      success: false,
      message: "Workspace setup is only available before any entity has been created.",
      selectedOptionIds,
    };
  }

  try {
    await createEntityTypesWithFieldsAuthorized({
      workspaceId,
      entities: buildStarterEntities(selectedOptionIds),
    });
  } catch {
    return {
      success: false,
      message: "Unable to create the workspace structure. No changes were saved.",
      selectedOptionIds,
    };
  }

  revalidatePath("/");

  return {
    success: true,
    message: "Workspace structure created.",
    selectedOptionIds,
  };
}

export async function addFieldDefinition(
  context: CreateRecordContext,
  _previousState: FieldDefinitionFormState,
  formData: FormData,
): Promise<FieldDefinitionFormState> {
  const validation = validateFieldDefinitionFormData(formData);

  if (!validation.success) {
    return validation.state;
  }

  const { entityType } = await getEntityContext(context);

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before adding fields.",
      errors: {
        _form: "Archived entities are read-only.",
      },
      values: validation.field,
    };
  }

  const inactiveRelationTarget = await findInactiveRelationTarget(
    context.workspaceId,
    [validation.field],
  );

  if (inactiveRelationTarget) {
    return {
      success: false,
      message: "Relation fields must target an active entity.",
      errors: {
        fieldRelatedEntityTypeId:
          "Archived entities cannot be used as new relation targets.",
      },
      values: validation.field,
    };
  }

  if (validation.field.required) {
    const recordCount = await countEntityRecords(context);

    if (recordCount > 0) {
      return {
        success: false,
        message:
          "Required fields can only be added before this entity has records.",
        errors: {
          fieldRequired:
            "Add this field as optional, or add required fields before creating records.",
        },
        values: validation.field,
      };
    }
  }

  try {
    await createFieldDefinition({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      name: validation.field.name,
      type: validation.field.type,
      relatedEntityTypeId: validation.field.relatedEntityTypeId,
      required: validation.field.required,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (
      validation.field.required &&
      message.includes(
        "Required fields can only be added before this entity has records",
      )
    ) {
      return {
        success: false,
        message:
          "Required fields can only be added before this entity has records.",
        errors: {
          fieldRequired:
            "Add this field as optional, or add required fields before creating records.",
        },
        values: validation.field,
      };
    }

    return {
      success: false,
      message: "Unable to add the field. Please try again.",
      errors: {
        _form: "The database rejected the field definition.",
      },
      values: validation.field,
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    ...initialFieldDefinitionFormState,
    success: true,
    message: "Field added.",
  };
}

export async function updateFieldDefinition(
  context: UpdateFieldDefinitionContext,
  _previousState: FieldEditFormState,
  formData: FormData,
): Promise<FieldEditFormState> {
  const validation = validateFieldEditFormData(formData);

  if (!validation.success) {
    return validation.state;
  }

  const { entityType, fields } = await getEntityContext({
    ...context,
    includeArchivedFields: true,
  });
  const field = fields.find(
    (candidateField) => candidateField.id === context.fieldDefinitionId,
  );

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before editing fields.",
      errors: {
        _form: "Archived entities are read-only.",
      },
      values: validation.values,
    };
  }

  if (!field || field.archivedAt) {
    return {
      success: false,
      message: "Archived fields cannot be edited. Restore this field first.",
      errors: {
        _form: "Archived fields are read-only.",
      },
      values: validation.values,
    };
  }

  try {
    const result = await updateFieldDefinitionInRepository({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      fieldDefinitionId: context.fieldDefinitionId,
      name: validation.values.name,
      required: validation.values.required,
    });

    if (result.violationCount > 0) {
      return {
        success: false,
        message: "This field cannot be required yet.",
        errors: {
          fieldRequired: `${result.violationCount} existing record${
            result.violationCount === 1 ? " is" : "s are"
          } missing a valid value for this field.`,
        },
        values: validation.values,
      };
    }
  } catch {
    return {
      success: false,
      message: "Unable to update the field. Please try again.",
      errors: {
        _form: "The database rejected the field update.",
      },
      values: validation.values,
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Field updated.",
    errors: {},
    values: validation.values,
  };
}

export async function archiveField(
  context: UpdateFieldDefinitionContext,
  previousState: FieldLifecycleActionState,
  formData: FormData,
): Promise<FieldLifecycleActionState> {
  void previousState;
  void formData;

  try {
    const { entityType } = await getEntityContext(context);

    if (entityType.archivedAt) {
      return {
        success: false,
        message: "Archived entities are read-only. Restore this entity before editing fields.",
      };
    }

    if (entityType.displayFieldDefinitionId === context.fieldDefinitionId) {
      return {
        success: false,
        message: `This field is used as the display field for ${entityType.name}. Choose another display field before archiving it.`,
      };
    }

    await archiveFieldDefinition(context);
  } catch {
    return {
      success: false,
      message: "Unable to archive the field. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Field archived.",
  };
}

export async function restoreField(
  context: UpdateFieldDefinitionContext,
  previousState: FieldLifecycleActionState,
  formData: FormData,
): Promise<FieldLifecycleActionState> {
  void previousState;
  void formData;

  try {
    const { entityType } = await getEntityContext({
      ...context,
      includeArchivedFields: true,
    });

    if (entityType.archivedAt) {
      return {
        success: false,
        message: "Archived entities are read-only. Restore this entity before editing fields.",
      };
    }

    await restoreFieldDefinition(context);
  } catch {
    return {
      success: false,
      message: "Unable to restore the field. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Field restored.",
  };
}

function formatFieldTypeLabel(type: string) {
  return type === "relation"
    ? "Relation"
    : `${type[0].toUpperCase()}${type.slice(1)}`;
}

function formatFieldDeleteBlockMessage({
  entityName,
  field,
  recordValueCount,
  relationValueCount,
  workflowReferenceCount,
  displayFieldReferenceCount,
  viewReferenceCount,
}: {
  entityName: string;
  field: Awaited<ReturnType<typeof getEntityContext>>["fields"][number];
  recordValueCount: number;
  relationValueCount: number;
  workflowReferenceCount: number;
  displayFieldReferenceCount: number;
  viewReferenceCount: number;
}) {
  const reasons = [];

  if (displayFieldReferenceCount > 0) {
    reasons.push(`configured as the display field for ${entityName}`);
  }

  if (recordValueCount > 0) {
    reasons.push(
      `${recordValueCount} record value${
        recordValueCount === 1 ? "" : "s"
      } stored under this field key`,
    );
  }

  if (relationValueCount > 0) {
    reasons.push(
      `${relationValueCount} relation value${
        relationValueCount === 1 ? "" : "s"
      }`,
    );
  }

  if (workflowReferenceCount > 0) {
    reasons.push(
      `${workflowReferenceCount} workflow reference${
        workflowReferenceCount === 1 ? "" : "s"
      }`,
    );
  }

  if (viewReferenceCount > 0) {
    reasons.push(
      `${viewReferenceCount} saved view reference${
        viewReferenceCount === 1 ? "" : "s"
      }`,
    );
  }

  return `Cannot delete ${entityName} → ${field.name} (${formatFieldTypeLabel(
    field.type,
  )}, field ${field.position}) because it is ${reasons.join(", ")}.`;
}

async function validateViewSubmission(context: EntityViewContext, formData: FormData) {
  const [activeContext, managementContext] = await Promise.all([
    getEntityContext(context),
    getEntityContext({
      ...context,
      includeArchivedFields: true,
    }),
  ]);
  const validation = await validateViewFormData({
    activeFields: activeContext.fields,
    allFields: managementContext.fields,
    formData,
    validateRelationValue: async (field, value) => {
      if (!field.relatedEntityTypeId) {
        return false;
      }

      return entityRecordExists({
        workspaceId: context.workspaceId,
        entityTypeId: field.relatedEntityTypeId,
        recordId: value,
        includeArchived: true,
      });
    },
  });

  return {
    entityType: activeContext.entityType,
    validation,
  };
}

export async function createView(
  context: EntityViewContext,
  _previousState: ViewFormState,
  formData: FormData,
): Promise<ViewFormState> {
  const { entityType, validation } = await validateViewSubmission(
    context,
    formData,
  );

  if (!validation.success) {
    return validation;
  }

  try {
    await createEntityView({
      ...context,
      ...validation.values,
    });
  } catch {
    return {
      ...validation,
      success: false,
      message: "Unable to create view. Please try again.",
      errors: {
        _form: "The database rejected the view.",
      },
    };
  }

  revalidatePath(`/entities/${entityType.id}`);

  return {
    ...createInitialViewFormState(validation.values),
    success: true,
    message: "View created.",
  };
}

export async function updateView(
  context: EntityViewContext,
  _previousState: ViewFormState,
  formData: FormData,
): Promise<ViewFormState> {
  const { entityType, validation } = await validateViewSubmission(
    context,
    formData,
  );

  if (!validation.success) {
    return validation;
  }

  try {
    await updateEntityView({
      ...context,
      ...validation.values,
    });
  } catch {
    return {
      ...validation,
      success: false,
      message: "Unable to update view. Please try again.",
      errors: {
        _form: "The database rejected the view.",
      },
    };
  }

  revalidatePath(`/entities/${entityType.id}`);

  return {
    ...createInitialViewFormState(validation.values),
    success: true,
    message: "View updated.",
  };
}

export async function deleteView(
  context: EntityViewContext,
  previousState: DeleteViewActionState,
  formData: FormData,
): Promise<DeleteViewActionState> {
  void previousState;
  void formData;

  if (!context.viewId) {
    return {
      success: false,
      message: "Unable to delete view. Please try again.",
    };
  }

  try {
    await deleteEntityView({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      viewId: context.viewId,
    });
  } catch {
    return {
      success: false,
      message: "Unable to delete view. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "View deleted.",
  };
}

export async function deleteField(
  context: UpdateFieldDefinitionContext,
  previousState: FieldLifecycleActionState,
  formData: FormData,
): Promise<FieldLifecycleActionState> {
  void previousState;
  void formData;

  try {
    const { entityType, fields } = await getEntityContext({
      ...context,
      includeArchivedFields: true,
    });
    const field = fields.find(
      (candidateField) => candidateField.id === context.fieldDefinitionId,
    );

    if (entityType.archivedAt) {
      return {
        success: false,
        message: "Archived entities are read-only. Restore this entity before editing fields.",
      };
    }

    if (!field?.archivedAt) {
      return {
        success: false,
        message: "Archive this field before permanently deleting it.",
      };
    }

    const result = await deleteFieldDefinition(context);

    if (!result.deleted) {
      return {
        success: false,
        message: formatFieldDeleteBlockMessage({
          entityName: entityType.name,
          field,
          ...result,
        }),
      };
    }
  } catch {
    return {
      success: false,
      message: "Unable to delete the field. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);

  return {
    success: true,
    message: "Field permanently deleted.",
  };
}

export async function updateEntityMetadata(
  context: EntityTypeContext,
  _previousState: EntityMetadataFormState,
  formData: FormData,
): Promise<EntityMetadataFormState> {
  const validation = validateEntityMetadataFormData(formData);

  if (!validation.success) {
    return validation.state;
  }

  const { entityType, fields } = await getEntityContext(context);

  if (entityType.archivedAt) {
    return {
      success: false,
      message: "Archived entities are read-only. Restore this entity before editing settings.",
      errors: {
        _form: "Archived entities are read-only.",
      },
      values: validation.values,
    };
  }

  const displayFieldDefinitionId = validation.values.displayFieldDefinitionId;
  const displayField = displayFieldDefinitionId
    ? fields.find((field) => field.id === displayFieldDefinitionId)
    : undefined;

  if (
    displayFieldDefinitionId &&
    (!displayField || displayField.archivedAt || displayField.type !== "text")
  ) {
    return {
      success: false,
      message: "Please fix the highlighted fields.",
      errors: {
        displayFieldDefinitionId:
          "Choose an active text field, or choose no display field.",
      },
      values: validation.values,
    };
  }

  try {
    await updateEntityTypeMetadata({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      name: validation.values.name,
      description: validation.values.description,
    });
    await setEntityDisplayField({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      displayFieldDefinitionId,
    });
  } catch {
    return {
      success: false,
      message: "Unable to update the entity. Please try again.",
      errors: {
        _form: "The database rejected the entity update.",
      },
      values: validation.values,
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);
  revalidatePath("/");

  return {
    success: true,
    message: "Entity updated.",
    errors: {},
    values: validation.values,
  };
}

export async function archiveEntity(
  context: EntityTypeContext,
  previousState: EntityTypeActionState,
  formData: FormData,
): Promise<EntityTypeActionState> {
  void previousState;
  void formData;

  try {
    await archiveEntityType(context);
  } catch {
    return {
      success: false,
      message: "Unable to archive the entity. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);
  revalidatePath("/");

  return {
    success: true,
    message: "Entity archived.",
  };
}

export async function restoreEntity(
  context: EntityTypeContext,
  previousState: EntityTypeActionState,
  formData: FormData,
): Promise<EntityTypeActionState> {
  void previousState;
  void formData;

  try {
    await restoreEntityType(context);
  } catch {
    return {
      success: false,
      message: "Unable to restore the entity. Please try again.",
    };
  }

  revalidatePath(`/entities/${context.entityTypeId}`);
  revalidatePath("/");

  return {
    success: true,
    message: "Entity restored.",
  };
}

function formatEntityDeleteBlockMessage({
  entityName,
  recordCount,
  relationFieldCount,
  relationReferences,
  workflowTargetCount,
  workflowReferences,
}: {
  entityName: string;
  recordCount: number;
  relationFieldCount: number;
  relationReferences: Array<{
    entityTypeName: string;
    fieldName: string;
  }>;
  workflowTargetCount: number;
  workflowReferences: Array<{ workflowName: string }>;
}) {
  if (recordCount > 0) {
    return `Cannot delete ${entityName} because it contains ${recordCount} record${
      recordCount === 1 ? "" : "s"
    }.`;
  }

  if (relationFieldCount > 0) {
    const referenceNames = relationReferences
      .slice(0, 3)
      .map((reference) => `${reference.entityTypeName}.${reference.fieldName}`)
      .join(", ");

    return `Cannot delete ${entityName} because ${relationFieldCount} relation field${
      relationFieldCount === 1 ? "" : "s"
    } reference it${referenceNames ? `: ${referenceNames}` : ""}.`;
  }

  const workflowNames = workflowReferences
    .slice(0, 3)
    .map((reference) => reference.workflowName)
    .join(", ");

  return `Cannot delete ${entityName} because ${workflowTargetCount} workflow${
    workflowTargetCount === 1 ? "" : "s"
  } create${workflowTargetCount === 1 ? "s" : ""} records in it${
    workflowNames ? `: ${workflowNames}` : ""
  }.`;
}

export async function deleteEntity(
  context: EntityTypeContext,
  previousState: EntityTypeActionState,
  formData: FormData,
): Promise<EntityTypeActionState> {
  void previousState;
  void formData;

  const { entityType } = await getEntityContext(context);

  try {
    const result = await deleteEntityType(context);

    if (!result.deleted) {
      const relationSummary =
        result.relationFieldCount > 0
          ? await getEntityTypeRelationFieldSummary(context)
          : { references: [] };
      const workflowSummary =
        result.workflowTargetCount > 0
          ? await getEntityTypeWorkflowTargetSummary(context)
          : { references: [] };

      return {
        success: false,
        message: formatEntityDeleteBlockMessage({
          entityName: entityType.name,
          recordCount: result.recordCount,
          relationFieldCount: result.relationFieldCount,
          relationReferences: relationSummary.references,
          workflowTargetCount: result.workflowTargetCount,
          workflowReferences: workflowSummary.references,
        }),
      };
    }
  } catch {
    return {
      success: false,
      message: "Unable to delete the entity. Please try again.",
    };
  }

  revalidatePath("/");
  revalidatePath("/entities");
  redirect("/");
}

export async function createWorkflow(
  previousState: WorkflowFormState,
  formData: FormData,
): Promise<WorkflowFormState> {
  const { workspaceId } = await getActiveWorkspaceId();
  const nextFormVersion = previousState.formVersion + 1;
  const activeEntityTypes = await listEntityTypes({
    workspaceId,
  });
  const activeEntityContexts = await Promise.all(
    activeEntityTypes.map((entityType) =>
      getEntityContext({
        workspaceId,
        entityTypeId: entityType.id,
      }),
    ),
  );
  const validation = await validateWorkflowFormData({
    formData,
    formVersion: nextFormVersion,
    activeEntityContexts,
    validateConstantRelationValue: async (field, value) => {
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

  if (!validation.success) {
    return validation.state;
  }

  try {
    await createWorkflowDefinition({
      workspaceId,
      name: validation.workflow.name,
      enabled: validation.workflow.enabled,
      triggerType: validation.workflow.triggerType,
      triggerEntityTypeId: validation.workflow.triggerEntityTypeId,
      triggerConfig: validation.workflow.triggerConfig,
      conditions: validation.workflow.conditions,
      actions: validation.workflow.actions,
    });
  } catch {
    return {
      ...validation.state,
      success: false,
      formVersion: nextFormVersion,
      message: "Unable to create the workflow. Please try again.",
      errors: {
        _form: "The database rejected the workflow.",
      },
    };
  }

  revalidatePath("/workflows");
  redirect("/workflows");
}

export async function updateWorkflow(
  context: {
    workflowId: string;
  },
  previousState: WorkflowFormState,
  formData: FormData,
): Promise<WorkflowFormState> {
  const { workspaceId } = await getActiveWorkspaceId();
  const nextFormVersion = previousState.formVersion + 1;
  const activeEntityTypes = await listEntityTypes({
    workspaceId,
  });
  const activeEntityContexts = await Promise.all(
    activeEntityTypes.map((entityType) =>
      getEntityContext({
        workspaceId,
        entityTypeId: entityType.id,
        includeArchivedFields: true,
      }),
    ),
  );
  const validation = await validateWorkflowFormData({
    formData,
    formVersion: nextFormVersion,
    activeEntityContexts,
    validateConstantRelationValue: async (field, value) => {
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

  if (!validation.success) {
    return validation.state;
  }

  try {
    await updateWorkflowDefinition({
      workspaceId,
      workflowId: context.workflowId,
      name: validation.workflow.name,
      enabled: validation.workflow.enabled,
      triggerType: validation.workflow.triggerType,
      triggerEntityTypeId: validation.workflow.triggerEntityTypeId,
      triggerConfig: validation.workflow.triggerConfig,
      conditions: validation.workflow.conditions,
      actions: validation.workflow.actions,
    });
  } catch {
    return {
      ...validation.state,
      success: false,
      formVersion: nextFormVersion,
      message: "Unable to update the workflow. Please try again.",
      errors: {
        _form: "The database rejected the workflow update.",
      },
    };
  }

  revalidatePath("/workflows");
  redirect("/workflows");
}

export async function enableWorkflow(
  context: {
    workflowId: string;
  },
  previousState: WorkflowActionState,
  formData: FormData,
): Promise<WorkflowActionState> {
  const { workspaceId } = await getActiveWorkspaceId();
  void previousState;
  void formData;

  try {
    await setWorkflowEnabled({
      workspaceId,
      workflowId: context.workflowId,
      enabled: true,
    });
  } catch {
    return {
      success: false,
      message: "Unable to enable the workflow.",
    };
  }

  revalidatePath("/workflows");

  return {
    success: true,
    message: "Workflow enabled.",
  };
}

export async function disableWorkflow(
  context: {
    workflowId: string;
  },
  previousState: WorkflowActionState,
  formData: FormData,
): Promise<WorkflowActionState> {
  const { workspaceId } = await getActiveWorkspaceId();
  void previousState;
  void formData;

  try {
    await setWorkflowEnabled({
      workspaceId,
      workflowId: context.workflowId,
      enabled: false,
    });
  } catch {
    return {
      success: false,
      message: "Unable to disable the workflow.",
    };
  }

  revalidatePath("/workflows");

  return {
    success: true,
    message: "Workflow disabled.",
  };
}

export async function deleteWorkflow(
  context: {
    workflowId: string;
  },
  previousState: WorkflowActionState,
  formData: FormData,
): Promise<WorkflowActionState> {
  const { workspaceId } = await getActiveWorkspaceId();
  void previousState;
  void formData;

  try {
    await deleteWorkflowDefinition({
      workspaceId,
      workflowId: context.workflowId,
    });
  } catch {
    return {
      success: false,
      message: "Unable to delete the workflow.",
    };
  }

  revalidatePath("/workflows");

  return {
    success: true,
    message: "Workflow deleted.",
  };
}

export async function getWorkflowFormState(workflowId: string) {
  const { workspaceId } = await getActiveWorkspaceId();
  const workflow = await getWorkflow({
    workspaceId,
    workflowId,
  });
  const activeEntityTypes = await listEntityTypes({
    workspaceId,
  });
  const activeEntityContexts = await Promise.all(
    activeEntityTypes.map((entityType) =>
      getEntityContext({
        workspaceId,
        entityTypeId: entityType.id,
        includeArchivedFields: true,
      }),
    ),
  );
  const sourceEntityContext = activeEntityContexts.find(
    (context) => context.entityType.id === workflow.triggerEntityTypeId,
  );

  return createWorkflowFormStateFromDefinition({
    workflow,
    sourceEntityContext,
    entityNameById: Object.fromEntries(
      activeEntityContexts.map((context) => [
        context.entityType.id,
        context.entityType.name,
      ]),
    ),
  });
}
