"use client";

import { useActionState, useMemo, useState } from "react";
import {
  conditionOperatorNeedsPreviousValue,
  conditionOperatorNeedsValue,
  getConditionOperatorsForFieldType,
  isTransitionConditionOperator,
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

type LocalAction = {
  id: string;
  actionType: WorkflowActionType;
  actionTargetEntityTypeId: string;
  relatedFieldDefinitionId: string;
  mappings: Record<string, LocalMapping>;
};

type LocalCondition = {
  id: string;
  sourceFieldDefinitionId: string;
  operator: WorkflowConditionOperator;
  value: string;
  previousValue: string;
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
  changed: "Changed",
  changed_from: "Changed From",
  changed_to: "Changed To",
  changed_from_to: "Changed From/To",
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
  savedMappings: Record<string, LocalMapping>,
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

function createDefaultAction(defaultEntityTypeId: string): LocalAction {
  return {
    id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actionType: "create_record",
    actionTargetEntityTypeId: defaultEntityTypeId,
    relatedFieldDefinitionId: "",
    mappings: {},
  };
}

function ConstantInput({
  field,
  value,
  name,
  options,
  error,
  onChange,
}: {
  field: FieldDefinition;
  value: string;
  name: string;
  options: RelationRecordOption[];
  error?: string;
  onChange: (value: string) => void;
}) {
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
  value,
  name,
  options,
  error,
  onChange,
}: {
  field: FieldDefinition;
  value: string;
  name: string;
  options: RelationRecordOption[];
  error?: string;
  onChange: (value: string) => void;
}) {
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
  const initialTriggerContext = contextById.get(initialTriggerEntityTypeId);
  const defaultTargetEntityTypeId = entityContexts[0]?.entityType.id ?? "";

  function resolveTargetContext(action: LocalAction, triggerCtx?: WorkflowEntityContext) {
    if (action.actionType === "update_record") {
      return triggerCtx;
    }

    if (action.actionType === "update_related_record") {
      const relatedField = triggerCtx?.fields.find(
        (field) => field.id === action.relatedFieldDefinitionId,
      );

      return contextById.get(relatedField?.relatedEntityTypeId ?? "");
    }

    return contextById.get(action.actionTargetEntityTypeId);
  }

  function buildInitialAction(formValue: WorkflowFormState["values"]["actions"][number]): LocalAction {
    const local: LocalAction = {
      id: formValue.id,
      actionType: formValue.actionType,
      actionTargetEntityTypeId:
        formValue.actionTargetEntityTypeId || defaultTargetEntityTypeId,
      relatedFieldDefinitionId: formValue.relatedFieldDefinitionId,
      mappings: {},
    };
    const targetContext = resolveTargetContext(local, initialTriggerContext);
    const renderedTargetFields = targetContext
      ? getRenderedTargetFields({ fields: targetContext.fields, mappings: formValue.mappings })
      : [];

    local.mappings = createMappingsForTarget(
      renderedTargetFields,
      formValue.mappings,
      local.actionType,
    );

    return local;
  }

  const [workflowName, setWorkflowName] = useState(state.values.name);
  const [enabled, setEnabled] = useState(state.values.enabled);
  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>(
    state.values.triggerType,
  );
  const [triggerEntityTypeId, setTriggerEntityTypeId] = useState(
    initialTriggerEntityTypeId,
  );
  const [watchedFieldDefinitionIds, setWatchedFieldDefinitionIds] = useState<
    string[]
  >(state.values.watchedFieldDefinitionIds);
  const [conditions, setConditions] = useState<LocalCondition[]>(
    state.values.conditions,
  );
  const [actions, setActions] = useState<LocalAction[]>(() =>
    state.values.actions.map(buildInitialAction),
  );
  const triggerContext = contextById.get(triggerEntityTypeId);
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

  function updateAction(
    actionId: string,
    updater: (action: LocalAction) => LocalAction,
  ) {
    setActions((current) =>
      current.map((action) => (action.id === actionId ? updater(action) : action)),
    );
  }

  function addAction() {
    setActions((current) => [...current, createDefaultAction(defaultTargetEntityTypeId)]);
  }

  function removeAction(actionId: string) {
    setActions((current) =>
      current.length <= 1 ? current : current.filter((action) => action.id !== actionId),
    );
  }

  function moveAction(actionId: string, direction: "up" | "down") {
    setActions((current) => {
      const index = current.findIndex((action) => action.id === actionId);
      const swapWith = direction === "up" ? index - 1 : index + 1;

      if (index === -1 || swapWith < 0 || swapWith >= current.length) {
        return current;
      }

      const next = [...current];

      [next[index], next[swapWith]] = [next[swapWith], next[index]];

      return next;
    });
  }

  function updateActionMapping(
    actionId: string,
    targetFieldId: string,
    updater: (mapping: LocalMapping) => LocalMapping,
  ) {
    updateAction(actionId, (action) => ({
      ...action,
      mappings: {
        ...action.mappings,
        [targetFieldId]: updater(
          action.mappings[targetFieldId] ?? {
            type:
              action.actionType === "update_record" ||
              action.actionType === "update_related_record"
                ? "leave_unchanged"
                : "unset",
            constantValue: "",
            sourceFieldDefinitionId: "",
            template: "",
          },
        ),
      },
    }));
  }

  function removeActionMapping(actionId: string, targetFieldId: string) {
    updateAction(actionId, (action) => {
      const nextMappings = { ...action.mappings };

      delete nextMappings[targetFieldId];

      return { ...action, mappings: nextMappings };
    });
  }

  function handleTriggerEntityChange(value: string) {
    setTriggerEntityTypeId(value);
    setConditions([]);
    setWatchedFieldDefinitionIds([]);

    const nextTriggerContext = contextById.get(value);

    setActions((current) =>
      current.map((action) => {
        if (action.actionType === "update_record") {
          return {
            ...action,
            mappings: createMappingsForTarget(
              getActiveFields(nextTriggerContext?.fields ?? []),
              {},
              action.actionType,
            ),
          };
        }

        if (action.actionType === "update_related_record") {
          return {
            ...action,
            relatedFieldDefinitionId: "",
            mappings: {},
          };
        }

        const targetContext = contextById.get(action.actionTargetEntityTypeId);

        if (!nextTriggerContext || !targetContext) {
          return action;
        }

        return {
          ...action,
          mappings: cleanMappingsForTrigger({
            mappings: action.mappings,
            targetFields: targetContext.fields,
            triggerFields: nextTriggerContext.fields,
            actionType: action.actionType,
          }),
        };
      }),
    );
  }

  function handleActionTypeChange(actionId: string, value: WorkflowActionType) {
    updateAction(actionId, (action) => {
      const targetEntityTypeId =
        action.actionTargetEntityTypeId || defaultTargetEntityTypeId;
      const nextTargetContext =
        value === "update_record"
          ? triggerContext
          : value === "update_related_record"
            ? undefined
            : contextById.get(targetEntityTypeId);

      return {
        ...action,
        actionType: value,
        actionTargetEntityTypeId: targetEntityTypeId,
        mappings: createMappingsForTarget(
          getActiveFields(nextTargetContext?.fields ?? []),
          {},
          value,
        ),
      };
    });
  }

  function handleActionTargetEntityChange(actionId: string, value: string) {
    updateAction(actionId, (action) => {
      const nextTargetContext = contextById.get(value);

      return {
        ...action,
        actionTargetEntityTypeId: value,
        mappings: createMappingsForTarget(
          getActiveFields(nextTargetContext?.fields ?? []),
          {},
          action.actionType,
        ),
      };
    });
  }

  function handleActionRelatedFieldChange(actionId: string, value: string) {
    updateAction(actionId, (action) => {
      const relatedField = triggerContext?.fields.find((field) => field.id === value);
      const nextTargetContext = contextById.get(
        relatedField?.relatedEntityTypeId ?? "",
      );

      return {
        ...action,
        relatedFieldDefinitionId: value,
        mappings: createMappingsForTarget(
          getActiveFields(nextTargetContext?.fields ?? []),
          {},
          action.actionType,
        ),
      };
    });
  }

  function addCondition() {
    const firstField = getActiveFields(triggerContext?.fields ?? [])[0];

    setConditions((current) => [
      ...current,
      {
        id: `condition-${Date.now()}-${current.length}`,
        sourceFieldDefinitionId: firstField?.id ?? "",
        operator: firstField
          ? getConditionOperatorsForFieldType(firstField.type, triggerType)[0]
          : "equals",
        value: "",
        previousValue: "",
      },
    ]);
  }

  function ensureWatchedIfTransition(
    fieldId: string,
    operator: WorkflowConditionOperator,
  ) {
    if (fieldId && isTransitionConditionOperator(operator)) {
      toggleWatchedField(fieldId, true);
    }
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

  const watchedFields =
    triggerContext?.fields.filter(
      (field) =>
        !field.archivedAt || watchedFieldDefinitionIds.includes(field.id),
    ) ?? [];

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
      ...actions.flatMap((action, actionIndex) => {
        const actionLabel = `Action ${actionIndex + 1}`;
        const targetContext = resolveTargetContext(action, triggerContext);
        const relatedFields =
          action.actionType === "update_related_record"
            ? getSelectableFields({
                fields: triggerContext?.fields ?? [],
                selectedFieldId: action.relatedFieldDefinitionId,
              }).filter((field) => field.type === "relation")
            : [];
        const renderedTargetFields = targetContext
          ? getRenderedTargetFields({
              fields: targetContext.fields,
              mappings: action.mappings,
            })
          : [];

        return [
          ...relatedFields
            .filter(
              (field) =>
                field.id === action.relatedFieldDefinitionId &&
                Boolean(field.archivedAt),
            )
            .map(
              (field) =>
                `${actionLabel} related field ${getSourceFieldLabel(field)} is archived.`,
            ),
          ...renderedTargetFields
            .filter((field) => field.archivedAt)
            .map((field) =>
              targetContext
                ? `${actionLabel} target field ${getWorkflowFieldLabel({
                    entityType: targetContext.entityType,
                    field,
                    entityNameById,
                  })} is archived.`
                : `${actionLabel} target field ${field.name} is archived.`,
            ),
          ...renderedTargetFields.flatMap((targetField) => {
            const mapping =
              action.mappings[targetField.id] ??
              getDefaultMapping(targetField, action.actionType);

            if (!triggerContext) {
              return [];
            }

            if (mapping.type === "source_field") {
              const sourceField = triggerContext.fields.find(
                (field) => field.id === mapping.sourceFieldDefinitionId,
              );

              return sourceField?.archivedAt
                ? [
                    `${actionLabel} source mapping ${getSourceFieldLabel(
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
                  `${actionLabel} template placeholder ${getSourceFieldLabel(
                    field,
                  )} is archived.`,
              );
          }),
        ];
      }),
    ]),
  );

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
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
                ? getConditionOperatorsForFieldType(selectedField.type, triggerType)
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
                        const nextOperator = nextField
                          ? getConditionOperatorsForFieldType(
                              nextField.type,
                              triggerType,
                            )[0]
                          : "equals";

                        updateCondition(condition.id, (current) => ({
                          ...current,
                          sourceFieldDefinitionId: value,
                          operator: nextOperator,
                          value: "",
                          previousValue: "",
                        }));
                        ensureWatchedIfTransition(value, nextOperator);
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
                          previousValue: conditionOperatorNeedsPreviousValue(value)
                            ? current.previousValue
                            : "",
                        }));
                        ensureWatchedIfTransition(
                          condition.sourceFieldDefinitionId,
                          value,
                        );
                      }}
                      className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                    >
                      {operatorOptions.map((option) => (
                        <option key={option} value={option}>
                          {conditionOperatorLabel[option]}
                        </option>
                      ))}
                    </select>
                    <FieldError
                      message={state.errors[`conditionOperator:${condition.id}`]}
                    />
                  </div>

                  <div>
                    {selectedField ? (
                      <div className="flex flex-col gap-2">
                        {conditionOperatorNeedsPreviousValue(operator) ? (
                          <div>
                            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                              {operator === "changed_from_to" ? "From" : "Value"}
                            </label>
                            <ConditionValueInput
                              field={selectedField}
                              value={condition.previousValue}
                              name={`conditionPreviousValue:${condition.id}`}
                              options={
                                triggerContext?.relationOptionsByFieldId[
                                  selectedField.id
                                ] ?? []
                              }
                              error={
                                state.errors[`conditionPreviousValue:${condition.id}`]
                              }
                              onChange={(value) =>
                                updateCondition(condition.id, (current) => ({
                                  ...current,
                                  previousValue: value,
                                }))
                              }
                            />
                          </div>
                        ) : null}
                        {conditionOperatorNeedsValue(operator) ? (
                          <div>
                            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                              {operator === "changed_from_to" ? "To" : "Value"}
                            </label>
                            <ConditionValueInput
                              field={selectedField}
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
                          </div>
                        ) : null}
                      </div>
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
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">Actions</h2>
          <button
            type="button"
            onClick={addAction}
            className="border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:border-slate-950 hover:text-slate-950"
          >
            Add Action
          </button>
        </div>
        <div className="flex flex-col gap-4">
          {actions.map((action, actionIndex) => {
            const targetContext = resolveTargetContext(action, triggerContext);
            const relatedFields =
              action.actionType === "update_related_record"
                ? getSelectableFields({
                    fields: triggerContext?.fields ?? [],
                    selectedFieldId: action.relatedFieldDefinitionId,
                  }).filter((field) => field.type === "relation")
                : [];
            const renderedTargetFields = targetContext
              ? getRenderedTargetFields({
                  fields: targetContext.fields,
                  mappings: action.mappings,
                })
              : [];

            return (
              <div
                key={action.id}
                className="border border-slate-200 p-4"
              >
                <input name="actionId" type="hidden" value={action.id} />
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Action {actionIndex + 1}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => moveAction(action.id, "up")}
                      disabled={actionIndex === 0}
                      className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Move Up
                    </button>
                    <button
                      type="button"
                      onClick={() => moveAction(action.id, "down")}
                      disabled={actionIndex === actions.length - 1}
                      className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Move Down
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAction(action.id)}
                      disabled={actions.length <= 1}
                      className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove Action
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <label
                      htmlFor={`actionType-${action.id}`}
                      className="block text-sm font-medium text-slate-800"
                    >
                      Action
                    </label>
                    <select
                      id={`actionType-${action.id}`}
                      name={`actionType:${action.id}`}
                      value={action.actionType}
                      onChange={(event) =>
                        handleActionTypeChange(
                          action.id,
                          event.currentTarget.value as WorkflowActionType,
                        )
                      }
                      className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                    >
                      <option value="create_record">Create Record</option>
                      <option value="update_record">Update Triggering Record</option>
                      <option value="update_related_record">
                        Update Related Record
                      </option>
                    </select>
                  </div>

                  {action.actionType === "create_record" ? (
                    <div>
                      <label
                        htmlFor={`actionTargetEntityTypeId-${action.id}`}
                        className="block text-sm font-medium text-slate-800"
                      >
                        Then Create Record In
                      </label>
                      <select
                        id={`actionTargetEntityTypeId-${action.id}`}
                        name={`actionTargetEntityTypeId:${action.id}`}
                        value={action.actionTargetEntityTypeId}
                        onChange={(event) =>
                          handleActionTargetEntityChange(
                            action.id,
                            event.currentTarget.value,
                          )
                        }
                        className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                      >
                        {entityContexts.map((context) => (
                          <option
                            key={context.entityType.id}
                            value={context.entityType.id}
                          >
                            {context.entityType.name}
                          </option>
                        ))}
                      </select>
                      <FieldError
                        message={
                          state.errors[`actionTargetEntityTypeId:${action.id}`]
                        }
                      />
                    </div>
                  ) : null}

                  {action.actionType === "update_related_record" ? (
                    <div>
                      <label
                        htmlFor={`relatedFieldDefinitionId-${action.id}`}
                        className="block text-sm font-medium text-slate-800"
                      >
                        Related Record Field
                      </label>
                      <select
                        id={`relatedFieldDefinitionId-${action.id}`}
                        name={`relatedFieldDefinitionId:${action.id}`}
                        value={action.relatedFieldDefinitionId}
                        onChange={(event) =>
                          handleActionRelatedFieldChange(
                            action.id,
                            event.currentTarget.value,
                          )
                        }
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
                      <FieldError
                        message={
                          state.errors[`relatedFieldDefinitionId:${action.id}`]
                        }
                      />
                      {targetContext ? (
                        <p className="mt-1 text-sm text-slate-500">
                          Updates one related {targetContext.entityType.name} record.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <FieldError message={state.errors[`action:${action.id}`]} />

                <h4 className="mb-3 mt-4 text-sm font-semibold text-slate-950">
                  {action.actionType === "update_record" ||
                  action.actionType === "update_related_record"
                    ? "Update Fields"
                    : "Set Fields"}
                </h4>
                <div className="flex flex-col gap-3">
                  {renderedTargetFields.map((targetField) => {
                    const mapping =
                      action.mappings[targetField.id] ??
                      getDefaultMapping(targetField, action.actionType);
                    const compatibleSourceFields = triggerContext
                      ? getSelectableFields({
                          fields: triggerContext.fields,
                          selectedFieldId: mapping.sourceFieldDefinitionId,
                        }).filter((sourceField) =>
                          areFieldsCompatible(sourceField, targetField),
                        )
                      : [];
                    const fieldKey = (prefix: string) =>
                      `${prefix}:${action.id}:${targetField.id}`;

                    return (
                      <div
                        key={targetField.id}
                        className="grid gap-3 border border-slate-200 p-4 md:grid-cols-[1fr_180px_1fr]"
                      >
                        <input
                          name={`targetFieldDefinitionId:${action.id}`}
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
                              onClick={() =>
                                removeActionMapping(action.id, targetField.id)
                              }
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
                            name={fieldKey("mappingType")}
                            value={mapping.type}
                            onChange={(event) => {
                              const value = event.currentTarget
                                .value as LocalMapping["type"];

                              updateActionMapping(
                                action.id,
                                targetField.id,
                                (current) => ({
                                  ...current,
                                  type: value,
                                }),
                              );
                            }}
                            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
                          >
                            {action.actionType === "update_record" ||
                            action.actionType === "update_related_record" ? (
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
                          <FieldError message={state.errors[fieldKey("mappingType")]} />
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
                                name={fieldKey("constantValue")}
                                options={
                                  targetContext?.relationOptionsByFieldId[
                                    targetField.id
                                  ] ?? []
                                }
                                error={state.errors[fieldKey("constantValue")]}
                                onChange={(value) =>
                                  updateActionMapping(
                                    action.id,
                                    targetField.id,
                                    (current) => ({
                                      ...current,
                                      constantValue: value,
                                    }),
                                  )
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
                                name={fieldKey("templateValue")}
                                value={mapping.template}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;

                                  updateActionMapping(
                                    action.id,
                                    targetField.id,
                                    (current) => ({
                                      ...current,
                                      template: value,
                                    }),
                                  );
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
                                          updateActionMapping(
                                            action.id,
                                            targetField.id,
                                            (current) => ({
                                              ...current,
                                              template: `${current.template}${token}`,
                                            }),
                                          )
                                        }
                                        className="border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-950 hover:text-slate-950"
                                      >
                                        {label}
                                      </button>
                                    );
                                  },
                                )}
                              </div>
                              <FieldError
                                message={state.errors[fieldKey("templateValue")]}
                              />
                            </>
                          ) : null}

                          {mapping.type === "source_field" ? (
                            <>
                              <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                                Source Field
                              </label>
                              <select
                                name={fieldKey("sourceFieldDefinitionId")}
                                value={mapping.sourceFieldDefinitionId}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;

                                  updateActionMapping(
                                    action.id,
                                    targetField.id,
                                    (current) => ({
                                      ...current,
                                      sourceFieldDefinitionId: value,
                                    }),
                                  );
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
                                  state.errors[fieldKey("sourceFieldDefinitionId")]
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
