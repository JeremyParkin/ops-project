"use client";

// Shared action-configuration fields: the WorkflowAction shape (action type,
// target entity/relation/process template, field mappings) rendered once so
// both the Workflow editor and the Process action-node editor can configure
// the same canonical action machinery identically, instead of duplicating
// this UI in two places.
import type { EntityType, FieldDefinition } from "@/lib/domain/types";
import type { WorkflowAction, WorkflowActionType, WorkflowFieldMapping } from "@/lib/domain/workflow-types";

export type ActionConfigEntityContext = {
  entityType: EntityType;
  fields: FieldDefinition[];
};

export type ActionConfigProcessTemplateOption = {
  id: string;
  name: string;
};

type MappingSourceType = WorkflowFieldMapping["source"]["type"];

const ACTION_TYPE_LABELS: Record<WorkflowActionType, string> = {
  create_record: "Create a record",
  update_record: "Update this record",
  update_related_record: "Update a related record",
  start_process: "Start a process",
};

function activeFields(fields: FieldDefinition[]) {
  return fields.filter((field) => !field.archivedAt);
}

function defaultSourceForActionType(actionType: WorkflowActionType, field: FieldDefinition): WorkflowFieldMapping["source"] {
  if (actionType === "create_record") {
    return field.required ? { type: "constant", value: "" } : { type: "unset" };
  }
  return { type: "leave_unchanged" };
}

function sourceTypeOptions(actionType: WorkflowActionType, field: FieldDefinition): MappingSourceType[] {
  const base: MappingSourceType[] =
    actionType === "create_record" ? ["unset", "constant", "source_field", "template"] : ["leave_unchanged", "clear", "constant", "source_field", "template"];

  if (field.type === "relation") {
    return base.filter((type) => type !== "constant" && type !== "template");
  }

  return base;
}

function ConstantValueInput({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <select
        aria-label={`${field.name} value`}
        value={value === true ? "true" : "false"}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
        className="h-9 border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  if (field.type === "number") {
    return (
      <input
        aria-label={`${field.name} value`}
        type="number"
        value={typeof value === "number" ? value : ""}
        onChange={(event) => onChange(event.currentTarget.value === "" ? 0 : Number(event.currentTarget.value))}
        className="h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
      />
    );
  }

  if (field.type === "date") {
    return (
      <input
        aria-label={`${field.name} value`}
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
      />
    );
  }

  return (
    <input
      aria-label={`${field.name} value`}
      type="text"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
    />
  );
}

