"use client";

import { useActionState } from "react";
import { setWorkspaceTimezoneAction, type WorkspaceSettingsActionState } from "@/app/workspace-settings-actions";
import { SectionHeader } from "@/app/components/page-primitives";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const initialState: WorkspaceSettingsActionState = { success: false, message: "" };

export function WorkspaceTimezoneSettings({ currentTimezone }: { currentTimezone: string }) {
  const [state, formAction, pending] = useActionState(setWorkspaceTimezoneAction, initialState);
  // A `<select>` always shows every option on open, regardless of the
  // current value -- unlike the previous `<input list>`/`<datalist>`
  // combobox, whose suggestions were filtered against the field's existing
  // text. Every workspace defaults to "UTC", so that filtering silently hid
  // every other option the moment a user opened the control (found via real
  // hosted dogfood, not a hypothetical). Defensively including the current
  // value here (if a workspace was ever set to something outside this
  // curated list some other way) means switching to a constrained <select>
  // can never silently misrepresent an already-stored valid timezone.
  const timezoneOptions = COMMON_TIMEZONES.includes(currentTimezone)
    ? COMMON_TIMEZONES
    : [currentTimezone, ...COMMON_TIMEZONES];

  return (
    <section className="mx-auto w-full max-w-6xl border border-grit bg-paper p-5">
      <SectionHeader
        title="Workspace timezone"
        description="Used to interpret local time-of-day scheduling, such as recurring process runs. Does not affect individual users' displayed times."
      />
      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-graphite">
          Timezone
          <select
            name="timezone"
            defaultValue={currentTimezone}
            className="h-9 w-72 border border-grit bg-white px-2 text-sm text-graphite"
          >
            {timezoneOptions.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="h-9 bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </form>
      {state.message ? (
        <p
          className={`mt-2 text-sm ${state.success ? "text-status-sage" : "text-red-700"}`}
          role={state.success ? "status" : "alert"}
        >
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
