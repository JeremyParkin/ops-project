import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  FieldType,
  FieldValue,
} from "./types";
import {
  conditionOperatorNeedsValue,
  getConditionOperatorsForFieldType,
  parseConditionValue,
} from "./workflow-conditions";
import {
  canonicalTemplateToFriendly,
  friendlyTemplateToCanonical,
  parseCanonicalTemplate,
  renderWorkflowTemplate,
} from "./workflow-template";
import type {
  WorkflowActionConfig,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowConditionOperator,
  WorkflowDefinition,
  WorkflowTriggerType,
} from "./workflow-types";

export type WorkflowMappingFormValue = {
  type:
    | "unset"
    | "leave_unchanged"
    | "clear"
    | "constant"
    | "source_field"
    | "template";
  constantValue: string;
  sourceFieldDefinitionId: string;
  template: string;
};

export type WorkflowConditionFormValue = {
  id: string;
  sourceFieldDefinitionId: string;
  operator: WorkflowConditionOperator;
  value: string;
};

export type WorkflowFormState = {
  success: boolean;
  formVersion: number;
  message: string;
  errors: Record<string, string>;
  values: {
    name: string;
    enabled: boolean;
    triggerType: WorkflowTriggerType;
    triggerEntityTypeId: string;
    actionType: WorkflowActionType;
    actionTargetEntityTypeId: string;
    relatedFieldDefinitionId: string;
    watchedFieldDefinitionIds: string[];
    conditions: WorkflowConditionFormValue[];
    mappings: Record<string, WorkflowMappingFormValue>;
  };
};

export type EntityFieldContext = {
  entityType: EntityType;
  fields: FieldDefinition[];
};

const createMappingTypes = new Set([
  "unset",
  "constant",
  "source_field",
  "template",
]);
const updateMappingTypes = new Set([
  "leave_unchanged",
  "clear",
  "constant",
  "source_field",
  "template",
]);

export const initialWorkflowFormState: WorkflowFormState = {
  success: false,
  formVersion: 0,
  message: "",
  errors: {},
  values: {
    name: "",
    enabled: true,
    triggerType: "record_created",
    triggerEntityTypeId: "",
    actionType: "create_record",
    actionTargetEntityTypeId: "",
    relatedFieldDefinitionId: "",
    watchedFieldDefinitionIds: [],
    conditions: [],
    mappings: {},
  },
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" ? value.trim() : "";
}

function getLastString(formData: FormData, key: string) {
  const values = formData.getAll(key);
  const value = values.at(-1);

  return typeof value === "string" ? value.trim() : "";
}

