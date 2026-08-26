import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function getSupabaseConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variable.",
    );
  }

  return {
    supabaseUrl,
    supabasePublishableKey,
  };
}

// Shared type for the handful of repository functions on the process
// action-execution path that accept an injectable client: per-request
// callers omit it (this per-cookie-session client, unchanged), while the
// wait/condition-wait scheduler passes its admin client so a newly-activated
// action node executes under service_role, not a stale/absent user session.
export type SupabaseServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export async function createServerSupabaseClient() {
  const { supabaseUrl, supabasePublishableKey } = getSupabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes sessions.
        }
      },
    },
  });
}
