"use client";

import { useActionState, useState } from "react";
import type { EntityTypeActionState } from "@/app/actions";
import type { EntityTypeWorkSettingsConfig } from "@/lib/domain/work-repository";
import type { ChoiceOption, FieldDefinition } from "@/lib/domain/types";

const initialState: EntityTypeActionState = { success: false, message: "" };

function sameOptionSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

type WorkState = "not-configured" | "configured" | "active";

function currentWorkState(config: EntityTypeWorkSettingsConfig): WorkState {
  if (config.workEnabled) return "active";
  if (config.assignmentFieldId) return "configured";
  return "not-configured";
}

function StateBadge({ state }: { state: WorkState }) {
  const label =
    state === "active" ? "Active" : state === "configured" ? "Configured, not active" : "Not configured";
  const className =
    state === "active"
      ? "bg-emerald-100 text-emerald-800"
      : state === "configured"
        ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-600";

  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>
  );
}

// The mapping fields' own local (uncommitted) selections, isolated into a
// component keyed by the persisted config below -- React's own recommended
// way to "reset state when a prop changes" without an effect/setState pair.
// Every successful save (or a disable, which never touches the mapping)
// produces a fresh config, which remounts this with fresh initial state, so
// local selections always converge on what's truly persisted without ever
// clobbering an in-progress unsaved edit from an unrelated re-render.
function WorkMappingFields({
  entityTypeId,
  workspaceMemberFields,
  dateFields,
  choiceFields,
  optionsByFieldId,
  config,
  state,
  saveFormAction,
  saveState,
  pending,
  savePending,
  onSubmit,
}: {
  entityTypeId: string;
  workspaceMemberFields: FieldDefinition[];
  dateFields: FieldDefinition[];
  choiceFields: FieldDefinition[];
  optionsByFieldId: Record<string, ChoiceOption[]>;
  config: EntityTypeWorkSettingsConfig;
  state: WorkState;
  saveFormAction: (formData: FormData) => void;
  saveState: EntityTypeActionState;
  pending: boolean;
  savePending: boolean;
  onSubmit: () => void;
}) {
  const [assignmentFieldId, setAssignmentFieldId] = useState(config.assignmentFieldId ?? "");
  const [dueFieldId, setDueFieldId] = useState(config.dueFieldId ?? "");
  const [statusFieldId, setStatusFieldId] = useState(config.statusFieldId ?? "");
  const [completionOptionIds, setCompletionOptionIds] = useState<string[]>(config.completionOptionIds);

  const dirty =
    assignmentFieldId !== (config.assignmentFieldId ?? "") ||
    dueFieldId !== (config.dueFieldId ?? "") ||
    statusFieldId !== (config.statusFieldId ?? "") ||
    !sameOptionSet(completionOptionIds, config.completionOptionIds);

  const configuredOptionIds = new Set(config.completionOptionIds);
  // Active options for the chosen field, plus any already-configured option
  // even if it has since been archived -- archiving a Choice option never
  // invalidates it as a completion state for records that already reached
  // it, so it must stay visible/checked here, not silently drop off the
  // form.
  const optionsForStatusField = (optionsByFieldId[statusFieldId] ?? []).filter(
    (option) => !option.archivedAt || configuredOptionIds.has(option.id),
  );

  function toggleCompletionOption(optionId: string, checked: boolean) {
    setCompletionOptionIds((current) =>
      checked ? [...current, optionId] : current.filter((id) => id !== optionId),
    );
  }

  return (
    <>
      {dirty ? (
        <span className="text-xs font-medium text-amber-700">
          Unsaved changes -- selections below don&apos;t take effect until you save.
        </span>
      ) : null}

      <form
        action={saveFormAction}
        onSubmit={onSubmit}
        className="grid gap-4 border border-slate-200 p-4 md:grid-cols-2"
      >
        <div>
          <label htmlFor={`work-assignment-field-${entityTypeId}`} className="block text-sm font-medium text-slate-800">
            Who is responsible for this work?
          </label>
          <select
            id={`work-assignment-field-${entityTypeId}`}
            name="assignmentFieldId"
            disabled={workspaceMemberFields.length === 0}
            value={assignmentFieldId}
            onChange={(event) => setAssignmentFieldId(event.target.value)}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950 disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">Choose a field</option>
            {workspaceMemberFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">
            Required to activate. The Workspace Member field that identifies who&apos;s currently expected to
            act on this record.
          </p>
        </div>

        <div>
          <label htmlFor={`work-due-field-${entityTypeId}`} className="block text-sm font-medium text-slate-800">
            Due date field
          </label>
          <select
            id={`work-due-field-${entityTypeId}`}
            name="dueFieldId"
            value={dueFieldId}
            onChange={(event) => setDueFieldId(event.target.value)}
            className="mt-1 block h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-slate-950"
          >
            <option value="">None</option>
            {dateFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-slate-600">
            Optional. Used to sort and flag overdue items in My Work -- never changes whether a record counts
            as work.
          </p>
        </div>

        <div>
          <label htmlFor={`work-status-field-${entityTypeId}`} className="block text-sm font-medium text-slate-800">
            Status field
          </label>
          <select
            id={`work-status-field-${entityTypeId}`}
            name="statusFieldId"
            value={statusFieldId}
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
                        checked={completionOptionIds.includes(option.id)}
                        onChange={(event) => toggleCompletionOption(option.id, event.target.checked)}
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
              Status is optional. If none is configured, assigned records remain active work until
              they&apos;re unassigned, archived, this object is archived, or Work is turned off here.
            </p>
          )}
        </div>

        <input type="hidden" name="entityTypeId" value={entityTypeId} />

        <div className="md:col-span-2 flex flex-wrap items-center gap-3">
          {state === "active" ? (
            <button
              type="submit"
              name="intent"
              value="save"
              disabled={pending}
              className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
            >
              {savePending ? "Saving..." : "Save changes"}
            </button>
          ) : (
            <>
              <button
                type="submit"
                name="intent"
                value="activate"
                disabled={pending || !assignmentFieldId}
                className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
              >
                {savePending ? "Saving..." : "Save and activate"}
              </button>
              <button
                type="submit"
                name="intent"
                value="save"
                disabled={pending}
                className="inline-flex h-10 items-center justify-center border border-slate-950 px-4 text-sm font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
              >
                {savePending ? "Saving..." : "Save without activating"}
              </button>
              {!assignmentFieldId ? (
                <span className="text-sm text-slate-600">
                  Choose who&apos;s responsible for this work above before activating.
                </span>
              ) : null}
            </>
          )}
        </div>

        {saveState.message ? (
          <p
            className={`md:col-span-2 text-sm ${saveState.success ? "text-emerald-700" : "text-red-700"}`}
            role={saveState.success ? "status" : "alert"}
          >
            {saveState.message}
          </p>
        ) : null}
      </form>
    </>
  );
}

