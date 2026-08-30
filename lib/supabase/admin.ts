import { createClient } from "@supabase/supabase-js";

// SUPABASE_SECRET_KEY is otherwise reserved for E2E fixtures/bootstrap
// administration only (see supabase/README.md) -- normal application
// runtime must not use it. This is the one narrow, approved exception:
// provisioning the auth.users row for a token-verified workspace invitation
// accepted by a genuinely new person (accept_workspace_invitation_authorized
// itself still separately re-validates the token/email/expiry before any
// workspace access is granted). Never use this client to mint or swap a
// session for an existing user, or for anything beyond account creation.
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
