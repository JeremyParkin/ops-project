-- Corrective migration for environments where 0038 was already applied.
-- The standard repository serializes condition_wait_rule as JSON null for
-- ordinary nodes; remove that additive key before delegating to the 0037 saver.

create or replace function save_process_template_authorized(
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
  v_condition_steps jsonb := '[]'::jsonb;
  v_template_id uuid;
  v_node_id uuid;
  v_index integer := 0;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Process steps must be an array'; end if;
  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_index := v_index + 1;
    if v_step->>'node_type' = 'condition_wait' then
      perform private.validate_process_condition_wait_rule(
        p_workspace_id,
        p_applies_to_entity_type_id,
        jsonb_build_object('condition_wait_rule', v_step->'condition_wait_rule')
      );
      if coalesce(nullif(trim(v_step->>'assignee_user_id'), ''), '') <> ''
        or coalesce(v_step->'due_rule', 'null'::jsonb) <> 'null'::jsonb
        or coalesce(v_step->'wait_rule', 'null'::jsonb) <> 'null'::jsonb then
        raise exception 'Condition waits cannot have an assignee, due rule, or timer rule';
      end if;
      v_condition_steps := v_condition_steps || jsonb_build_array(jsonb_build_object('position', v_index, 'config', jsonb_build_object('condition_wait_rule', v_step->'condition_wait_rule')));
      v_normalized := v_normalized || jsonb_build_array((v_step - 'condition_wait_rule') || jsonb_build_object('node_type', 'human_task'));
    else
      v_normalized := v_normalized || jsonb_build_array(v_step - 'condition_wait_rule');
    end if;
  end loop;
  v_template_id := save_process_template_authorized_pre_condition_wait(
    p_workspace_id, p_process_template_id, p_name, p_description, p_applies_to_entity_type_id, v_normalized
  );
  for v_step in select * from jsonb_array_elements(v_condition_steps) loop
    select id into v_node_id from process_nodes
    where workspace_id = p_workspace_id and process_template_id = v_template_id and position = (v_step->>'position')::integer for update;
    if not found then raise exception 'Condition wait node was not saved'; end if;
    update process_nodes
    set node_type = 'condition_wait', assignee_user_id = null, config = v_step->'config', updated_at = now()
    where workspace_id = p_workspace_id and id = v_node_id;
  end loop;
  return v_template_id;
end;
$$;

revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