// One coherent Work Settings card, not two independent-looking forms. The
// backend still keeps mapping writes and the enable/disable flag as two
// separate RPCs (see lib/domain/work-repository.ts) -- a disable action must
// never be able to carry stale/omitted mapping fields along with it -- but a
// builder should never have to understand that split. This component's own
// job is to make three things unmistakable at every moment: what's
// currently configured, what's currently saved, and what's currently live
// in My Work -- and to never let "I picked a value in a dropdown" be
// mistaken for "this is now active," which is exactly the dogfood failure
// that motivated this redesign (the mapping was never actually submitted).
export function EntityTypeWorkSettingsForm({
  entityTypeId,
  workspaceMemberFields,
  dateFields,
  choiceFields,
  optionsByFieldId,
  config,
  saveAction,
  deactivateAction,
}: {
  entityTypeId: string;
  workspaceMemberFields: FieldDefinition[];
  dateFields: FieldDefinition[];
  choiceFields: FieldDefinition[];
  optionsByFieldId: Record<string, ChoiceOption[]>;
  config: EntityTypeWorkSettingsConfig;
  saveAction: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
  deactivateAction: (state: EntityTypeActionState, formData: FormData) => Promise<EntityTypeActionState>;
}) {
  const [saveState, saveFormAction, savePending] = useActionState(saveAction, initialState);
  const [deactivateState, deactivateFormAction, deactivatePending] = useActionState(
    deactivateAction,
    initialState,
  );
  // Only one of the two result messages below is ever shown -- whichever
  // form was submitted most recently. Without this, turning Work off after
  // an earlier save left a stale "Saved and activated" message sitting next
  // to a fresh "Configured, not active" badge, which reads as contradictory
  // (caught live: the exact kind of truthfulness gap this redesign exists
  // to close).
  const [lastAction, setLastAction] = useState<"save" | "deactivate" | null>(null);

  const state = currentWorkState(config);
  const pending = savePending || deactivatePending;
  const configKey = [
    config.assignmentFieldId ?? "",
    config.dueFieldId ?? "",
    config.statusFieldId ?? "",
    config.completionOptionIds.join(","),
  ].join("|");

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={state} />
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-800">Treat records of this object as work</p>
        <p className="mt-1 text-sm text-slate-600">
          Enable this only when each record represents something a person is expected to act on. Do not use
          this for ordinary ownership relationships such as Account Manager, Executive Sponsor, or Record
          Owner -- those describe who a record is about or who stays attached to it, not a current task.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          Assignment does not grant edit or view permissions on its own -- this record&apos;s existing
          visibility and edit rules still apply to whoever it&apos;s assigned to.
        </p>
      </div>

      {workspaceMemberFields.length === 0 ? (
        <p className="text-sm text-amber-700" role="status">
          Add a Workspace Member field to this object before turning on Work.
        </p>
      ) : null}

      <WorkMappingFields
        key={configKey}
        entityTypeId={entityTypeId}
        workspaceMemberFields={workspaceMemberFields}
        dateFields={dateFields}
        choiceFields={choiceFields}
        optionsByFieldId={optionsByFieldId}
        config={config}
        state={state}
        saveFormAction={saveFormAction}
        saveState={lastAction === "deactivate" ? initialState : saveState}
        pending={pending}
        savePending={savePending}
        onSubmit={() => setLastAction("save")}
      />

      {state === "active" ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
          <p className="text-sm text-slate-700">
            Work is <strong>active</strong> for this object. Records assigned through the field above appear
            in My Work and trigger assignment notifications.
          </p>
          <form action={deactivateFormAction} onSubmit={() => setLastAction("deactivate")}>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-9 items-center justify-center border border-slate-950 px-3 text-xs font-medium text-slate-950 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
            >
              {deactivatePending ? "Turning off..." : "Turn off Work"}
            </button>
          </form>
        </div>
      ) : null}

      {lastAction === "deactivate" && deactivateState.message ? (
        <p
          className={`text-sm ${deactivateState.success ? "text-emerald-700" : "text-red-700"}`}
          role={deactivateState.success ? "status" : "alert"}
        >
          {deactivateState.message}
        </p>
      ) : null}
    </div>
  );
}
