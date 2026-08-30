-- 0068's get_active_impersonation_authorized declares a RETURNS TABLE
-- column named workspace_id, which implicitly creates a same-named
-- PL/pgSQL variable in scope (the identical bug class fixed for
-- bulk_create_entity_records_authorized in 0062) -- the self-heal branch's
-- bare `where workspace_id = v_session.workspace_id` is ambiguous between
-- that variable and workspace_memberships.workspace_id. Confirmed directly:
-- every call failed with Postgres error 42702 "column reference
-- \"workspace_id\" is ambiguous" the moment this function actually ran.
-- Fix: qualify the table column; no other change.
create or replace function get_active_impersonation_authorized()
returns table (
  session_id uuid,
  workspace_id uuid,
  effective_user_id uuid,
  effective_email text,
  real_actor_email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session impersonation_sessions%rowtype;
begin
  if auth.uid() is null then return; end if;

  select * into v_session from impersonation_sessions
  where real_actor_user_id = auth.uid() and ended_at is null
  order by started_at desc
  limit 1;

  if not found then return; end if;

  if not exists (
    select 1 from workspace_memberships
    where workspace_memberships.workspace_id = v_session.workspace_id
      and user_id = v_session.effective_user_id
      and deactivated_at is null
  ) then
    update impersonation_sessions set ended_at = now() where id = v_session.id;
    begin
      insert into workspace_events (id, workspace_id, actor_user_id, event_type, metadata)
      values (gen_random_uuid(), v_session.workspace_id, auth.uid(), 'impersonation_ended', jsonb_build_object('effective_user_id', v_session.effective_user_id, 'reason', 'target_deactivated'));
    exception when others then
      null;
    end;
    return;
  end if;

  return query
  select v_session.id, v_session.workspace_id, v_session.effective_user_id, target.email::text, actor.email::text
  from auth.users target, auth.users actor
  where target.id = v_session.effective_user_id and actor.id = auth.uid();
end;
$$;
