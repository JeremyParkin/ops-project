-- Human display names: one nullable, owner-controlled account display name.
-- Stable member references remain auth user_id; email remains fallback and
-- disambiguation. No backfill and no auth.users metadata rewrite.

alter table user_preferences
  add column display_name text,
  add constraint user_preferences_display_name_length_check
    check (display_name is null or char_length(display_name) <= 120);

drop function if exists get_user_preferences_authorized();
create function get_user_preferences_authorized()
returns table(
  theme text,
  timezone text,
  notify_comment_mentions boolean,
  notify_input_request_status_updates boolean,
  display_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  return query
  select preferences.theme,
         preferences.timezone,
         preferences.notify_comment_mentions,
         preferences.notify_input_request_status_updates,
         preferences.display_name
  from user_preferences preferences
  where preferences.user_id = auth.uid();
end;
$$;

drop function if exists update_user_preferences_authorized(text, text, boolean, boolean);
create function update_user_preferences_authorized(
  p_theme text,
  p_timezone text,
  p_notify_comment_mentions boolean,
  p_notify_input_request_status_updates boolean,
  p_display_name text
)
returns table(
  theme text,
  timezone text,
  notify_comment_mentions boolean,
  notify_input_request_status_updates boolean,
  display_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text := nullif(btrim(p_timezone), '');
  v_display_name text := nullif(btrim(p_display_name), '');
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

  if v_display_name is not null and char_length(v_display_name) > 120 then
    raise exception 'Display name must be 120 characters or fewer';
  end if;

  if exists (
    select 1 from impersonation_sessions
    where real_actor_user_id = v_user_id and ended_at is null
  ) then
    raise exception 'Exit impersonation before changing personal settings';
  end if;

  insert into user_preferences (
    user_id, theme, timezone,
    notify_comment_mentions, notify_input_request_status_updates,
    display_name
  )
  values (
    v_user_id, p_theme, v_timezone,
    coalesce(p_notify_comment_mentions, true),
    coalesce(p_notify_input_request_status_updates, true),
    v_display_name
  )
  on conflict (user_id) do update
    set theme = excluded.theme,
        timezone = excluded.timezone,
        notify_comment_mentions = excluded.notify_comment_mentions,
        notify_input_request_status_updates = excluded.notify_input_request_status_updates,
        display_name = excluded.display_name,
        updated_at = now();

  return query
  select preferences.theme,
         preferences.timezone,
         preferences.notify_comment_mentions,
         preferences.notify_input_request_status_updates,
         preferences.display_name
  from user_preferences preferences
  where preferences.user_id = v_user_id;
end;
$$;

revoke all on function get_user_preferences_authorized() from public, anon, service_role;
grant execute on function get_user_preferences_authorized() to authenticated;
revoke all on function update_user_preferences_authorized(text, text, boolean, boolean, text) from public, anon, service_role;
grant execute on function update_user_preferences_authorized(text, text, boolean, boolean, text) to authenticated;

drop function if exists list_workspace_member_identities_authorized(uuid);
create function list_workspace_member_identities_authorized(
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  email text,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select membership.user_id,
         au.email::text,
         preferences.display_name
  from public.workspace_memberships membership
  join auth.users au on au.id = membership.user_id
  left join public.user_preferences preferences
    on preferences.user_id = membership.user_id
  where membership.workspace_id = p_workspace_id
    and membership.deactivated_at is null
  order by coalesce(nullif(preferences.display_name, ''), au.email::text), au.email::text, membership.user_id;
end;
$$;

revoke all on function list_workspace_member_identities_authorized(uuid) from public, anon;
grant execute on function list_workspace_member_identities_authorized(uuid) to authenticated, service_role;

comment on function list_workspace_member_identities_authorized(uuid)
  is 'Membership-checked security-definer lookup of active current workspace members user id, email, and display name for member pickers. Exposes no generic arbitrary-user resolver.';

drop function if exists list_workspace_member_values_for_records_authorized(uuid, uuid, uuid[]);
create function list_workspace_member_values_for_records_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_ids uuid[]
)
returns table (
  source_record_id uuid,
  field_definition_id uuid,
  member_user_id uuid,
  email text,
  display_name text,
  deactivated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select
    value.source_record_id,
    value.field_definition_id,
    value.member_user_id,
    auth_user.email::text,
    preferences.display_name,
    membership.deactivated_at
  from entity_record_workspace_member_values value
  join workspace_memberships membership
    on membership.workspace_id = value.workspace_id
   and membership.user_id = value.member_user_id
  left join auth.users auth_user
    on auth_user.id = value.member_user_id
  left join user_preferences preferences
    on preferences.user_id = value.member_user_id
  where value.workspace_id = p_workspace_id
    and value.source_entity_type_id = p_entity_type_id
    and value.source_record_id = any(p_record_ids)
    and private.can_view_people_sensitive_record(
      p_workspace_id,
      value.source_entity_type_id,
      value.source_record_id,
      private.current_effective_user(p_workspace_id)
    )
  order by value.source_record_id, value.field_definition_id;
end;
$$;

revoke all on function list_workspace_member_values_for_records_authorized(uuid, uuid, uuid[]) from public, anon;
grant execute on function list_workspace_member_values_for_records_authorized(uuid, uuid, uuid[]) to authenticated, service_role;

drop function if exists list_workspace_members_with_roles_authorized(uuid);
create function list_workspace_members_with_roles_authorized(p_workspace_id uuid)
returns table (
  user_id uuid,
  email text,
  display_name text,
  role_id uuid,
  role_name text,
  deactivated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if not private.has_workspace_capability(p_workspace_id, 'workspace.manage_members') then raise exception 'Permission denied: workspace.manage_members'; end if;

  return query
  select membership.user_id,
         users.email::text,
         preferences.display_name,
         membership.role_id,
         role.name,
         membership.deactivated_at
  from public.workspace_memberships membership
  join auth.users users on users.id = membership.user_id
  left join public.user_preferences preferences
    on preferences.user_id = membership.user_id
  join public.workspace_roles role
    on role.workspace_id = membership.workspace_id and role.id = membership.role_id
  where membership.workspace_id = p_workspace_id
  order by (membership.deactivated_at is not null),
           coalesce(nullif(preferences.display_name, ''), users.email::text),
           users.email::text,
           membership.user_id;
end;
$$;

revoke all on function list_workspace_members_with_roles_authorized(uuid) from public, anon;
grant execute on function list_workspace_members_with_roles_authorized(uuid) to authenticated, service_role;
