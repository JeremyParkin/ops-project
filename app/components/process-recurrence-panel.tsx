"use client";

import { useActionState, useState } from "react";
import type { ProcessActionState } from "@/app/process-actions";
import type { ProcessRecurrenceRule, RecurrenceFrequency } from "@/lib/domain/recurrence-types";

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type RecurrenceAction = (
  state: ProcessActionState,
  formData: FormData,
) => Promise<ProcessActionState>;

type ProcessRecurrencePanelProps = {
  rule?: ProcessRecurrenceRule;
  workspaceTimezone: string;
  createAction: RecurrenceAction;
  updateAction: RecurrenceAction;
  setActiveAction: RecurrenceAction;
};

const initialActionState: ProcessActionState = { success: false, message: "" };

function summarizeRule(rule: ProcessRecurrenceRule): string {
  const every = rule.intervalCount === 1 ? "" : `every ${rule.intervalCount} `;

  if (rule.frequency === "daily") {
    return `Repeats ${every ? `${every}days` : "daily"} at ${rule.timeOfDay}`;
  }

  if (rule.frequency === "weekly") {
    const day = WEEKDAY_LABELS[rule.dayOfWeek ?? 0];
    return `Repeats ${every ? `${every}weeks` : "weekly"} on ${day} at ${rule.timeOfDay}`;
  }

  return `Repeats ${every ? `${every}months` : "monthly"} on day ${rule.dayOfMonth} at ${rule.timeOfDay}`;
}

function RecurrenceFields({
  idPrefix,
  workspaceTimezone,
  defaults,
}: {
  idPrefix: string;
  workspaceTimezone: string;
  defaults?: ProcessRecurrenceRule;
}) {
  const [frequency, setFrequency] = useState<RecurrenceFrequency>(defaults?.frequency ?? "monthly");

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Repeats
          <select
            name="frequency"
            defaultValue={defaults?.frequency ?? "monthly"}
            onChange={(event) => setFrequency(event.target.value as RecurrenceFrequency)}
            className="h-9 border border-grit bg-paper px-2 text-sm text-graphite"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Every
          <span className="flex items-center gap-2">
            <input
              type="number"
              name="intervalCount"
              min={1}
              max={999}
              defaultValue={defaults?.intervalCount ?? 1}
              className="h-9 w-20 border border-grit bg-paper px-2 text-sm text-graphite"
            />
            <span className="text-sm text-stone">
              {frequency === "daily" ? "day(s)" : frequency === "weekly" ? "week(s)" : "month(s)"}
            </span>
          </span>
        </label>
      </div>

      {frequency === "weekly" ? (
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Day
          <select
            name="dayOfWeek"
            defaultValue={defaults?.dayOfWeek ?? 1}
            className="h-9 border border-grit bg-paper px-2 text-sm text-graphite"
          >
            {WEEKDAY_LABELS.map((label, index) => (
              <option key={label} value={index}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {frequency === "monthly" ? (
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Day
          <input
            type="number"
            name="dayOfMonth"
            min={1}
            max={31}
            defaultValue={defaults?.dayOfMonth ?? 1}
            className="h-9 w-24 border border-grit bg-paper px-2 text-sm text-graphite"
          />
          <span className="text-xs text-stone">
            A day that doesn&apos;t exist in a shorter month uses that month&apos;s last day.
          </span>
        </label>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Start date
          <input
            type="date"
            name="startDate"
            defaultValue={defaults?.startDate}
            required
            className="h-9 border border-grit bg-paper px-2 text-sm text-graphite"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-graphite">
          End date (optional)
          <input
            type="date"
            name="endDate"
            defaultValue={defaults?.endDate}
            className="h-9 border border-grit bg-paper px-2 text-sm text-graphite"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Time
          <input
            type="time"
            name="timeOfDay"
            defaultValue={defaults?.timeOfDay ?? "09:00"}
            required
            className="h-9 border border-grit bg-paper px-2 text-sm text-graphite"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Timezone
          <span className="flex h-9 items-center border border-grit bg-chalk px-2 text-sm text-stone">
            {workspaceTimezone}
          </span>
        </label>
      </div>
      <p className="text-xs text-stone" id={`${idPrefix}-timezone-note`}>
        Set for the whole workspace in Configure → Workspace settings.
      </p>
    </>
  );
}

export function ProcessRecurrencePanel({
  rule,
  workspaceTimezone,
  createAction,
  updateAction,
  setActiveAction,
}: ProcessRecurrencePanelProps) {
  const [createState, createFormAction, createPending] = useActionState(
    createAction,
    initialActionState,
  );
  const [updateState, updateFormAction, updatePending] = useActionState(
    updateAction,
    initialActionState,
  );
  const [toggleState, toggleFormAction, togglePending] = useActionState(
    setActiveAction,
    initialActionState,
  );
  const [isEditing, setIsEditing] = useState(false);

  if (!rule) {
    return (
      <details className="mt-2">
        <summary className="cursor-pointer text-sm font-medium text-graphite underline-offset-4 hover:underline">
          Set up a recurring schedule
        </summary>
        <form action={createFormAction} className="mt-3 flex flex-col gap-3 border border-grit p-3">
          <RecurrenceFields idPrefix="create" workspaceTimezone={workspaceTimezone} />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={createPending}
              className="h-9 bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
            >
              {createPending ? "Saving..." : "Save schedule"}
            </button>
            {createState.message ? (
              <p className="text-xs text-red-700" role="alert">
                {createState.message}
              </p>
            ) : null}
          </div>
        </form>
      </details>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-chalk pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-stone">
          {summarizeRule(rule)} ({workspaceTimezone}){rule.active ? "" : " · Disabled"}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsEditing((value) => !value)}
            className="text-xs font-medium text-graphite underline-offset-4 hover:underline"
          >
            {isEditing ? "Cancel" : "Edit"}
          </button>
          <form action={toggleFormAction}>
            <input type="hidden" name="active" value={(!rule.active).toString()} />
            <button
              type="submit"
              disabled={togglePending}
              className="text-xs font-medium text-graphite underline-offset-4 hover:underline"
            >
              {rule.active ? "Disable" : "Enable"}
            </button>
          </form>
        </div>
      </div>
      {toggleState.message ? (
        <p className="text-xs text-red-700" role="alert">
          {toggleState.message}
        </p>
      ) : null}
      {isEditing ? (
        <form action={updateFormAction} className="flex flex-col gap-3 border border-grit p-3">
          <RecurrenceFields idPrefix="edit" workspaceTimezone={workspaceTimezone} defaults={rule} />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={updatePending}
              className="h-9 bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
            >
              {updatePending ? "Saving..." : "Save changes"}
            </button>
            {updateState.message ? (
              <p className="text-xs text-red-700" role="alert">
                {updateState.message}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
