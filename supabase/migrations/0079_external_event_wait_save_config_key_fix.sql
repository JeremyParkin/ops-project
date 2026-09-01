-- Corrective migration, found during Phase 8F.5 manual dogfood: saving any
-- process template through the real UI that contains an external_event_wait
-- node failed with "Process step configuration is invalid" on every attempt,
-- even with an otherwise entirely valid template (name set, applies-to set,
-- a valid forward-only step chain). The existing DB/RPC gate never caught
-- this because it inserts external_event_wait fixture nodes directly into
-- process_nodes via the admin client, bypassing save_process_template_
-- authorized entirely -- only a real save through the app's Process
-- Template editor UI exercises this path.
--
-- Root cause: 0077's save_process_template_authorized, when disguising an
-- external_event_wait step as node_type = 'human_task' before delegating to
-- save_process_template_authorized_pre_external_event_wait (the renamed
-- 0043-era function), merged in an extra `config` key:
--   jsonb_build_object('node_type', 'human_task', 'config', '{}'::jsonb)
-- `config` has never been part of the step JSON contract at any layer of
-- this save chain (0037/0038/0039/0043 all disguise their own special node
-- types the same way -- wait, condition_wait, action -- and none of them
-- ever add a `config` key, since config is purely a process_nodes TABLE
-- COLUMN set by this function's own subsequent UPDATE, never something the
-- inner validators expect to receive as an incoming step key). That
-- unexpected, unstripped key survives all the way to the innermost
-- structural allowlist guard (0035/0037), which has no entry for it and
-- rejects the whole save with "Process step configuration is invalid".
--
-- Fix: match every other disguise-as-human_task call in this chain exactly
-- -- merge only { node_type: 'human_task' }, nothing else. The node's real
-- config: '{}'::jsonb is still set correctly afterward by this same
-- function's existing UPDATE (unchanged, a few lines down).
create or replace function public.save_process_template_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_name text,
  p_description text,
  p_applies_to_entity_type_id uuid,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_external_steps jsonb := '[]'::jsonb;
  v_template_id uuid;
  v_node_id uuid;
  v_index integer := 0;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Process steps must be an array'; end if;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_index := v_index + 1;
    if v_step->>'node_type' = 'external_event_wait' then
      if coalesce(nullif(trim(v_step->>'assignee_user_id'), ''), '') <> ''
        or coalesce(v_step->'due_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'condition_wait_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'action_config', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'External event waits cannot have an assignee, due rule, timer rule, condition rule, or action config';
      end if;
      v_external_steps := v_external_steps || jsonb_build_array(jsonb_build_object('position', v_index));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'wait_rule' - 'condition_wait_rule' - 'action_config') || jsonb_build_object('node_type', 'human_task'));
    else
      v_normalized := v_normalized || jsonb_build_array(v_step);
    end if;
  end loop;

  v_template_id := save_process_template_authorized_pre_external_event_wait(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );

  for v_step in select * from jsonb_array_elements(v_external_steps) loop
    select id into v_node_id from public.process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer for update;
    if not found then raise exception 'External event wait node was not saved'; end if;
    update public.process_nodes
    set node_type = 'external_event_wait', assignee_user_id = null, config = '{}'::jsonb, updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;

  return v_template_id;
end;
$$;

revoke all on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function public.save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
