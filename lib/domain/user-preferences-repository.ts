import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";
import { DEFAULT_USER_PREFERENCES, type UserPreferences, type UserTheme } from "./user-preferences-types";

type UserPreferencesRow = { theme: UserTheme; timezone: string | null };

function firstPreferencesRow(data: unknown): UserPreferencesRow | undefined {
  return Array.isArray(data) ? data[0] as UserPreferencesRow | undefined : undefined;
}

function mapPreferences(row: UserPreferencesRow | null | undefined): UserPreferences {
  if (!row || !["system", "light", "dark"].includes(row.theme)) {
    return DEFAULT_USER_PREFERENCES;
  }
  return { theme: row.theme, timezone: row.timezone ?? null };
}

export async function getUserPreferences({
  supabase: injectedSupabase,
}: { supabase?: SupabaseServerClient } = {}): Promise<UserPreferences> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("get_user_preferences_authorized").returns<UserPreferencesRow[]>();
  if (error) throw new Error(`Unable to load personal settings: ${error.message}`);
  return mapPreferences(firstPreferencesRow(data));
}

export async function updateUserPreferences({
  theme,
  timezone,
  supabase: injectedSupabase,
}: UserPreferences & { supabase?: SupabaseServerClient }): Promise<UserPreferences> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("update_user_preferences_authorized", {
    p_theme: theme,
    p_timezone: timezone,
  }).returns<UserPreferencesRow[]>();
  if (error) throw new Error(`Unable to save personal settings: ${error.message}`);
  return mapPreferences(firstPreferencesRow(data));
}
