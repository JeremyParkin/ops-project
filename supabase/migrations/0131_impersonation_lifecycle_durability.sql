-- Phase 13.2: make impersonation lifecycle history required evidence.
-- workspace_events remains the canonical lifecycle history store; this
-- migration adds correlation and removes only the lifecycle event handlers'
-- exception swallowing.

alter function public.start_impersonation_session_authorized(uuid, uuid)
  rename to start_impersonation_session_authorized_pre_durability;
alter function public.end_impersonation_session_authorized(uuid)
  rename to end_impersonation_session_authorized_pre_durability;
alter function public.get_active_impersonation_authorized()
  rename to get_active_impersonation_authorized_pre_durability;

revoke all on function public.start_impersonation_session_authorized_pre_durability(uuid, uuid),
  public.end_impersonation_session_authorized_pre_durability(uuid),
  public.get_active_impersonation_authorized_pre_durability()
  from public, anon, authenticated, service_role;

create function public.start_impersonation_session_authorized(
  p_workspace_id uuid,
  p_target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid := gen_random_uuid();
  v_prior_session record;
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.impersonate_users');
  if p_target_user_id = auth.uid() then
    raise exception 'You cannot impersonate yourself';
  end if;
  if not exists (
    select 1 from workspace_memberships
    where workspace_id = p_workspace_id
      and user_id = p_target_user_id
      and deactivated_at is null
  ) then
    raise exception 'Member not found or not active in this workspace';
  end if;

  -- Preserve the existing replacement behavior, but record every actual
  -- ended row before creating the new session.
  for v_prior_session in
    select session.id, session.workspace_id, session.effective_user_id
    from impersonation_sessions session
    where session.real_actor_user_id = auth.uid()
      and session.ended_at is null
    for update
  loop
    update impersonation_sessions
    set ended_at = now()
    where id = v_prior_session.id
      and ended_at is null;

    if found then
      insert into workspace_events (
        id, workspace_id, actor_user_id, event_type, metadata
      ) values (
        gen_random_uuid(), v_prior_session.workspace_id, auth.uid(),
        'impersonation_ended',
        jsonb_build_object(
          'session_id', v_prior_session.id,
          'effective_user_id', v_prior_session.effective_user_id,
          'reason', 'replaced_by_new_session'
        )
      );
    end if;
  end loop;

  insert into impersonation_sessions (id, workspace_id, real_actor_user_id, effective_user_id)
  values (v_session_id, p_workspace_id, auth.uid(), p_target_user_id);

  insert into workspace_events (
    id, workspace_id, actor_user_id, event_type, metadata
  ) values (
    gen_random_uuid(), p_workspace_id, auth.uid(), 'impersonation_started',
    jsonb_build_object(
      'session_id', v_session_id,
      'effective_user_id', p_target_user_id
    )
  );

  return v_session_id;
end;
$$;

create function public.end_impersonation_session_authorized(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_user_id uuid;
  v_workspace_id uuid;
begin
  update impersonation_sessions
  set ended_at = now()
  where id = p_session_id
    and real_actor_user_id = auth.uid()
    and ended_at is null
  returning effective_user_id, workspace_id
  into v_effective_user_id, v_workspace_id;

  if not found then
    raise exception 'Impersonation session not found or already ended';
  end if;

  insert into workspace_events (
    id, workspace_id, actor_user_id, event_type, metadata
  ) values (
    gen_random_uuid(), v_workspace_id, auth.uid(), 'impersonation_ended',
    jsonb_build_object(
      'session_id', p_session_id,
      'effective_user_id', v_effective_user_id,
      'reason', 'explicit_end'
    )
  );
end;
$$;

create function public.get_active_impersonation_authorized()
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
  if auth.uid() is null then
    return;
  end if;

  select * into v_session
  from impersonation_sessions
  where real_actor_user_id = auth.uid()
    and ended_at is null
  order by started_at desc
  limit 1;

  if not found then
    return;
  end if;

  if not exists (
    select 1 from workspace_memberships
    where workspace_memberships.workspace_id = v_session.workspace_id
      and user_id = v_session.effective_user_id
      and deactivated_at is null
  ) then
    update impersonation_sessions
    set ended_at = now()
    where id = v_session.id
      and ended_at is null;

    if found then
      insert into workspace_events (
        id, workspace_id, actor_user_id, event_type, metadata
      ) values (
        gen_random_uuid(), v_session.workspace_id, auth.uid(),
        'impersonation_ended',
        jsonb_build_object(
          'session_id', v_session.id,
          'effective_user_id', v_session.effective_user_id,
          'reason', 'target_deactivated'
        )
      );
    end if;
    return;
  end if;

  return query
  select v_session.id,
    v_session.workspace_id,
    v_session.effective_user_id,
    target.email::text,
    actor.email::text
  from auth.users target, auth.users actor
  where target.id = v_session.effective_user_id
    and actor.id = auth.uid();
end;
$$;

revoke all on function public.start_impersonation_session_authorized(uuid, uuid),
  public.end_impersonation_session_authorized(uuid),
  public.get_active_impersonation_authorized()
  from public, anon;
grant execute on function public.start_impersonation_session_authorized(uuid, uuid),
  public.end_impersonation_session_authorized(uuid),
  public.get_active_impersonation_authorized()
  to authenticated, service_role;

comment on function public.start_impersonation_session_authorized(uuid, uuid)
  is 'Starts a real-actor-bound impersonation session and transactionally records correlated replacement-end and start lifecycle events.';
comment on function public.end_impersonation_session_authorized(uuid)
  is 'Ends the caller-owned impersonation session and transactionally records a correlated explicit-end lifecycle event.';
comment on function public.get_active_impersonation_authorized()
  is 'Reads the caller''s active impersonation session and transactionally records target-deactivation cleanup when required.';
