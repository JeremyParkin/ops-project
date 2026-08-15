# Supabase Setup

This milestone uses Supabase/Postgres for server-side persistence only.

Required local environment variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
```

`SUPABASE_SECRET_KEY` should be an `sb_secret_...` key from the Supabase
dashboard. It must stay server-only and must not be exposed to browser code.

The current no-auth milestone does not enable Row Level Security policies.
Supabase secret keys bypass RLS and provide elevated access to project data.
When authentication and tenant isolation are introduced, the app will need an
auth-aware security model, such as RLS policies with user-scoped access or an
explicit server-side authorization layer.

Apply the schema in `migrations/0001_initial_schema.sql`, then run `seed.sql`
to create the demo workspace, Client metadata, and sample records.
