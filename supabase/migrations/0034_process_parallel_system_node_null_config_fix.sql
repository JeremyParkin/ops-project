-- Corrects 0033 on already-migrated databases. JSON null is the normal wire
-- representation for an absent optional due_rule, including from the process
-- editor, and must not be treated as a system-node due configuration.
-- 0033 contains the corrected source for fresh bootstrap.

do $$
declare
  v_definition text;
  v_old text := 'elsif v_parallel_group_id is null or v_step_assignee_user_id is not null or v_due_rule is not null then';
  v_new text := 'elsif v_parallel_group_id is null or v_step_assignee_user_id is not null
      or (v_due_rule is not null and v_due_rule <> ''null''::jsonb) then';
begin
  select pg_get_functiondef(
    'save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb)'::regprocedure
  ) into v_definition;

  if position(v_old in v_definition) > 0 then
    execute replace(v_definition, v_old, v_new);
  elsif position('v_due_rule <> ''null''::jsonb' in v_definition) = 0 then
    raise exception 'Expected 0033 save_process_template_authorized definition was not found';
  end if;
end;
$$;
