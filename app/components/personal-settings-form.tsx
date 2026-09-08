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
      <section className="mt-6 border-t border-border pt-5">
        <SectionHeader title="Notification preferences" description="Choose which optional in-app updates follow you across workspaces." />
        <div className="mt-4 grid gap-3">
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input type="checkbox" name="notifyCommentMentions" defaultChecked={preferences.notifyCommentMentions} className="mt-1" />
            <span><span className="font-medium">Mentions</span><span className="block text-xs text-muted">Notify me when someone mentions me in a discussion.</span></span>
          </label>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input type="checkbox" name="notifyInputRequestStatusUpdates" defaultChecked={preferences.notifyInputRequestStatusUpdates} className="mt-1" />
            <span><span className="font-medium">Request-for-Input updates</span><span className="block text-xs text-muted">Notify me when a request I created is answered or cancelled.</span></span>
          </label>
        </div>
        <p className="mt-4 text-xs text-muted">Assigned work, deadlines, and new Requests for Input remain enabled because they signal operational work.</p>
      </section>
      <button type="submit" disabled={pending} className="mt-5 h-9 bg-accent px-3 text-sm font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-60">
        {pending ? "Saving..." : "Save"}
      </button>
      {state.message ? <p className={`mt-3 text-sm ${state.success ? "text-success" : "text-error"}`} role={state.success ? "status" : "alert"}>{state.message}</p> : null}
    </form>
  );
}
