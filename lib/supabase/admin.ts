import { createClient } from "@supabase/supabase-js";

// SUPABASE_SECRET_KEY is reserved for narrow server-trusted paths:
// E2E/bootstrap administration, internal scheduler routes that execute
// service_role-only RPCs, and provisioning the auth.users row for a token-
// verified workspace invitation accepted by a genuinely new person. Never
// use this client to mint or swap a session for an existing user.
export function createAdminSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY environment variable.");
  }

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