function getConditionRows(formData: FormData) {
  return formData
    .getAll("conditionId")
    .filter((value): value is string => typeof value === "string")
    .map((id) => {
      return {
        id,
        sourceFieldDefinitionId: getString(
          formData,
          `conditionField:${id}`,
        ),
        operator: getString(
          formData,
          `conditionOperator:${id}`,
        ) as WorkflowConditionOperator,
        value: getString(formData, `conditionValue:${id}`),
      };
    });
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

export function areFieldsCompatible(
  sourceField: FieldDefinition,
  targetField: FieldDefinition,
) {
  if (sourceField.type !== targetField.type) {
    return false;
  }

  if (sourceField.type !== "relation") {
    return true;
  }

  return sourceField.relatedEntityTypeId === targetField.relatedEntityTypeId;
}

function parseConstantValue(
  targetField: FieldDefinition,
  rawValue: string,
): { value: FieldValue } | { error: string } {
  if (rawValue === "") {
    return {
      error: targetField.required
        ? `${targetField.name} is required. Provide a value.`
        : `${targetField.name} needs a constant value or choose Unset.`,
    };
  }

  switch (targetField.type) {
    case "text":
      return { value: rawValue };
    case "number": {
      const value = Number(rawValue);

      if (Number.isNaN(value)) {
        return { error: `${targetField.name} constant must be a number.` };
      }

      return { value };
    }
    case "date":
      if (!isValidDate(rawValue)) {
        return { error: `${targetField.name} constant must be a valid date.` };
      }

      return { value: rawValue };
    case "boolean":
      if (rawValue === "true") {
        return { value: true };
      }

      if (rawValue === "false") {
        return { value: false };
      }

      return { error: `${targetField.name} constant must be true or false.` };
    case "relation":
      return { value: rawValue };
  }
}

function getFieldTypeLabel(type: FieldType) {
  return type === "relation" ? "linked-record" : type;
}

function getArchivedFieldError(field: FieldDefinition) {
  return `${field.name} is archived and cannot be used in workflow configuration.`;
}

export async function validateWorkflowFormData({
  formData,
  formVersion,
  activeEntityContexts,
  validateConstantRelationValue,
}: {
  formData: FormData;
  formVersion: number;
  activeEntityContexts: EntityFieldContext[];
  validateConstantRelationValue: (
    field: FieldDefinition,
    value: string,
  ) => Promise<boolean>;
}): Promise<
  | {
      success: true;
      workflow: {
        name: string;
        enabled: boolean;
        triggerType: WorkflowTriggerType;
        triggerEntityTypeId: string;
        actionType: WorkflowActionType;
        actionTargetEntityTypeId?: string;
        actionConfig: WorkflowActionConfig;
      };
      state: WorkflowFormState;
    }
  | {
      success: false;
      state: WorkflowFormState;
    }
> {
  const entityContextById = new Map(
    activeEntityContexts.map((context) => [context.entityType.id, context]),
  );
  const entityNameById = Object.fromEntries(
    activeEntityContexts.map((context) => [
      context.entityType.id,
      context.entityType.name,
    ]),
  );
  const name = getString(formData, "workflowName");
  const enabled = getLastString(formData, "workflowEnabled") !== "false";
  const rawTriggerType = getString(formData, "workflowTriggerType");
  const triggerType: WorkflowTriggerType =
    rawTriggerType === "record_updated" ? "record_updated" : "record_created";
  const rawActionType = getString(formData, "workflowActionType");
  const actionType: WorkflowActionType =
    rawActionType === "update_record" || rawActionType === "update_related_record"
      ? rawActionType
      : "create_record";
  const triggerEntityTypeId = getString(formData, "triggerEntityTypeId");
  const actionTargetEntityTypeId =
    actionType === "create_record"
      ? getString(formData, "actionTargetEntityTypeId")
      : "";
  const relatedFieldDefinitionId = getString(
    formData,
    "relatedFieldDefinitionId",
  );
  const triggerContext = entityContextById.get(triggerEntityTypeId);
  const relatedField = triggerContext?.fields.find(
    (field) => field.id === relatedFieldDefinitionId,
  );
  const targetContext =
    actionType === "create_record"
      ? entityContextById.get(actionTargetEntityTypeId)
      : actionType === "update_related_record" && relatedField?.relatedEntityTypeId
        ? entityContextById.get(relatedField.relatedEntityTypeId)
        : triggerContext;
  const errors: Record<string, string> = {};
  const conditionRows = getConditionRows(formData);
  const mappings: WorkflowFormState["values"]["mappings"] = {};

  if (!name) {
    errors.workflowName = "Workflow name is required.";
  }

  if (!triggerContext) {
    errors.triggerEntityTypeId = "Choose an active trigger entity.";
  }

  if (actionType === "create_record" && !targetContext) {
    errors.actionTargetEntityTypeId = "Choose an active target entity.";
  }

  if (actionType === "update_related_record") {
    if (!relatedField || relatedField.entityTypeId !== triggerEntityTypeId) {
      errors.relatedFieldDefinitionId = "Choose a relation field on the trigger entity.";
    } else if (relatedField.archivedAt) {
      errors.relatedFieldDefinitionId = getArchivedFieldError(relatedField);
    } else if (relatedField.type !== "relation" || !relatedField.relatedEntityTypeId) {
      errors.relatedFieldDefinitionId = "Choose a relation field on the trigger entity.";
    } else if (!targetContext) {
      errors.relatedFieldDefinitionId = "The related entity must be active.";
    }
  }

  const configMappings: WorkflowActionConfig["fieldMappings"] = [];
  const configConditions: WorkflowCondition[] = [];
  const submittedWatchedFieldDefinitionIds = formData
    .getAll("watchedFieldDefinitionId")
    .filter((value): value is string => typeof value === "string");
  const watchedFieldDefinitionIds =
    triggerType === "record_updated" ? submittedWatchedFieldDefinitionIds : [];

  if (triggerContext && targetContext) {
    const sourceFieldById = new Map(
      triggerContext.fields.map((field) => [field.id, field]),
    );
    const allTargetFieldIds = new Set(
      targetContext.fields.map((field) => field.id),
    );
    const submittedTargetFieldDefinitionIds = formData
      .getAll("targetFieldDefinitionId")
      .filter((value): value is string => typeof value === "string");
    const submittedTargetFieldIds =
      submittedTargetFieldDefinitionIds.length > 0
        ? submittedTargetFieldDefinitionIds
        : targetContext.fields
            .filter((field) => !field.archivedAt)
            .map((field) => field.id);
    const targetFieldIds = new Set(submittedTargetFieldIds);

    for (const key of formData.keys()) {
      const [prefix, fieldId] = key.split(":");

      if (
        [
          "mappingType",
          "constantValue",
          "sourceFieldDefinitionId",
          "templateValue",
        ].includes(prefix) &&
        fieldId &&
        !allTargetFieldIds.has(fieldId)
      ) {
        errors._form = "The workflow included an unknown target field.";
      }
    }

    for (const targetFieldId of submittedTargetFieldIds) {
      if (!allTargetFieldIds.has(targetFieldId)) {
        errors._form = "The workflow included an unknown target field.";
      }
    }

    if (triggerType === "record_updated") {
      const watchedFieldIds = new Set(watchedFieldDefinitionIds);

      if (watchedFieldIds.size === 0) {
        errors.watchedFieldDefinitionIds =
          "Choose at least one field to watch for updates.";
      }

      if (watchedFieldIds.size !== watchedFieldDefinitionIds.length) {
        errors.watchedFieldDefinitionIds =
          "Watched fields cannot contain duplicates.";
      }

      for (const watchedFieldDefinitionId of watchedFieldDefinitionIds) {
        const watchedField = sourceFieldById.get(watchedFieldDefinitionId);

        if (!watchedField) {
          errors.watchedFieldDefinitionIds =
            "Watched fields must belong to the trigger entity.";
        } else if (watchedField.archivedAt) {
          errors.watchedFieldDefinitionIds =
            "Watched fields cannot include archived fields.";
        }
      }
    }

    for (const condition of conditionRows) {
      const sourceField = sourceFieldById.get(condition.sourceFieldDefinitionId);

      if (!sourceField) {
        errors[`conditionField:${condition.id}`] =
          "Choose a trigger field for this condition.";
        continue;
      }

      if (sourceField.archivedAt) {
        errors[`conditionField:${condition.id}`] =
          getArchivedFieldError(sourceField);
        continue;
      }

      const validOperators = getConditionOperatorsForFieldType(sourceField.type);
      const operator = validOperators.includes(condition.operator)
        ? condition.operator
        : validOperators[0];
      const parsedValue = parseConditionValue({
        field: sourceField,
        operator,
        rawValue: condition.value,
      });

      if ("error" in parsedValue) {
        errors[`conditionValue:${condition.id}`] = parsedValue.error;
        continue;
      }

      if (
        sourceField.type === "relation" &&
        conditionOperatorNeedsValue(operator) &&
        typeof parsedValue.value === "string" &&
        !(await validateConstantRelationValue(sourceField, parsedValue.value))
      ) {
        errors[`conditionValue:${condition.id}`] =
          `${sourceField.name} must reference an active record.`;
        continue;
      }

      configConditions.push({
        sourceFieldDefinitionId: sourceField.id,
        operator,
        ...("value" in parsedValue ? { value: parsedValue.value } : {}),
      });
    }

    for (const targetFieldId of targetFieldIds) {
      const targetField = targetContext.fields.find(
        (field) => field.id === targetFieldId,
      );

      if (!targetField) {
        continue;
      }

      const rawMappingType = getString(formData, `mappingType:${targetField.id}`);
      const validMappingTypes =
        actionType === "update_record" || actionType === "update_related_record"
          ? updateMappingTypes
          : createMappingTypes;
      const defaultMappingType =
        actionType === "update_record" || actionType === "update_related_record"
          ? "leave_unchanged"
          : targetField.required
            ? "constant"
            : "unset";
      const mappingType = validMappingTypes.has(rawMappingType)
        ? (rawMappingType as WorkflowMappingFormValue["type"])
        : defaultMappingType;
      const constantValue = getString(
        formData,
        `constantValue:${targetField.id}`,
      );
      const sourceFieldDefinitionId = getString(
        formData,
        `sourceFieldDefinitionId:${targetField.id}`,
      );
      const template = getString(formData, `templateValue:${targetField.id}`);

      mappings[targetField.id] = {
        type: mappingType,
        constantValue,
        sourceFieldDefinitionId,
        template,
      };

      if (targetField.archivedAt) {
        errors[`mappingType:${targetField.id}`] =
          getArchivedFieldError(targetField);
        continue;
      }

      if (mappingType === "unset") {
        if (actionType === "update_record" || actionType === "update_related_record") {
          errors[`mappingType:${targetField.id}`] =
            `${targetField.name} cannot use Unset for an update action. Choose Leave unchanged or Clear value.`;
          continue;
        }

        if (targetField.required) {
          errors[`mappingType:${targetField.id}`] =
            `${targetField.name} is required and cannot be unset.`;
        }

        configMappings.push({
          targetFieldDefinitionId: targetField.id,
          source: {
            type: "unset",
          },
        });
        continue;
      }

      if (mappingType === "leave_unchanged") {
        if (actionType !== "update_record" && actionType !== "update_related_record") {
          errors[`mappingType:${targetField.id}`] =
            `${targetField.name} cannot use Leave unchanged for a create action.`;
          continue;
        }

        configMappings.push({
          targetFieldDefinitionId: targetField.id,
          source: {
            type: "leave_unchanged",
          },
        });
        continue;
      }

      if (mappingType === "clear") {
        if (actionType !== "update_record" && actionType !== "update_related_record") {
          errors[`mappingType:${targetField.id}`] =
            `${targetField.name} cannot use Clear value for a create action.`;
        } else if (targetField.required) {
          errors[`mappingType:${targetField.id}`] =
            `${targetField.name} is required and cannot be cleared.`;
        } else {
          configMappings.push({
            targetFieldDefinitionId: targetField.id,
            source: {
              type: "clear",
            },
          });
        }
        continue;
      }

      if (mappingType === "constant") {
        const parsedValue = parseConstantValue(targetField, constantValue);

        if ("error" in parsedValue) {
          errors[`constantValue:${targetField.id}`] = parsedValue.error;
        } else {
          if (
            targetField.type === "relation" &&
            typeof parsedValue.value === "string" &&
            !(await validateConstantRelationValue(targetField, parsedValue.value))
          ) {
            errors[`constantValue:${targetField.id}`] =
              `${targetField.name} must reference an active record.`;
          }

          configMappings.push({
            targetFieldDefinitionId: targetField.id,
            source: {
              type: "constant",
              value: parsedValue.value,
            },
          });
        }
        continue;
      }

      if (mappingType === "template") {
        if (targetField.type !== "text") {
          errors[`mappingType:${targetField.id}`] =
            "Template mappings can only populate text fields.";
          continue;
        }

        const parsedTemplate = friendlyTemplateToCanonical({
          template,
          sourceEntityType: triggerContext.entityType,
          sourceFields: triggerContext.fields,
          entityNameById,
        });

        if (!parsedTemplate.success) {
          errors[`templateValue:${targetField.id}`] = parsedTemplate.error;
        } else if (
          parsedTemplate.referencedSourceFieldIds.some((sourceFieldId) => {
            return Boolean(sourceFieldById.get(sourceFieldId)?.archivedAt);
          })
        ) {
          errors[`templateValue:${targetField.id}`] =
            "Template placeholders cannot reference archived fields.";
        } else {
          configMappings.push({
            targetFieldDefinitionId: targetField.id,
            source: {
              type: "template",
              template: parsedTemplate.canonicalTemplate,
            },
          });
        }
        continue;
      }

      const sourceField = sourceFieldById.get(sourceFieldDefinitionId);

      if (!sourceField) {
        errors[`sourceFieldDefinitionId:${targetField.id}`] =
          `Choose a source field for ${targetField.name}.`;
      } else if (sourceField.archivedAt) {
        errors[`sourceFieldDefinitionId:${targetField.id}`] =
          getArchivedFieldError(sourceField);
      } else if (!areFieldsCompatible(sourceField, targetField)) {
        errors[`sourceFieldDefinitionId:${targetField.id}`] =
          `${sourceField.name} (${getFieldTypeLabel(
            sourceField.type,
          )}) cannot populate ${targetField.name} (${getFieldTypeLabel(
            targetField.type,
          )}).`;
      } else {
        configMappings.push({
          targetFieldDefinitionId: targetField.id,
          source: {
            type: "source_field",
            sourceFieldDefinitionId,
          },
        });
      }
    }

    if (
      actionType === "update_related_record" &&
      configMappings.every((mapping) => mapping.source.type === "leave_unchanged")
    ) {
      errors._form = "Configure at least one field to update.";
    }
  }

  const state: WorkflowFormState = {
    success: false,
    formVersion,
    message: "",
    errors,
    values: {
      name,
      enabled,
      triggerType,
      triggerEntityTypeId,
      actionType,
      actionTargetEntityTypeId,
      relatedFieldDefinitionId,
      watchedFieldDefinitionIds,
      conditions: conditionRows,
      mappings,
    },
  };

  if (Object.keys(errors).length > 0) {
    return {
      success: false,
      state: {
        ...state,
        message: "Please fix the highlighted fields.",
      },
    };
  }

  return {
    success: true,
    workflow: {
      name,
      enabled,
      triggerType,
      triggerEntityTypeId,
      actionType,
      actionTargetEntityTypeId:
        actionType === "create_record" ? actionTargetEntityTypeId : undefined,
      actionConfig: {
        relatedFieldDefinitionId:
          actionType === "update_related_record"
            ? relatedFieldDefinitionId
            : undefined,
        triggerConfig:
          triggerType === "record_updated"
            ? {
                watchedFieldDefinitionIds: [...new Set(watchedFieldDefinitionIds)],
              }
            : undefined,
        conditions: configConditions,
        fieldMappings: configMappings,
      },
    },
    state,
  };
}

export function createWorkflowFormStateFromDefinition({
  workflow,
  sourceEntityContext,
  entityNameById = {},
  formVersion = 0,
}: {
  workflow: WorkflowDefinition;
  sourceEntityContext?: EntityFieldContext;
  entityNameById?: Record<string, string>;
  formVersion?: number;
}): WorkflowFormState {
  return {
    success: false,
    formVersion,
    message: "",
    errors: {},
    values: {
      name: workflow.name,
      enabled: workflow.enabled,
      triggerType: workflow.triggerType,
      triggerEntityTypeId: workflow.triggerEntityTypeId,
      actionType: workflow.actionType,
      actionTargetEntityTypeId: workflow.actionTargetEntityTypeId ?? "",
      relatedFieldDefinitionId:
        workflow.actionConfig.relatedFieldDefinitionId ?? "",
      watchedFieldDefinitionIds:
        workflow.triggerType === "record_updated"
          ? workflow.actionConfig.triggerConfig?.watchedFieldDefinitionIds ?? []
          : [],
      conditions: (workflow.actionConfig.conditions ?? []).map(
        (condition, index) => ({
          id: `condition-${index}`,
          sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
          operator: condition.operator,
          value:
            condition.value === null || condition.value === undefined
              ? ""
              : String(condition.value),
        }),
      ),
      mappings: Object.fromEntries(
        workflow.actionConfig.fieldMappings.map((mapping) => {
          if (mapping.source.type === "unset") {
            return [
              mapping.targetFieldDefinitionId,
              {
                type: "unset",
                constantValue: "",
                sourceFieldDefinitionId: "",
                template: "",
              },
            ];
          }

          if (mapping.source.type === "leave_unchanged") {
            return [
              mapping.targetFieldDefinitionId,
              {
                type: "leave_unchanged",
                constantValue: "",
                sourceFieldDefinitionId: "",
                template: "",
              },
            ];
          }

          if (mapping.source.type === "clear") {
            return [
              mapping.targetFieldDefinitionId,
              {
                type: "clear",
                constantValue: "",
                sourceFieldDefinitionId: "",
                template: "",
              },
            ];
          }

          if (mapping.source.type === "constant") {
            return [
              mapping.targetFieldDefinitionId,
              {
                type: "constant",
                constantValue:
                  mapping.source.value === null ||
                  mapping.source.value === undefined
                    ? ""
                    : String(mapping.source.value),
                sourceFieldDefinitionId: "",
                template: "",
              },
            ];
          }

          if (mapping.source.type === "template") {
            return [
              mapping.targetFieldDefinitionId,
              {
                type: "template",
                constantValue: "",
                sourceFieldDefinitionId: "",
                template: sourceEntityContext
                  ? canonicalTemplateToFriendly({
                      template: mapping.source.template,
                      sourceEntityType: sourceEntityContext.entityType,
                      sourceFields: sourceEntityContext.fields,
                      entityNameById,
                    })
                  : mapping.source.template,
              },
            ];
          }

          return [
            mapping.targetFieldDefinitionId,
            {
              type: "source_field",
              constantValue: "",
              sourceFieldDefinitionId: mapping.source.sourceFieldDefinitionId,
              template: "",
            },
          ];
        }),
      ),
    },
  };
}

export async function buildTargetValuesFromWorkflowConfig({
  actionConfig,
  sourceEntityType,
  sourceFields,
  targetFields,
  sourceRecord,
  resolveRelationLabel,
}: {
  actionConfig: WorkflowActionConfig;
  sourceEntityType: EntityType;
  sourceFields: FieldDefinition[];
  targetFields: FieldDefinition[];
  sourceRecord: EntityRecord;
  resolveRelationLabel: (
    field: FieldDefinition,
    recordId: string,
  ) => string | Promise<string>;
}) {
  const sourceFieldById = new Map(sourceFields.map((field) => [field.id, field]));
  const targetFieldById = new Map(targetFields.map((field) => [field.id, field]));
  const values: EntityRecord["values"] = {};

  for (const mapping of actionConfig.fieldMappings) {
    const targetField = targetFieldById.get(mapping.targetFieldDefinitionId);

    if (!targetField) {
      throw new Error("Workflow references a target field that no longer exists.");
    }

    if (targetField.archivedAt) {
      throw new Error(
        `Workflow references archived target field ${targetField.name}.`,
      );
    }

    if (mapping.source.type === "unset") {
      if (targetField.required) {
        throw new Error(`${targetField.name} is required and cannot be unset.`);
      }

      continue;
    }

    if (mapping.source.type === "constant") {
      values[targetField.key] = mapping.source.value;
      continue;
    }

    if (mapping.source.type === "template") {
      if (targetField.type !== "text") {
        throw new Error("Workflow template mappings can only populate text fields.");
      }

      const parsedTemplate = parseCanonicalTemplate(mapping.source.template);

      if (!parsedTemplate.success) {
        throw new Error(parsedTemplate.error);
      }

      for (const part of parsedTemplate.parts) {
        if (
          part.type === "field" &&
          !sourceFieldById.has(part.sourceFieldDefinitionId)
        ) {
          throw new Error(
            `Workflow template references a ${sourceEntityType.name} field that no longer exists.`,
          );
        }

        if (
          part.type === "field" &&
          sourceFieldById.get(part.sourceFieldDefinitionId)?.archivedAt
        ) {
          throw new Error("Workflow template references an archived source field.");
        }
      }

      values[targetField.key] = await renderWorkflowTemplate({
        template: mapping.source.template,
        sourceFields,
        sourceRecord,
        resolveRelationLabel,
      });
      continue;
    }

    if (
      mapping.source.type === "leave_unchanged" ||
      mapping.source.type === "clear"
    ) {
      throw new Error(
        "Workflow update-only mappings cannot be used to create records.",
      );
    }

    const sourceField = sourceFieldById.get(
      mapping.source.sourceFieldDefinitionId,
    );

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

    const sourceValue = sourceRecord.values[sourceField.key];

    if (sourceValue !== undefined) {
      values[targetField.key] = sourceValue;
    }
  }

  return values;
}
