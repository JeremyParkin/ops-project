"use client";

import { useActionState, useState } from "react";
import type { EntityTypeActionState } from "@/app/actions";
import type { EntityTypeWorkSettingsConfig } from "@/lib/domain/work-repository";
import type { ChoiceOption, FieldDefinition } from "@/lib/domain/types";

const initialState: EntityTypeActionState = { success: false, message: "" };

// Two forms, two actions, deliberately: the mapping (assignment/due/
// status/completion) and the enabled flag are two separate RPCs (see
// lib/domain/work-repository.ts), so a disable/enable click can never
// carry stale or omitted mapping fields along with it. Says nothing about
// My Work rendering, notification mechanics, or RPC names -- only what a
// builder needs to decide.
export function EntityTypeWorkSettingsForm({
  entityTypeId,
  workspaceMemberFields,
  dateFields,
  choiceFields,
  optionsByFieldId,
  config,
  mappingAction,
  enabledAction,
}: {
  entityTypeId: string;
  workspaceMemberFields: FieldDefinition[];
  dateFields: FieldDefinition[];
  choiceFields: FieldDefinition[];
  optionsByFieldId: Record<string, ChoiceOption[]>;
  config: EntityTypeWorkSettingsConfig;
  mappingAction: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
  enabledAction: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
}) {
  const [mappingState, mappingFormAction, mappingPending] = useActionState(mappingAction, initialState);
  const [enabledState, enabledFormAction, enabledPending] = useActionState(enabledAction, initialState);
  const [statusFieldId, setStatusFieldId] = useState(config.statusFieldId ?? "");

  const configuredOptionIds = new Set(config.completionOptionIds);
  // Active options for the chosen field, plus any already-configured
  // option even if it has since been archived -- archiving a Choice option
  // never invalidates it as a completion state for records that already
  // reached it, so it must stay visible/checked here, not silently drop
  // off the form.
  const optionsForStatusField = (optionsByFieldId[statusFieldId] ?? []).filter(
    (option) => !option.archivedAt || configuredOptionIds.has(option.id),
  );

  return (
    <div className="grid gap-5">
      <p className="text-sm text-slate-600">
        Records assigned through this field can appear in My Work and trigger assignment notifications.
        Assignment does not grant edit or view permissions on its own -- this record&apos;s existing visibility
        and edit rules still apply to whoever it&apos;s assigned to.
      </p>

      {workspaceMemberFields.length === 0 ? (
        <p className="text-sm text-amber-700" role="status">
          Add a Workspace Member field to this object before turning on Work.
        </p>
      ) : null}

      <form action={mappingFormAction} className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor={`work-assignment-field-${entityTypeId}`} className="block text-sm font-medium text-slate-800">
            Assignment field
          </label>
          <select
            id={`work-assignment-field-${entityTypeId}`}
            name="assignmentFieldId"
            disabled={workspaceMemberFields.length === 0}
            defaultValue={config.assignmentFieldId ?? ""}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">Choose a field</option>
            {workspaceMemberFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">Required to enable Work. The Workspace Member field that means &quot;assignee.&quot;</p>
        </div>

        <div>
          <label htmlFor={`work-due-field-${entityTypeId}`} className="block text-sm font-medium text-slate-800">
            Due date field
          </label>
          <select
            id={`work-due-field-${entityTypeId}`}
            name="dueFieldId"
            defaultValue={config.dueFieldId ?? ""}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="">None</option>
            {dateFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">Optional. Shown and sorted on in My Work when set.</p>
        </div>

        <div>
          <label htmlFor={`work-status-field-${entityTypeId}`} className="block text-sm font-medium text-slate-800">
            Status field
          </label>
          <select
            id={`work-status-field-${entityTypeId}`}
            name="statusFieldId"
            defaultValue={config.statusFieldId ?? ""}
            onChange={(event) => setStatusFieldId(event.target.value)}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="">None</option>
            {choiceFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">Optional. The Choice field that tracks this work&apos;s state.</p>
        </div>

        <div className="md:col-span-2">
          {statusFieldId ? (
            <fieldset className="border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium text-slate-800">Completed when</legend>
              {optionsForStatusField.length === 0 ? (
                <p className="text-sm text-slate-600">This field has no active options yet.</p>
              ) : (
                <div className="grid gap-2">
                  {optionsForStatusField.map((option) => (
                    <label key={option.id} className="flex items-center gap-2 text-sm text-slate-800">
                      <input
                        type="checkbox"
                        name="completionOptionIds"
                        value={option.id}
                        defaultChecked={configuredOptionIds.has(option.id)}
                        className="h-4 w-4"
                      />
                      {option.label}
                      {option.archivedAt ? " (archived)" : ""}
                    </label>
                  ))}
                </div>
              )}
              <p className="mt-2 text-sm text-slate-600">
                Select every status that means this record&apos;s work is done. Assigned records reaching one of
                these leave My Work; none selected means status never removes a record on its own.
              </p>
            </fieldset>
          ) : (
            <p className="text-sm text-slate-600">
              No status field is configured. Without one, assigned records have no configured &quot;done&quot;
              state and stay eligible until they&apos;re unassigned, archived, or Work is disabled for this
              object.
            </p>
          )}
        </div>

        <input type="hidden" name="entityTypeId" value={entityTypeId} />

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={mappingPending}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
          >
            {mappingPending ? "Saving..." : "Save mapping"}
          </button>
        </div>

        {mappingState.message ? (
          <p
            className={`md:col-span-2 text-sm ${mappingState.success ? "text-emerald-700" : "text-red-700"}`}
            role={mappingState.success ? "status" : "alert"}
          >
            {mappingState.message}
          </p>
        ) : null}
      </form>

      <form action={enabledFormAction} className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
        <p className="text-sm text-slate-700">
          Work is currently <strong>{config.workEnabled ? "enabled" : "disabled"}</strong> for this object.
          {!config.workEnabled ? " Its mapping above is kept, not cleared, while disabled." : ""}
        </p>
        <input type="hidden" name="enabled" value={(!config.workEnabled).toString()} />
        <button
          type="submit"
          disabled={enabledPending || (!config.workEnabled && !config.assignmentFieldId)}
          className="inline-flex h-9 items-center justify-center border border-slate-950 px-3 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
        >
          {enabledPending ? "Saving..." : config.workEnabled ? "Disable Work" : "Enable Work"}
        </button>
        {enabledState.message ? (
          <p
            className={`w-full text-sm ${enabledState.success ? "text-emerald-700" : "text-red-700"}`}
            role={enabledState.success ? "status" : "alert"}
          >
            {enabledState.message}
          </p>
        ) : null}
      </form>
    </div>
  );
}
