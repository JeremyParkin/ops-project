"use client";

import { useActionState, useMemo, useState } from "react";
import {
  conditionOperatorNeedsValue,
  getConditionOperatorsForFieldType,
} from "@/lib/domain/workflow-conditions";
import { getWorkflowFieldLabel } from "@/lib/domain/workflow-field-labels";
import type { WorkflowFormState } from "@/lib/domain/workflow-validation";
import { initialWorkflowFormState } from "@/lib/domain/workflow-validation";
import type { EntityType, FieldDefinition } from "@/lib/domain/types";
import type { RelationRecordOption } from "@/lib/domain/record-repository";
import type {
  WorkflowActionType,
  WorkflowConditionOperator,
  WorkflowTriggerType,
} from "@/lib/domain/workflow-types";

type WorkflowEntityContext = {
  entityType: EntityType;
  fields: FieldDefinition[];
  relationOptionsByFieldId: Record<string, RelationRecordOption[]>;
};

type WorkflowDefinitionFormProps = {
  mode: "create" | "edit";
  entityContexts: WorkflowEntityContext[];
  initialState?: WorkflowFormState;
  submitAction: (
    state: WorkflowFormState,
    formData: FormData,
  ) => Promise<WorkflowFormState>;
};

type WorkflowDefinitionFormFieldsProps = WorkflowDefinitionFormProps & {
  state: WorkflowFormState;
  pending: boolean;
};

type LocalMapping = {
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

type LocalCondition = {
  id: string;
  sourceFieldDefinitionId: string;
  operator: WorkflowConditionOperator;
  value: string;
};

const fieldTypeLabel = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Boolean",
  relation: "Relation",
};

const conditionOperatorLabel: Record<WorkflowConditionOperator, string> = {
  equals: "Equals",
  not_equals: "Does Not Equal",
  greater_than: "Greater Than",
  greater_than_or_equal: "Greater Than Or Equal",
  less_than: "Less Than",
  less_than_or_equal: "Less Than Or Equal",
  before: "Before",
  after: "After",
  is_set: "Is Set",
  is_not_set: "Is Not Set",
};

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="mt-1 text-sm text-red-700" role="alert">
      {message}
    </p>
  );
}

