-- Phase 14.1: global, owner-controlled personal display preferences.
-- Workspace timezone and all scheduling semantics remain separate.

create table user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'system'
    check (theme in ('system', 'light', 'dark')),
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_preferences enable row level security;
revoke all on table user_preferences from public, anon, authenticated;

create policy user_preferences_select_own on user_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function get_user_preferences_authorized()
returns table(theme text, timezone text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select preferences.theme, preferences.timezone
  from user_preferences preferences
  where preferences.user_id = auth.uid();
end;
$$;

create or replace function update_user_preferences_authorized(
  p_theme text,
  p_timezone text
)
returns table(theme text, timezone text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text := nullif(btrim(p_timezone), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_theme not in ('system', 'light', 'dark') then
    raise exception 'Invalid theme';
  end if;

  if v_timezone is not null and not exists (
    select 1 from pg_timezone_names where name = v_timezone
  ) then
    raise exception 'Unrecognized timezone: %', v_timezone;
  end if;

  if exists (
    select 1 from impersonation_sessions
    where real_actor_user_id = v_user_id and ended_at is null
  ) then
    raise exception 'Exit impersonation before changing personal settings';
  end if;

  insert into user_preferences (user_id, theme, timezone)
  values (v_user_id, p_theme, v_timezone)
  on conflict (user_id) do update
    set theme = excluded.theme,
        timezone = excluded.timezone,
        updated_at = now();

  return query
  select preferences.theme, preferences.timezone
  from user_preferences preferences
  where preferences.user_id = v_user_id;
end;
$$;

revoke all on function get_user_preferences_authorized() from public, anon, service_role;
grant execute on function get_user_preferences_authorized() to authenticated;
revoke all on function update_user_preferences_authorized(text, text) from public, anon, service_role;
grant execute on function update_user_preferences_authorized(text, text) to authenticated;
