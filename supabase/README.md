# Supabase Setup

This project uses Supabase Auth and Postgres with Row Level Security (RLS).

Required local environment variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...
```

`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is used by the request-scoped browser
and server clients. `SUPABASE_SECRET_KEY` should be an `sb_secret_...` key from
the Supabase dashboard. It is for E2E fixtures/bootstrap administration only;
normal application runtime must not use it, with one narrow, approved
exception: `lib/supabase/admin.ts`'s `createAdminSupabaseClient()`, used
exclusively by `acceptInvitationCreateAccountAction`
(`app/workspace-invitation-actions.ts`) to call
`admin.auth.admin.createUser({ email, password, email_confirm: true })` when a
token-verified workspace invitation is accepted by a genuinely new person.
This project has no outbound email provider, so Supabase's own signup
confirmation email cannot be delivered; `email_confirm: true` establishes a
usable account without one. The admin client is immediately followed by a
completely ordinary `signInWithPassword()` call using the password the person
themselves just chose -- this is account provisioning, not session minting or
impersonation, and `accept_workspace_invitation_authorized` still
independently re-validates the invitation token/email/status/expiry before
granting any workspace access. Do not extend this exception to any other
runtime code path.

Apply all checked-in migrations in order, then run `seed.sql` to create the
development workspace, Client metadata, and sample records. The seed does not
and must not create an Auth identity or membership.

After creating an Auth email/password user in Supabase, explicitly assign that
user to the seeded workspace. Without this membership, the application
correctly shows the protected no-access state at `/no-workspace`.

Use the Auth user's UUID from the Supabase dashboard or `auth.users` and the
workspace UUID created by `seed.sql`:

```sql
insert into public.workspace_memberships (workspace_id, user_id)
values ('11111111-1111-4111-8111-111111111111', '<auth-user-uuid>');
```