function areFieldsCompatible(
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

function getDefaultMapping(
  field: FieldDefinition,
  actionType: WorkflowActionType,
): LocalMapping {
  return {
    type:
      actionType === "update_record" || actionType === "update_related_record"
        ? "leave_unchanged"
        : field.required
          ? "constant"
          : "unset",
    constantValue: "",
    sourceFieldDefinitionId: "",
    template: "",
  };
}

function createMappingsForTarget(
  fields: FieldDefinition[],
  savedMappings: WorkflowFormState["values"]["mappings"],
  actionType: WorkflowActionType,
) {
  return Object.fromEntries(
    fields.map((field) => [
      field.id,
      savedMappings[field.id] ?? getDefaultMapping(field, actionType),
    ]),
  ) as Record<string, LocalMapping>;
}

function getActiveFields(fields: FieldDefinition[]) {
  return fields.filter((field) => !field.archivedAt);
}

function getSelectableFields({
  fields,
  selectedFieldId,
}: {
  fields: FieldDefinition[];
  selectedFieldId?: string;
}) {
  return fields.filter(
    (field) => !field.archivedAt || field.id === selectedFieldId,
  );
}

function getRenderedTargetFields({
  fields,
  mappings,
}: {
  fields: FieldDefinition[];
  mappings: Record<string, LocalMapping>;
}) {
  return fields.filter((field) => !field.archivedAt || mappings[field.id]);
}

function cleanMappingsForTrigger({
  mappings,
  targetFields,
  triggerFields,
  actionType,
}: {
  mappings: Record<string, LocalMapping>;
  targetFields: FieldDefinition[];
  triggerFields: FieldDefinition[];
  actionType: WorkflowActionType;
}) {
  const triggerFieldById = new Map(triggerFields.map((field) => [field.id, field]));

  return Object.fromEntries(
    targetFields.map((targetField) => {
      const mapping =
        mappings[targetField.id] ?? getDefaultMapping(targetField, actionType);

      if (mapping.type !== "source_field") {
        if (mapping.type === "template") {
          return [
            targetField.id,
            {
              ...mapping,
              template: "",
            },
          ];
        }

        return [targetField.id, mapping];
      }

      const sourceField = triggerFieldById.get(mapping.sourceFieldDefinitionId);

      if (!sourceField || !areFieldsCompatible(sourceField, targetField)) {
        return [
          targetField.id,
          {
            ...mapping,
            sourceFieldDefinitionId: "",
          },
        ];
      }

      return [targetField.id, mapping];
    }),
  ) as Record<string, LocalMapping>;
}

function ConstantInput({
  field,
  value,
  options,
  error,
  onChange,
}: {
  field: FieldDefinition;
  value: string;
  options: RelationRecordOption[];
  error?: string;
  onChange: (value: string) => void;
}) {
  if (field.type === "boolean") {
    return (
      <>
        <select
          name={`constantValue:${field.id}`}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
        >
          <option value="">Choose value</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
        <FieldError message={error} />
      </>
    );
  }

  if (field.type === "relation") {
    return (
      <>
        <select
          name={`constantValue:${field.id}`}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
        >
          <option value="">Choose record</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError message={error} />
      </>
    );
  }

  return (
    <>
      <input
        name={`constantValue:${field.id}`}
        type={field.type === "number" ? "text" : field.type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
      />
      <FieldError message={error} />
    </>
  );
}

function ConditionValueInput({
  field,
  operator,
  value,
  name,
  options,
  error,
  onChange,
}: {
  field: FieldDefinition;
  operator: WorkflowConditionOperator;
  value: string;
  name: string;
  options: RelationRecordOption[];
  error?: string;
  onChange: (value: string) => void;
}) {
  if (!conditionOperatorNeedsValue(operator)) {
    return null;
  }

  if (field.type === "boolean") {
    return (
      <>
        <select
          name={name}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
        >
          <option value="">Choose value</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
        <FieldError message={error} />
      </>
    );
  }

  if (field.type === "relation") {
    return (
      <>
        <select
          name={name}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
        >
          <option value="">Choose record</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError message={error} />
      </>
    );
  }

  return (
    <>
      <input
        name={name}
        value={value}
        type={field.type === "number" ? "text" : field.type}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
      />
      <FieldError message={error} />
    </>
  );
}

export function WorkflowDefinitionForm({
  mode,
  entityContexts,
  initialState = initialWorkflowFormState,
  submitAction,
}: WorkflowDefinitionFormProps) {
  const [state, formAction, pending] = useActionState(
    submitAction,
    initialState,
  );

  return (
    <section className="w-full max-w-5xl border border-slate-200 bg-white p-5">
      <div className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          {mode === "create" ? "New Workflow" : "Edit Workflow"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-950">
          Create Record Automation
        </h1>
        {state.message ? (
          <p className="mt-2 text-sm text-red-700" role="status">
            {state.message}
          </p>
        ) : null}
        <FieldError message={state.errors._form} />
      </div>

      <form action={formAction} className="flex flex-col gap-6">
        <WorkflowDefinitionFormFields
          key={state.formVersion}
          mode={mode}
          entityContexts={entityContexts}
          initialState={initialState}
          submitAction={submitAction}
          state={state}
          pending={pending}
        />
      </form>
    </section>
  );
}

function WorkflowDefinitionFormFields({
  mode,
  entityContexts,
  state,
  pending,
}: WorkflowDefinitionFormFieldsProps) {
  const contextById = useMemo(
    () =>
      new Map(
        entityContexts.map((context) => [context.entityType.id, context]),
      ),
    [entityContexts],
  );
  const initialTriggerEntityTypeId =
    state.values.triggerEntityTypeId || entityContexts[0]?.entityType.id || "";
  const initialActionType = state.values.actionType;
  const initialTargetEntityTypeId =
    state.values.actionTargetEntityTypeId ||
    entityContexts[0]?.entityType.id ||
    "";
  const initialRelatedFieldDefinitionId = state.values.relatedFieldDefinitionId;
  const initialTriggerContext = contextById.get(initialTriggerEntityTypeId);
  const initialRelatedField = initialTriggerContext?.fields.find(
    (field) => field.id === initialRelatedFieldDefinitionId,
  );
  const initialTargetContext =
    initialActionType === "update_record"
      ? contextById.get(initialTriggerEntityTypeId)
      : initialActionType === "update_related_record"
        ? contextById.get(initialRelatedField?.relatedEntityTypeId ?? "")
      : contextById.get(initialTargetEntityTypeId);
  const initialTargetFields = initialTargetContext
    ? getRenderedTargetFields({
        fields: initialTargetContext.fields,
        mappings: state.values.mappings,
      })
    : [];
  const [workflowName, setWorkflowName] = useState(state.values.name);
  const [enabled, setEnabled] = useState(state.values.enabled);
  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>(
    state.values.triggerType,
  );
  const [actionType, setActionType] =
    useState<WorkflowActionType>(initialActionType);
  const [triggerEntityTypeId, setTriggerEntityTypeId] = useState(
    initialTriggerEntityTypeId,
  );
  const [watchedFieldDefinitionIds, setWatchedFieldDefinitionIds] = useState<
    string[]
  >(state.values.watchedFieldDefinitionIds);
  const [targetEntityTypeId, setTargetEntityTypeId] = useState(
    initialTargetEntityTypeId,
  );
  const [relatedFieldDefinitionId, setRelatedFieldDefinitionId] = useState(
    initialRelatedFieldDefinitionId,
  );
  const [mappings, setMappings] = useState<Record<string, LocalMapping>>(
    createMappingsForTarget(
      initialTargetFields,
      state.values.mappings,
      initialActionType,
    ),
  );
  const [conditions, setConditions] = useState<LocalCondition[]>(
    state.values.conditions,
  );
  const triggerContext = contextById.get(triggerEntityTypeId);
  const targetContext =
    actionType === "update_record"
      ? triggerContext
      : actionType === "update_related_record"
        ? contextById.get(
            triggerContext?.fields.find(
              (field) => field.id === relatedFieldDefinitionId,
            )?.relatedEntityTypeId ?? "",
          )
      : contextById.get(targetEntityTypeId);
  const entityNameById = Object.fromEntries(
    entityContexts.map((context) => [
      context.entityType.id,
      context.entityType.name,
    ]),
  );

  function getSourceFieldLabel(field: FieldDefinition) {
    return triggerContext
      ? getWorkflowFieldLabel({
          entityType: triggerContext.entityType,
          field,
          entityNameById,
        })
      : field.name;
  }

  function updateMapping(
    targetFieldId: string,
    updater: (mapping: LocalMapping) => LocalMapping,
  ) {
    setMappings((current) => ({
      ...current,
      [targetFieldId]: updater(
        current[targetFieldId] ?? {
          type:
            actionType === "update_record" || actionType === "update_related_record"
              ? "leave_unchanged"
              : "unset",
          constantValue: "",
          sourceFieldDefinitionId: "",
          template: "",
        },
      ),
    }));
  }

  function removeMapping(targetFieldId: string) {
    setMappings((current) => {
      const next = { ...current };
      delete next[targetFieldId];

      return next;
    });
  }

  function handleTriggerEntityChange(value: string) {
    setTriggerEntityTypeId(value);
    setConditions([]);
    setWatchedFieldDefinitionIds([]);

    const nextTriggerContext = contextById.get(value);

    if (!nextTriggerContext || !targetContext) {
      return;
    }

    if (actionType === "update_record") {
      setMappings(
        createMappingsForTarget(
          getActiveFields(nextTriggerContext.fields),
          {},
          actionType,
        ),
      );
    } else if (actionType === "update_related_record") {
      setRelatedFieldDefinitionId("");
      setMappings({});
    } else {
      setMappings((current) =>
        cleanMappingsForTrigger({
          mappings: current,
          targetFields: targetContext.fields,
          triggerFields: nextTriggerContext.fields,
          actionType,
        }),
      );
    }
  }

  function handleActionTypeChange(value: WorkflowActionType) {
    setActionType(value);
    const nextTargetContext =
      value === "update_record"
        ? triggerContext
        : value === "update_related_record"
          ? undefined
        : contextById.get(targetEntityTypeId);

    setMappings(
      createMappingsForTarget(
        getActiveFields(nextTargetContext?.fields ?? []),
        {},
        value,
      ),
    );
  }

  function handleRelatedFieldChange(value: string) {
    setRelatedFieldDefinitionId(value);
    const relatedField = triggerContext?.fields.find((field) => field.id === value);
    const nextTargetContext = contextById.get(
      relatedField?.relatedEntityTypeId ?? "",
    );

    setMappings(
      createMappingsForTarget(
        getActiveFields(nextTargetContext?.fields ?? []),
        {},
        actionType,
      ),
    );
  }

  function addCondition() {
    const firstField = getActiveFields(triggerContext?.fields ?? [])[0];

    setConditions((current) => [
      ...current,
      {
        id: `condition-${Date.now()}-${current.length}`,
        sourceFieldDefinitionId: firstField?.id ?? "",
        operator: firstField
          ? getConditionOperatorsForFieldType(firstField.type)[0]
          : "equals",
        value: "",
      },
    ]);
  }

  function updateCondition(
    conditionId: string,
    updater: (condition: LocalCondition) => LocalCondition,
  ) {
    setConditions((current) =>
      current.map((condition) =>
        condition.id === conditionId ? updater(condition) : condition,
      ),
    );
  }

  function removeCondition(conditionId: string) {
    setConditions((current) =>
      current.filter((condition) => condition.id !== conditionId),
    );
  }

  function toggleWatchedField(fieldId: string, checked: boolean) {
    setWatchedFieldDefinitionIds((current) => {
      if (checked) {
        return current.includes(fieldId) ? current : [...current, fieldId];
      }

      return current.filter((watchedFieldId) => watchedFieldId !== fieldId);
    });
  }

  function handleTargetEntityChange(value: string) {
    setTargetEntityTypeId(value);

    const nextTargetContext = contextById.get(value);

    setMappings(
      createMappingsForTarget(
        getActiveFields(nextTargetContext?.fields ?? []),
        {},
        actionType,
      ),
    );
  }

  const watchedFields =
    triggerContext?.fields.filter(
      (field) =>
        !field.archivedAt || watchedFieldDefinitionIds.includes(field.id),
    ) ?? [];
  const relatedFields = getSelectableFields({
    fields: triggerContext?.fields ?? [],
    selectedFieldId: relatedFieldDefinitionId,
  }).filter((field) => field.type === "relation");
  const renderedTargetFields = targetContext
    ? getRenderedTargetFields({
        fields: targetContext.fields,
        mappings,
      })
    : [];
  const archivedReferenceMessages = Array.from(
    new Set([
      ...(triggerType === "record_updated"
        ? watchedFieldDefinitionIds
            .map((fieldId) =>
              triggerContext?.fields.find((field) => field.id === fieldId),
            )
            .filter(
              (field): field is FieldDefinition => Boolean(field?.archivedAt),
            )
            .map(
              (field) =>
                `Watched field ${getSourceFieldLabel(field)} is archived.`,
            )
        : []),
      ...(actionType === "update_related_record"
        ? relatedFields
            .filter(
              (field) =>
                field.id === relatedFieldDefinitionId && Boolean(field.archivedAt),
            )
            .map((field) => `Related field ${getSourceFieldLabel(field)} is archived.`)
        : []),
      ...conditions
        .map((condition) =>
          triggerContext?.fields.find(
            (field) => field.id === condition.sourceFieldDefinitionId,
          ),
        )
        .filter((field): field is FieldDefinition => Boolean(field?.archivedAt))
        .map(
          (field) => `Condition field ${getSourceFieldLabel(field)} is archived.`,
        ),
      ...renderedTargetFields
        .filter((field) => field.archivedAt)
        .map((field) =>
          targetContext
            ? `Target field ${getWorkflowFieldLabel({
                entityType: targetContext.entityType,
                field,
                entityNameById,
              })} is archived.`
            : `Target field ${field.name} is archived.`,
        ),
      ...renderedTargetFields.flatMap((targetField) => {
        const mapping =
          mappings[targetField.id] ?? getDefaultMapping(targetField, actionType);

        if (!triggerContext) {
          return [];
        }

        if (mapping.type === "source_field") {
          const sourceField = triggerContext.fields.find(
            (field) => field.id === mapping.sourceFieldDefinitionId,
          );

          return sourceField?.archivedAt
            ? [
                `Source mapping ${getSourceFieldLabel(
                  sourceField,
                )} is archived.`,
              ]
            : [];
        }

        if (mapping.type !== "template") {
          return [];
        }

        return triggerContext.fields
          .filter((field) => field.archivedAt)
          .filter((field) =>
            mapping.template.includes(`{${getSourceFieldLabel(field)}}`),
          )
          .map(
            (field) =>
              `Template placeholder ${getSourceFieldLabel(field)} is archived.`,
          );
      }),
    ]),
  );

  return (
    <>
      <div className="grid gap-4 md:grid-cols-5">
        <div>
          <label
            htmlFor="workflowName"
            className="block text-sm font-medium text-slate-800"
          >
            Workflow Name
          </label>
          <input
            id="workflowName"
            name="workflowName"
            required
            value={workflowName}
            onChange={(event) => setWorkflowName(event.currentTarget.value)}
            className="mt-1 block h-10 w-full border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          />
          <FieldError message={state.errors.workflowName} />
        </div>

        <div>
          <label
            htmlFor="workflowTriggerType"
            className="block text-sm font-medium text-slate-800"
          >
            Trigger
          </label>
          <select
            id="workflowTriggerType"
            name="workflowTriggerType"
            value={triggerType}
            onChange={(event) => {
              const value = event.currentTarget.value as WorkflowTriggerType;

              setTriggerType(value);

              if (value === "record_created") {
                setWatchedFieldDefinitionIds([]);
              }
            }}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="record_created">Record Created</option>
            <option value="record_updated">Record Updated</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="triggerEntityTypeId"
            className="block text-sm font-medium text-slate-800"
          >
            Trigger Entity
          </label>
          <select
            id="triggerEntityTypeId"
            name="triggerEntityTypeId"
            value={triggerEntityTypeId}
            onChange={(event) =>
              handleTriggerEntityChange(event.currentTarget.value)
            }
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            {entityContexts.map((context) => (
              <option key={context.entityType.id} value={context.entityType.id}>
                {context.entityType.name}
              </option>
            ))}
          </select>
          <FieldError message={state.errors.triggerEntityTypeId} />
        </div>

        <div>
          <label
            htmlFor="workflowActionType"
            className="block text-sm font-medium text-slate-800"
          >
            Action
          </label>
          <select
            id="workflowActionType"
            name="workflowActionType"
            value={actionType}
            onChange={(event) =>
              handleActionTypeChange(
                event.currentTarget.value as WorkflowActionType,
              )
            }
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="create_record">Create Record</option>
            <option value="update_record">Update Triggering Record</option>
            <option value="update_related_record">Update Related Record</option>
          </select>
        </div>

        {actionType === "create_record" ? (
          <div>
          <label
            htmlFor="actionTargetEntityTypeId"
            className="block text-sm font-medium text-slate-800"
          >
            Then Create Record In
          </label>
          <select
            id="actionTargetEntityTypeId"
            name="actionTargetEntityTypeId"
            value={targetEntityTypeId}
            onChange={(event) =>
              handleTargetEntityChange(event.currentTarget.value)
            }
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            {entityContexts.map((context) => (
              <option key={context.entityType.id} value={context.entityType.id}>
                {context.entityType.name}
              </option>
            ))}
          </select>
          <FieldError message={state.errors.actionTargetEntityTypeId} />
          </div>
        ) : null}
        {actionType === "update_related_record" ? (
          <div>
            <label
              htmlFor="relatedFieldDefinitionId"
              className="block text-sm font-medium text-slate-800"
            >
              Related Record Field
            </label>
            <select
              id="relatedFieldDefinitionId"
              name="relatedFieldDefinitionId"
              value={relatedFieldDefinitionId}
              onChange={(event) => handleRelatedFieldChange(event.currentTarget.value)}
              className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
            >
              <option value="">Choose relation field</option>
              {relatedFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {getSourceFieldLabel(field)}
                  {field.archivedAt ? " (Archived)" : ""}
                </option>
              ))}
            </select>
            <FieldError message={state.errors.relatedFieldDefinitionId} />
            {targetContext ? (
              <p className="mt-1 text-sm text-slate-500">
                Updates one related {targetContext.entityType.name} record.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <input name="workflowEnabled" type="hidden" value="false" />
      <label className="flex w-fit items-center gap-2 text-sm font-medium text-slate-800">
        <input
          name="workflowEnabled"
          type="checkbox"
          value="true"
          checked={enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
          className="h-4 w-4 border-slate-300 text-slate-950"
        />
        Enabled
      </label>

      {archivedReferenceMessages.length > 0 ? (
        <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">
            This workflow cannot run while it references an archived field.
          </p>
          <ul className="mt-2 list-disc pl-5">
            {archivedReferenceMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {triggerType === "record_updated" ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-slate-950">
            Run When These Fields Change
          </h2>
          <div className="grid gap-2 border border-slate-200 p-4 md:grid-cols-2">
            {watchedFields.map((field) => (
              <label
                key={field.id}
                className="flex items-center gap-2 text-sm font-medium text-slate-800"
              >
                <input
                  name="watchedFieldDefinitionId"
                  type="checkbox"
                  value={field.id}
                  checked={watchedFieldDefinitionIds.includes(field.id)}
                  onChange={(event) =>
                    toggleWatchedField(field.id, event.currentTarget.checked)
                  }
                  className="h-4 w-4 border-slate-300 text-slate-950"
                />
                {getSourceFieldLabel(field)}
              </label>
            ))}
          </div>
          <FieldError message={state.errors.watchedFieldDefinitionIds} />
        </div>
      ) : null}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">Conditions</h2>
          <button
            type="button"
            onClick={addCondition}
            className="border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:border-slate-950 hover:text-slate-950"
          >
            Add Condition
          </button>
        </div>
        {conditions.length === 0 ? (
          <p className="text-sm text-slate-500">
            {triggerType === "record_updated"
              ? "This workflow runs when watched fields change and conditions match."
              : `This workflow runs for every new ${
                  triggerContext?.entityType.name ?? "record"
                }.`}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {conditions.map((condition) => {
              const selectedField = triggerContext?.fields.find(
                (field) => field.id === condition.sourceFieldDefinitionId,
              );
              const conditionFields = triggerContext
                ? getSelectableFields({
                    fields: triggerContext.fields,
                    selectedFieldId: condition.sourceFieldDefinitionId,
                  })
                : [];
              const operatorOptions = selectedField
                ? getConditionOperatorsForFieldType(selectedField.type)
                : [];
              const operator = operatorOptions.includes(condition.operator)
                ? condition.operator
                : operatorOptions[0] ?? "equals";

              return (
                <div
                  key={condition.id}
                  className="grid gap-3 border border-slate-200 p-4 md:grid-cols-[1fr_180px_1fr_auto]"
                >
                  <input name="conditionId" type="hidden" value={condition.id} />
                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                      Field
                    </label>
                    <select
                      name={`conditionField:${condition.id}`}
                      value={condition.sourceFieldDefinitionId}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        const nextField = triggerContext?.fields.find(
                          (field) => field.id === value,
                        );

                        updateCondition(condition.id, (current) => ({
                          ...current,
                          sourceFieldDefinitionId: value,
                          operator: nextField
                            ? getConditionOperatorsForFieldType(nextField.type)[0]
                            : "equals",
                          value: "",
                        }));
                      }}
                      className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                    >
                      {conditionFields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {getSourceFieldLabel(field)}
                        </option>
                      ))}
                    </select>
                    <FieldError message={state.errors[`conditionField:${condition.id}`]} />
                  </div>

                  <div>
                    <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                      Operator
                    </label>
                    <select
                      name={`conditionOperator:${condition.id}`}
                      value={operator}
                      onChange={(event) => {
                        const value = event.currentTarget.value as WorkflowConditionOperator;

                        updateCondition(condition.id, (current) => ({
                          ...current,
                          operator: value,
                          value: conditionOperatorNeedsValue(value)
                            ? current.value
                            : "",
                        }));
                      }}
                      className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                    >
                      {operatorOptions.map((option) => (
                        <option key={option} value={option}>
                          {conditionOperatorLabel[option]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    {selectedField ? (
                      <>
                        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                          Value
                        </label>
                        <ConditionValueInput
                          field={selectedField}
                          operator={operator}
                          value={condition.value}
                          name={`conditionValue:${condition.id}`}
                          options={
                            triggerContext?.relationOptionsByFieldId[
                              selectedField.id
                            ] ?? []
                          }
                          error={state.errors[`conditionValue:${condition.id}`]}
                          onChange={(value) =>
                            updateCondition(condition.id, (current) => ({
                              ...current,
                              value,
                            }))
                          }
                        />
                      </>
                    ) : null}
                  </div>

                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => removeCondition(condition.id)}
                      className="h-10 border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:border-red-700 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-slate-950">
          {actionType === "update_record" || actionType === "update_related_record"
            ? "Update Fields"
            : "Set Fields"}
        </h2>
        <div className="flex flex-col gap-3">
          {renderedTargetFields.map((targetField) => {
            const mapping =
              mappings[targetField.id] ?? getDefaultMapping(targetField, actionType);
            const compatibleSourceFields =
              triggerContext
                ? getSelectableFields({
                    fields: triggerContext.fields,
                    selectedFieldId: mapping.sourceFieldDefinitionId,
                  }).filter((sourceField) =>
                    areFieldsCompatible(sourceField, targetField),
                  )
                : [];

            return (
              <div
                key={targetField.id}
                className="grid gap-3 border border-slate-200 p-4 md:grid-cols-[1fr_180px_1fr]"
              >
                <input
                  name="targetFieldDefinitionId"
                  type="hidden"
                  value={targetField.id}
                />
                <div>
                  <p className="text-sm font-medium text-slate-950">
                    {targetField.name}
                    {targetField.required ? (
                      <span className="ml-1 text-red-700" aria-hidden="true">
                        *
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {fieldTypeLabel[targetField.type]}
                    {targetField.archivedAt ? " · Archived" : ""}
                  </p>
                  {targetField.archivedAt ? (
                    <button
                      type="button"
                      onClick={() => removeMapping(targetField.id)}
                      className="mt-3 border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:border-red-700 hover:text-red-700"
                    >
                      Remove archived mapping
                    </button>
                  ) : null}
                </div>

                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                    Mapping
                  </label>
                  <select
                    name={`mappingType:${targetField.id}`}
                    value={mapping.type}
                    onChange={(event) => {
                      const value = event.currentTarget
                        .value as LocalMapping["type"];

                      updateMapping(targetField.id, (current) => ({
                        ...current,
                        type: value,
                      }));
                    }}
                    className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                  >
                    {actionType === "update_record" || actionType === "update_related_record" ? (
                      <>
                        <option value="leave_unchanged">Leave unchanged</option>
                        {!targetField.required ? (
                          <option value="clear">Clear value</option>
                        ) : null}
                      </>
                    ) : !targetField.required ? (
                      <option value="unset">Unset</option>
                    ) : null}
                    <option value="constant">Constant</option>
                    <option value="source_field">Source Field</option>
                    {targetField.type === "text" ? (
                      <option value="template">Template</option>
                    ) : null}
                  </select>
                  <FieldError message={state.errors[`mappingType:${targetField.id}`]} />
                </div>

                <div>
                  {mapping.type === "constant" ? (
                    <>
                      <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                        Constant Value
                      </label>
                      <ConstantInput
                        field={targetField}
                        value={mapping.constantValue}
                        options={
                          targetContext?.relationOptionsByFieldId[
                            targetField.id
                          ] ?? []
                        }
                        error={state.errors[`constantValue:${targetField.id}`]}
                        onChange={(value) =>
                          updateMapping(targetField.id, (current) => ({
                            ...current,
                            constantValue: value,
                          }))
                        }
                      />
                    </>
                  ) : null}

                  {mapping.type === "template" ? (
                    <>
                      <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                        Template
                      </label>
                      <textarea
                        name={`templateValue:${targetField.id}`}
                        value={mapping.template}
                        onChange={(event) => {
                          const value = event.currentTarget.value;

                          updateMapping(targetField.id, (current) => ({
                            ...current,
                            template: value,
                          }));
                        }}
                        rows={3}
                        className="mt-1 block w-full border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none focus:border-slate-950"
                      />
                      <div className="mt-2 flex flex-wrap gap-2">
                        {getActiveFields(triggerContext?.fields ?? []).map(
                          (sourceField) => {
                            const label = getSourceFieldLabel(sourceField);
                            const token = `{${label}}`;

                            return (
                              <button
                                key={sourceField.id}
                                type="button"
                                onClick={() =>
                                  updateMapping(targetField.id, (current) => ({
                                    ...current,
                                    template: `${current.template}${token}`,
                                  }))
                                }
                                className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-950 hover:text-slate-950"
                              >
                                {label}
                              </button>
                            );
                          },
                        )}
                      </div>
                      <FieldError message={state.errors[`templateValue:${targetField.id}`]} />
                    </>
                  ) : null}

                  {mapping.type === "source_field" ? (
                    <>
                      <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                        Source Field
                      </label>
                      <select
                        name={`sourceFieldDefinitionId:${targetField.id}`}
                        value={mapping.sourceFieldDefinitionId}
                        onChange={(event) => {
                          const value = event.currentTarget.value;

                          updateMapping(targetField.id, (current) => ({
                            ...current,
                            sourceFieldDefinitionId: value,
                          }));
                        }}
                        className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                      >
                        <option value="">Choose source field</option>
                        {compatibleSourceFields.map((sourceField) => (
                          <option key={sourceField.id} value={sourceField.id}>
                            {getSourceFieldLabel(sourceField)}
                          </option>
                        ))}
                      </select>
                      <FieldError
                        message={
                          state.errors[
                            `sourceFieldDefinitionId:${targetField.id}`
                          ]
                        }
                      />
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <button
        type="submit"
        disabled={pending || archivedReferenceMessages.length > 0}
        className="inline-flex h-10 w-fit items-center justify-center bg-slate-950 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {pending
          ? "Saving..."
          : mode === "create"
            ? "Create Workflow"
            : "Save Workflow"}
      </button>
    </>
  );
}

export const WorkflowCreateForm = WorkflowDefinitionForm;
