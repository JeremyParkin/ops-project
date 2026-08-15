"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DEMO_WORKSPACE_ID } from "@/lib/domain/demo-ids";
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
  archiveEntityType,
  createFieldDefinition,
  createEntityTypeWithFields,
  deleteEntityType,
  getEntityTypeRelationFieldSummary,
  getEntityContext,
  listEntityTypes,
  restoreEntityType,
  updateEntityTypeMetadata,
  updateFieldDefinition as updateFieldDefinitionInRepository,
} from "@/lib/domain/metadata-repository";
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

type CreateRecordContext = {
  workspaceId: string;
  entityTypeId: string;
};

type EntityTypeContext = CreateRecordContext;

type UpdateRecordContext = CreateRecordContext & {
  recordId: string;
};

type UpdateFieldDefinitionContext = CreateRecordContext & {
  fieldDefinitionId: string;
};

export type EntityTypeActionState = {
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

  try {
    await createEntityRecord({
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

  revalidatePath(`/entities/${entityType.id}`);

  return {
    ...initialRecordFormState,
    success: true,
    message: `${entityType.name} created.`,
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

  revalidatePath(`/entities/${entityType.id}`);
  redirect(`/entities/${entityType.id}`);
}

export async function createEntityDefinition(
  previousState: EntityDefinitionFormState,
  formData: FormData,
): Promise<EntityDefinitionFormState> {
  const nextFormVersion = previousState.formVersion + 1;
  const validation = validateEntityDefinitionFormData(formData, nextFormVersion);

  if (!validation.success) {
    return validation.state;
  }

  const inactiveRelationTarget = await findInactiveRelationTarget(
    DEMO_WORKSPACE_ID,
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
      workspaceId: DEMO_WORKSPACE_ID,
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
  } catch {
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

  const { entityType } = await getEntityContext(context);

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

export async function updateEntityMetadata(
  context: EntityTypeContext,
  _previousState: EntityMetadataFormState,
  formData: FormData,
): Promise<EntityMetadataFormState> {
  const validation = validateEntityMetadataFormData(formData);

  if (!validation.success) {
    return validation.state;
  }

  const { entityType } = await getEntityContext(context);

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

  try {
    await updateEntityTypeMetadata({
      workspaceId: context.workspaceId,
      entityTypeId: context.entityTypeId,
      name: validation.values.name,
      description: validation.values.description,
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
  references,
}: {
  entityName: string;
  recordCount: number;
  relationFieldCount: number;
  references: Array<{
    entityTypeName: string;
    fieldName: string;
  }>;
}) {
  if (recordCount > 0) {
    return `Cannot delete ${entityName} because it contains ${recordCount} record${
      recordCount === 1 ? "" : "s"
    }.`;
  }

  const referenceNames = references
    .slice(0, 3)
    .map((reference) => `${reference.entityTypeName}.${reference.fieldName}`)
    .join(", ");

  return `Cannot delete ${entityName} because ${relationFieldCount} relation field${
    relationFieldCount === 1 ? "" : "s"
  } reference it${referenceNames ? `: ${referenceNames}` : ""}.`;
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

      return {
        success: false,
        message: formatEntityDeleteBlockMessage({
          entityName: entityType.name,
          recordCount: result.recordCount,
          relationFieldCount: result.relationFieldCount,
          references: relationSummary.references,
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
