"use client";

import { useActionState } from "react";
import { SectionHeader } from "@/app/components/page-primitives";
import { updatePersonalSettingsAction, type PersonalSettingsActionState } from "@/app/personal-settings-actions";
import type { UserPreferences } from "@/lib/domain/user-preferences-types";

const TIMEZONES = [
  "UTC", "America/Toronto", "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Sao_Paulo", "Europe/London", "Europe/Paris",
  "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland",
];

const initialState: PersonalSettingsActionState = { success: false, message: "" };

export function PersonalSettingsForm({ preferences }: { preferences: UserPreferences }) {
  const [state, formAction, pending] = useActionState(updatePersonalSettingsAction, initialState);
  return (
    <form action={formAction} className="mx-auto w-full max-w-3xl border border-grit bg-surface p-5">
      <SectionHeader title="Personal display settings" description="These settings follow your account across workspaces and devices." />
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-foreground">
          Appearance
          <select name="theme" defaultValue={preferences.theme} className="h-10 border border-border bg-surface px-2 text-sm text-foreground">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-foreground">
          Display timezone
          <input name="timezone" list="personal-timezone-options" defaultValue={preferences.timezone ?? ""} placeholder="Use device timezone" className="h-10 border border-border bg-surface px-2 text-sm text-foreground" />
          <datalist id="personal-timezone-options">
            {TIMEZONES.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
        </label>
      </div>
      <p className="mt-3 text-xs text-muted">Timezone changes display only. Workspace scheduling, due dates, waits, and analytics are unchanged.</p>
      <button type="submit" disabled={pending} className="mt-5 h-9 bg-accent px-3 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-60">
        {pending ? "Saving..." : "Save"}
      </button>
      {state.message ? <p className={`mt-3 text-sm ${state.success ? "text-success" : "text-error"}`} role={state.success ? "status" : "alert"}>{state.message}</p> : null}
    </form>
  );
}