function MappingRow({
  idPrefix,
  field,
  actionType,
  mapping,
  sourceFields,
  onChange,
}: {
  idPrefix: string;
  field: FieldDefinition;
  actionType: WorkflowActionType;
  mapping: WorkflowFieldMapping | undefined;
  sourceFields: FieldDefinition[];
  onChange: (source: WorkflowFieldMapping["source"]) => void;
}) {
  const source = mapping?.source ?? defaultSourceForActionType(actionType, field);
  const options = sourceTypeOptions(actionType, field);
  const compatibleSourceFields = sourceFields.filter(
    (candidate) => !candidate.archivedAt && candidate.type === field.type && candidate.relatedEntityTypeId === field.relatedEntityTypeId,
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-grit py-2 first:border-t-0">
      <span className="w-40 shrink-0 text-sm text-graphite">{field.name}</span>
      <select
        aria-label={`${field.name} source`}
        value={source.type}
        onChange={(event) => {
          const nextType = event.currentTarget.value as MappingSourceType;
          if (nextType === "constant") onChange({ type: "constant", value: "" });
          else if (nextType === "source_field") onChange({ type: "source_field", sourceFieldDefinitionId: "" });
          else if (nextType === "template") onChange({ type: "template", template: "" });
          else onChange({ type: nextType as "unset" | "leave_unchanged" | "clear" });
        }}
        className="h-9 border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
      >
        {options.map((type) => (
          <option key={type} value={type}>
            {type === "unset"
              ? "Leave unset"
              : type === "leave_unchanged"
                ? "Leave unchanged"
                : type === "clear"
                  ? "Clear"
                  : type === "constant"
                    ? "Fixed value"
                    : type === "source_field"
                      ? "Copy from field"
                      : "Text template"}
          </option>
        ))}
      </select>

      {source.type === "constant" ? (
        <ConstantValueInput field={field} value={source.value} onChange={(value) => onChange({ type: "constant", value })} />
      ) : null}

      {source.type === "source_field" ? (
        <select
          aria-label={`${field.name} source field`}
          value={source.sourceFieldDefinitionId}
          onChange={(event) => onChange({ type: "source_field", sourceFieldDefinitionId: event.currentTarget.value })}
          className="h-9 border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
        >
          <option value="">Choose a field</option>
          {compatibleSourceFields.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      ) : null}

      {source.type === "template" ? (
        <input
          id={`${idPrefix}-template-${field.id}`}
          type="text"
          value={source.template}
          onChange={(event) => onChange({ type: "template", template: event.currentTarget.value })}
          placeholder="e.g. Follow-up for {{field:...}}"
          className="h-9 flex-1 border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
        />
      ) : null}
    </div>
  );
}

export type WorkflowActionConfigFieldsProps = {
  idPrefix: string;
  value: WorkflowAction;
  onChange: (next: WorkflowAction) => void;
  // Fields of the record this action executes against (the process/workflow
  // origin record), used both for update_record's own target fields and as
  // the "copy from field" source options everywhere.
  sourceFields: FieldDefinition[];
  entityContexts: ActionConfigEntityContext[];
  processTemplates: ActionConfigProcessTemplateOption[];
  fieldError?: string;
};

export function WorkflowActionConfigFields({
  idPrefix,
  value,
  onChange,
  sourceFields,
  entityContexts,
  processTemplates,
  fieldError,
}: WorkflowActionConfigFieldsProps) {
  const relationFields = activeFields(sourceFields).filter((field) => field.type === "relation" && field.relatedEntityTypeId);
  const relatedField = relationFields.find((field) => field.id === value.relatedFieldDefinitionId);
  const targetFields =
    value.actionType === "create_record"
      ? activeFields(entityContexts.find((context) => context.entityType.id === value.actionTargetEntityTypeId)?.fields ?? [])
      : value.actionType === "update_record"
        ? activeFields(sourceFields)
        : value.actionType === "update_related_record" && relatedField?.relatedEntityTypeId
          ? activeFields(entityContexts.find((context) => context.entityType.id === relatedField.relatedEntityTypeId)?.fields ?? [])
          : [];
  const mappingByFieldId = new Map(value.fieldMappings.map((mapping) => [mapping.targetFieldDefinitionId, mapping]));

  function setMapping(fieldId: string, source: WorkflowFieldMapping["source"]) {
    const nextMappings = value.fieldMappings.filter((mapping) => mapping.targetFieldDefinitionId !== fieldId);
    nextMappings.push({ targetFieldDefinitionId: fieldId, source } as WorkflowFieldMapping);
    onChange({ ...value, fieldMappings: nextMappings });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label htmlFor={`${idPrefix}-action-type`} className="block text-xs font-medium uppercase tracking-wide text-stone">
          Action type
        </label>
        <select
          id={`${idPrefix}-action-type`}
          value={value.actionType}
          onChange={(event) =>
            onChange({
              actionType: event.currentTarget.value as WorkflowActionType,
              actionTargetEntityTypeId: undefined,
              relatedFieldDefinitionId: undefined,
              processTemplateId: undefined,
              fieldMappings: [],
            })
          }
          className="mt-1 h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
        >
          {(Object.keys(ACTION_TYPE_LABELS) as WorkflowActionType[]).map((actionType) => (
            <option key={actionType} value={actionType}>
              {ACTION_TYPE_LABELS[actionType]}
            </option>
          ))}
        </select>
      </div>

      {value.actionType === "create_record" ? (
        <div>
          <label htmlFor={`${idPrefix}-target-entity`} className="block text-xs font-medium uppercase tracking-wide text-stone">
            Create in
          </label>
          <select
            id={`${idPrefix}-target-entity`}
            value={value.actionTargetEntityTypeId ?? ""}
            onChange={(event) => onChange({ ...value, actionTargetEntityTypeId: event.currentTarget.value, fieldMappings: [] })}
            className="mt-1 h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
          >
            <option value="">Choose an entity</option>
            {entityContexts.map((context) => (
              <option key={context.entityType.id} value={context.entityType.id}>
                {context.entityType.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {value.actionType === "update_related_record" ? (
        <div>
          <label htmlFor={`${idPrefix}-related-field`} className="block text-xs font-medium uppercase tracking-wide text-stone">
            Related record
          </label>
          <select
            id={`${idPrefix}-related-field`}
            value={value.relatedFieldDefinitionId ?? ""}
            onChange={(event) => onChange({ ...value, relatedFieldDefinitionId: event.currentTarget.value, fieldMappings: [] })}
            className="mt-1 h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
          >
            <option value="">Choose a relation field</option>
            {relationFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {value.actionType === "start_process" ? (
        <div>
          <label htmlFor={`${idPrefix}-process-template`} className="block text-xs font-medium uppercase tracking-wide text-stone">
            Process template
          </label>
          <select
            id={`${idPrefix}-process-template`}
            value={value.processTemplateId ?? ""}
            onChange={(event) => onChange({ ...value, processTemplateId: event.currentTarget.value })}
            className="mt-1 h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
          >
            <option value="">Choose a process template</option>
            {processTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {value.actionType !== "start_process" && targetFields.length > 0 ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone">Field values</p>
          <div className="mt-1 border border-grit px-3">
            {targetFields.map((field) => (
              <MappingRow
                key={field.id}
                idPrefix={idPrefix}
                field={field}
                actionType={value.actionType}
                mapping={mappingByFieldId.get(field.id)}
                sourceFields={sourceFields}
                onChange={(source) => setMapping(field.id, source)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {fieldError ? (
        <p className="text-sm text-red-700" role="alert">
          {fieldError}
        </p>
      ) : null}
    </div>
  );
}
