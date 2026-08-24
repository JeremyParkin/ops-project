-- Process Graph 5B: explicit, structured non-nested parallel paths. Runs
-- snapshot both route kind and join obligations; live templates are never
-- consulted while advancing an already-started run.

alter table process_nodes
  add column parallel_group_id uuid;

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'process_nodes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%node_type%'
  loop
    execute format('alter table process_nodes drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table process_nodes
  add constraint process_nodes_node_type_check
    check (node_type in ('human_task', 'parallel_split', 'parallel_join')),
  add constraint process_nodes_parallel_group_shape_check
    check (
      (node_type = 'human_task' and parallel_group_id is null)
      or (node_type in ('parallel_split', 'parallel_join') and parallel_group_id is not null)
    ),
  add constraint process_nodes_system_metadata_check
    check (
      node_type = 'human_task'
      or (assignee_user_id is null and config = '{}'::jsonb)
    );

alter table process_edges
  add column is_parallel boolean not null default false;

alter table process_edges
  drop constraint if exists process_edges_routing_shape_check;

alter table process_edges
  add constraint process_edges_routing_shape_check check (
    (is_parallel and not is_default and condition_config is null)
    or (
      not is_parallel
      and (
        (is_default and condition_config is null)
        or (
          not is_default
          and jsonb_typeof(condition_config) = 'array'
          and jsonb_array_length(condition_config) > 0
        )
      )
    )
  );

alter table process_step_runs
  add column parallel_group_id uuid,
  add column parallel_branch_token uuid;

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'process_step_runs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%node_type%'
  loop
    execute format('alter table process_step_runs drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table process_step_runs
  add constraint process_step_runs_node_type_check
    check (node_type in ('human_task', 'parallel_split', 'parallel_join')),
  add constraint process_step_runs_system_metadata_check
    check (
      node_type = 'human_task'
      or (assignee_user_id is null and due_at is null and config = '{}'::jsonb)
    );

alter table process_step_run_routes
  add column is_parallel boolean not null default false,
  add constraint process_step_run_routes_workspace_run_id_key
    unique (workspace_id, process_run_id, id);

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'process_step_run_routes'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%is_default%'
  loop
    execute format('alter table process_step_run_routes drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table process_step_run_routes
  add constraint process_step_run_routes_routing_shape_check check (
    (is_parallel and not is_default and condition_config is null)
    or (
      not is_parallel
      and (
        (is_default and condition_config is null)
        or (
          not is_default
          and jsonb_typeof(condition_config) = 'array'
          and jsonb_array_length(condition_config) > 0
        )
      )
    )
  );

create table process_parallel_join_obligations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_run_id uuid not null,
  join_step_run_id uuid not null,
  parallel_group_id uuid not null,
  branch_token uuid not null,
  arrived_at timestamptz,
  arrival_source_step_run_id uuid,
  created_at timestamptz not null default now(),

  unique (workspace_id, process_run_id, join_step_run_id, branch_token),

  foreign key (workspace_id, process_run_id)
    references process_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, process_run_id, join_step_run_id)
    references process_step_runs(workspace_id, process_run_id, id) on delete cascade,
  foreign key (workspace_id, process_run_id, branch_token)
    references process_step_run_routes(workspace_id, process_run_id, id) on delete cascade,
  foreign key (workspace_id, process_run_id, arrival_source_step_run_id)
    references process_step_runs(workspace_id, process_run_id, id) on delete set null
);

create index process_parallel_join_obligations_join_idx
  on process_parallel_join_obligations (workspace_id, process_run_id, join_step_run_id, arrived_at);

alter table process_parallel_join_obligations enable row level security;
create policy process_parallel_join_obligations_member_access on process_parallel_join_obligations
  for all to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));
revoke all on table process_parallel_join_obligations from anon, authenticated;
grant select on table process_parallel_join_obligations to authenticated;
create trigger process_parallel_join_obligations_workspace_id_immutable
  before update on process_parallel_join_obligations
  for each row execute function private.reject_workspace_id_change();

-- The save and start paths both call this validator. It intentionally rejects
-- malformed direct table fixtures rather than trying to repair a graph.
create or replace function private.validate_process_parallel_template(
  p_workspace_id uuid,
  p_process_template_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group record;
  v_start_count integer;
  v_split_count integer;
  v_join_count integer;
  v_parallel_count integer;
  v_join_incoming_count integer;
begin
  select count(*) into v_start_count
  from process_nodes node
  where node.workspace_id = p_workspace_id
    and node.process_template_id = p_process_template_id
    and not exists (
      select 1 from process_edges edge
      where edge.workspace_id = p_workspace_id
        and edge.process_template_id = p_process_template_id
        and edge.target_node_id = node.id
    );
  if v_start_count <> 1 then
    raise exception 'Process template must have exactly one start step';
  end if;

  if exists (
    select 1
    from process_edges edge
    join process_nodes source on source.workspace_id = edge.workspace_id and source.id = edge.source_node_id
    join process_nodes target on target.workspace_id = edge.workspace_id and target.id = edge.target_node_id
    where edge.workspace_id = p_workspace_id
      and edge.process_template_id = p_process_template_id
      and (source.process_template_id <> p_process_template_id or target.process_template_id <> p_process_template_id
        or target.position <= source.position)
  ) then
    raise exception 'Process routes must point to a later step in the same template';
  end if;

  if exists (
    select 1 from process_nodes node
    where node.workspace_id = p_workspace_id
      and node.process_template_id = p_process_template_id
      and node.position > 1
      and not exists (
        select 1 from process_edges edge
        where edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.target_node_id = node.id
      )
  ) then
    raise exception 'Every step after the first must be reachable from an earlier step';
  end if;

  if exists (
    select 1
    from process_edges edge
    join process_nodes source on source.workspace_id = edge.workspace_id and source.id = edge.source_node_id
    where edge.workspace_id = p_workspace_id
      and edge.process_template_id = p_process_template_id
      and (
        (source.node_type = 'parallel_split' and not edge.is_parallel)
        or (source.node_type <> 'parallel_split' and edge.is_parallel)
      )
  ) then
    raise exception 'Only parallel split nodes may use parallel branch routes';
  end if;

  for v_group in
    select parallel_group_id
    from process_nodes
    where workspace_id = p_workspace_id
      and process_template_id = p_process_template_id
      and parallel_group_id is not null
    group by parallel_group_id
  loop
    select count(*) filter (where node_type = 'parallel_split'),
           count(*) filter (where node_type = 'parallel_join')
      into v_split_count, v_join_count
    from process_nodes
    where workspace_id = p_workspace_id
      and process_template_id = p_process_template_id
      and parallel_group_id = v_group.parallel_group_id;
    if v_split_count <> 1 or v_join_count <> 1 then
      raise exception 'Every parallel group requires exactly one split and one join';
    end if;

    select split.id as split_id, split.position as split_position,
           join_node.id as join_id, join_node.position as join_position
      into v_group
    from process_nodes split
    join process_nodes join_node
      on join_node.workspace_id = split.workspace_id
      and join_node.process_template_id = split.process_template_id
      and join_node.parallel_group_id = split.parallel_group_id
      and join_node.node_type = 'parallel_join'
    where split.workspace_id = p_workspace_id
      and split.process_template_id = p_process_template_id
      and split.parallel_group_id = v_group.parallel_group_id
      and split.node_type = 'parallel_split';
    if v_group.split_position >= v_group.join_position then
      raise exception 'Parallel split must precede its matching join';
    end if;

    select count(*) into v_parallel_count
    from process_edges edge
    where edge.workspace_id = p_workspace_id
      and edge.process_template_id = p_process_template_id
      and edge.source_node_id = v_group.split_id
      and edge.is_parallel;
    if v_parallel_count < 2 then
      raise exception 'A parallel split requires at least two branches';
    end if;

    if exists (
      select 1 from process_edges edge
      where edge.workspace_id = p_workspace_id
        and edge.process_template_id = p_process_template_id
        and edge.source_node_id = v_group.split_id
        and not edge.is_parallel
    ) then
      raise exception 'A parallel split may only have parallel branch routes';
    end if;

    select count(*) into v_join_incoming_count
    from process_edges edge
    where edge.workspace_id = p_workspace_id
      and edge.process_template_id = p_process_template_id
      and edge.target_node_id = v_group.join_id;
    if v_join_incoming_count < 2 then
      raise exception 'A parallel join requires at least two incoming branches';
    end if;

    if exists (
      with recursive branch_paths(node_id) as (
        select edge.target_node_id
        from process_edges edge
        where edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.source_node_id = v_group.split_id
          and edge.is_parallel
        union
        select edge.target_node_id
        from branch_paths
        join process_edges edge
          on edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.source_node_id = branch_paths.node_id
        where branch_paths.node_id <> v_group.join_id
      )
      select 1
      from process_edges incoming
      where incoming.workspace_id = p_workspace_id
        and incoming.process_template_id = p_process_template_id
        and incoming.target_node_id = v_group.join_id
        and incoming.source_node_id not in (select node_id from branch_paths)
    ) then
      raise exception 'A parallel join may only receive its own parallel branches';
    end if;

    if exists (
      select 1 from process_edges edge
      where edge.workspace_id = p_workspace_id
        and edge.process_template_id = p_process_template_id
        and edge.source_node_id = v_group.join_id
        and (edge.is_parallel or not edge.is_default)
    ) then
      raise exception 'A parallel join may only continue through one unconditional route';
    end if;

    if exists (
      select 1
      from process_edges edge
      join process_nodes source on source.workspace_id = edge.workspace_id and source.id = edge.source_node_id
      join process_nodes target on target.workspace_id = edge.workspace_id and target.id = edge.target_node_id
      where edge.workspace_id = p_workspace_id
        and edge.process_template_id = p_process_template_id
        and source.position < v_group.split_position
        and target.position > v_group.split_position
        and target.position < v_group.join_position
    ) then
      raise exception 'A parallel branch may only be entered through its split';
    end if;

    if exists (
      select 1
      from process_edges edge
      join process_nodes source on source.workspace_id = edge.workspace_id and source.id = edge.source_node_id
      join process_nodes target on target.workspace_id = edge.workspace_id and target.id = edge.target_node_id
      where edge.workspace_id = p_workspace_id
        and edge.process_template_id = p_process_template_id
        and source.position > v_group.split_position
        and source.position < v_group.join_position
        and target.id <> v_group.join_id
        and (target.position <= v_group.split_position or target.position >= v_group.join_position)
    ) then
      raise exception 'A parallel branch cannot bypass or escape its matching join';
    end if;

    if exists (
      with recursive branch_paths(branch_token, node_id) as (
        select edge.id, edge.target_node_id
        from process_edges edge
        where edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.source_node_id = v_group.split_id
          and edge.is_parallel
        union
        select branch_paths.branch_token, edge.target_node_id
        from branch_paths
        join process_edges edge
          on edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.source_node_id = branch_paths.node_id
        where branch_paths.node_id <> v_group.join_id
      )
      select 1
      from branch_paths path
      join process_nodes node on node.workspace_id = p_workspace_id and node.id = path.node_id
      where path.node_id <> v_group.join_id
        and (
          node.position >= v_group.join_position
          or not exists (
            select 1 from process_edges edge
            where edge.workspace_id = p_workspace_id
              and edge.process_template_id = p_process_template_id
              and edge.source_node_id = path.node_id
          )
        )
    ) then
      raise exception 'Every parallel branch must reach its matching join';
    end if;

    if exists (
      with recursive branch_paths(branch_token, node_id) as (
        select edge.id, edge.target_node_id
        from process_edges edge
        where edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.source_node_id = v_group.split_id
          and edge.is_parallel
        union
        select branch_paths.branch_token, edge.target_node_id
        from branch_paths
        join process_edges edge
          on edge.workspace_id = p_workspace_id
          and edge.process_template_id = p_process_template_id
          and edge.source_node_id = branch_paths.node_id
        where branch_paths.node_id <> v_group.join_id
      )
      select 1
      from branch_paths
      where node_id <> v_group.join_id
      group by node_id
      having count(distinct branch_token) > 1
    ) then
      raise exception 'Parallel branches cannot reconverge before their matching join';
    end if;
  end loop;

  if exists (
    select 1
    from process_nodes left_group
    join process_nodes right_group
      on right_group.workspace_id = left_group.workspace_id
      and right_group.process_template_id = left_group.process_template_id
      and right_group.node_type = 'parallel_split'
      and left_group.node_type = 'parallel_split'
      and left_group.parallel_group_id < right_group.parallel_group_id
    join process_nodes left_join
      on left_join.workspace_id = left_group.workspace_id
      and left_join.process_template_id = left_group.process_template_id
      and left_join.parallel_group_id = left_group.parallel_group_id
      and left_join.node_type = 'parallel_join'
    join process_nodes right_join
      on right_join.workspace_id = right_group.workspace_id
      and right_join.process_template_id = right_group.process_template_id
      and right_join.parallel_group_id = right_group.parallel_group_id
      and right_join.node_type = 'parallel_join'
    where left_group.workspace_id = p_workspace_id
      and left_group.process_template_id = p_process_template_id
      and left_group.position < right_join.position
      and right_group.position < left_join.position
  ) then
    raise exception 'Nested or overlapping parallel groups are not supported';
  end if;
end;
$$;

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
  v_template_id uuid;
  v_existing_applies_to uuid;
  v_existing_archived_at timestamptz;
  v_step jsonb;
  v_route jsonb;
  v_step_node_id uuid;
  v_target_node_id uuid;
  v_step_name text;
  v_client_key text;
  v_target_client_key text;
  v_step_assignee_user_id uuid;
  v_due_rule jsonb;
  v_node_config jsonb;
  v_routes jsonb;
  v_conditions jsonb;
  v_node_type text;
  v_parallel_group_id uuid;
  v_seen_node_ids uuid[] := '{}'::uuid[];
  v_seen_client_keys text[] := '{}'::text[];
  v_seen_target_keys text[];
  v_final_node_ids uuid[] := '{}'::uuid[];
  v_node_by_client_key jsonb := '{}'::jsonb;
  v_position_by_client_key jsonb := '{}'::jsonb;
  v_index integer;
  v_route_index integer;
  v_route_count integer;
  v_default_count integer;
  v_is_default boolean;
  v_is_parallel boolean;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'A process template requires at least one step';
  end if;
  if nullif(trim(p_name), '') is null then raise exception 'A process template requires a name'; end if;
  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id and id = p_applies_to_entity_type_id and archived_at is null
  ) then raise exception 'Applies-to entity type not found or archived'; end if;

  if p_process_template_id is null then
    v_template_id := gen_random_uuid();
    insert into process_templates (id, workspace_id, name, description, applies_to_entity_type_id)
    values (v_template_id, p_workspace_id, trim(p_name), nullif(trim(coalesce(p_description, '')), ''), p_applies_to_entity_type_id);
  else
    select applies_to_entity_type_id, archived_at into v_existing_applies_to, v_existing_archived_at
    from process_templates where workspace_id = p_workspace_id and id = p_process_template_id for update;
    if not found then raise exception 'Process template not found'; end if;
    if v_existing_archived_at is not null then raise exception 'Archived process templates are read-only. Restore before editing.'; end if;
    if v_existing_applies_to <> p_applies_to_entity_type_id then raise exception 'Applies-to entity type cannot be changed after creation'; end if;
    v_template_id := p_process_template_id;
    update process_templates set name = trim(p_name), description = nullif(trim(coalesce(p_description, '')), ''), updated_at = now()
    where workspace_id = p_workspace_id and id = v_template_id;
    update process_nodes set position = position + 1000000
    where workspace_id = p_workspace_id and process_template_id = v_template_id;
  end if;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps -> (v_index - 1);
    if jsonb_typeof(v_step) <> 'object'
      or v_step - 'client_key' - 'node_id' - 'node_type' - 'parallel_group_id' - 'name'
        - 'assignee_user_id' - 'due_rule' - 'routes' <> '{}'::jsonb then
      raise exception 'Process step configuration is invalid';
    end if;
    v_client_key := nullif(trim(coalesce(v_step->>'client_key', '')), '');
    v_step_name := nullif(trim(coalesce(v_step->>'name', '')), '');
    v_node_type := coalesce(nullif(v_step->>'node_type', ''), 'human_task');
    v_parallel_group_id := nullif(v_step->>'parallel_group_id', '')::uuid;
    v_step_assignee_user_id := nullif(v_step->>'assignee_user_id', '')::uuid;
    v_due_rule := v_step->'due_rule';
    v_node_config := case when v_due_rule is null or v_due_rule = 'null'::jsonb then '{}'::jsonb else jsonb_build_object('due_rule', v_due_rule) end;
    if v_client_key is null or v_client_key = any(v_seen_client_keys) then raise exception 'Duplicate or missing step client key'; end if;
    if v_node_type not in ('human_task', 'parallel_split', 'parallel_join') then raise exception 'Unsupported process node type'; end if;
    if v_step_name is null then raise exception 'Every process node requires a name'; end if;
    if v_node_type = 'human_task' then
      if v_parallel_group_id is not null then raise exception 'Human tasks cannot be assigned a parallel group'; end if;
      perform private.process_due_at_from_config(v_node_config, now());
      if v_step_assignee_user_id is not null and not exists (
        select 1 from workspace_memberships where workspace_id = p_workspace_id and user_id = v_step_assignee_user_id
      ) then raise exception 'Assignee is not a member of this workspace'; end if;
    elsif v_parallel_group_id is null or v_step_assignee_user_id is not null
      or (v_due_rule is not null and v_due_rule <> 'null'::jsonb) then
      raise exception 'Parallel system nodes cannot have an assignee or due rule';
    else
      v_node_config := '{}'::jsonb;
    end if;

    v_step_node_id := nullif(v_step->>'node_id', '')::uuid;
    if v_step_node_id is not null then
      if v_step_node_id = any(v_seen_node_ids) then raise exception 'Duplicate step submitted'; end if;
      if not exists (
        select 1 from process_nodes where workspace_id = p_workspace_id and process_template_id = v_template_id and id = v_step_node_id
      ) then raise exception 'Submitted step does not belong to this template'; end if;
      update process_nodes set node_type = v_node_type, parallel_group_id = v_parallel_group_id,
        name = v_step_name, position = v_index, assignee_user_id = v_step_assignee_user_id,
        config = v_node_config, updated_at = now()
      where workspace_id = p_workspace_id and id = v_step_node_id;
    else
      v_step_node_id := gen_random_uuid();
      insert into process_nodes (id, workspace_id, process_template_id, node_type, parallel_group_id, name, position, assignee_user_id, config)
      values (v_step_node_id, p_workspace_id, v_template_id, v_node_type, v_parallel_group_id, v_step_name, v_index, v_step_assignee_user_id, v_node_config);
    end if;
    v_seen_node_ids := v_seen_node_ids || v_step_node_id;
    v_seen_client_keys := v_seen_client_keys || v_client_key;
    v_final_node_ids := v_final_node_ids || v_step_node_id;
    v_node_by_client_key := v_node_by_client_key || jsonb_build_object(v_client_key, v_step_node_id::text);
    v_position_by_client_key := v_position_by_client_key || jsonb_build_object(v_client_key, v_index);
  end loop;

  delete from process_nodes
  where workspace_id = p_workspace_id and process_template_id = v_template_id and not (id = any(v_final_node_ids));
  delete from process_edges where workspace_id = p_workspace_id and process_template_id = v_template_id;

  for v_index in 1 .. jsonb_array_length(p_steps) loop
    v_step := p_steps -> (v_index - 1);
    v_step_node_id := (v_node_by_client_key ->> (v_step->>'client_key'))::uuid;
    v_node_type := coalesce(nullif(v_step->>'node_type', ''), 'human_task');
    v_routes := coalesce(v_step->'routes', '[]'::jsonb);
    if jsonb_typeof(v_routes) <> 'array' then raise exception 'Process routes must be an array'; end if;
    v_route_count := jsonb_array_length(v_routes);

    if v_route_count = 0 then
      if v_index < jsonb_array_length(p_steps) then
        v_target_client_key := (p_steps -> v_index)->>'client_key';
        insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id, priority, condition_config, is_default, is_parallel)
        values (p_workspace_id, v_template_id, v_step_node_id, (v_node_by_client_key->>v_target_client_key)::uuid, 0, null, true, false);
      end if;
      continue;
    end if;

    select count(*) into v_default_count
    from jsonb_array_elements(v_routes) route where route->>'is_default' = 'true';
    if v_node_type = 'parallel_split' then
      if v_route_count < 2 then raise exception 'A parallel split requires at least two branches'; end if;
    elsif v_route_count > 1 and v_default_count <> 1 then
      raise exception 'Conditional routing requires one Otherwise route';
    elsif v_route_count = 1 and v_default_count <> 1 then
      raise exception 'A routed step requires one unconditional route';
    end if;
    v_seen_target_keys := '{}'::text[];

    for v_route_index in 1 .. v_route_count loop
      v_route := v_routes -> (v_route_index - 1);
      if jsonb_typeof(v_route) <> 'object'
        or v_route - 'target_client_key' - 'is_default' - 'is_parallel' - 'conditions' <> '{}'::jsonb
        or jsonb_typeof(v_route->'target_client_key') <> 'string'
        or jsonb_typeof(v_route->'is_default') <> 'boolean' then
        raise exception 'Process route configuration is invalid';
      end if;
      v_target_client_key := nullif(trim(v_route->>'target_client_key'), '');
      v_is_default := (v_route->>'is_default')::boolean;
      v_is_parallel := coalesce((v_route->>'is_parallel')::boolean, false);
      if v_target_client_key is null or not (v_node_by_client_key ? v_target_client_key) then raise exception 'Route target does not belong to this template'; end if;
      if v_target_client_key = any(v_seen_target_keys) then raise exception 'A step cannot contain duplicate routes to the same target'; end if;
      if (v_position_by_client_key->>v_target_client_key)::integer <= v_index then raise exception 'Routes must point to a later step'; end if;
      v_conditions := v_route->'conditions';
      if v_node_type = 'parallel_split' then
        if not v_is_parallel or v_is_default or (v_conditions is not null and jsonb_array_length(v_conditions) <> 0) then
          raise exception 'Parallel branch routes cannot have conditions or default semantics';
        end if;
        v_conditions := null;
      else
        if v_is_parallel then raise exception 'Only parallel split nodes may use parallel branch routes'; end if;
        if v_is_default then
          if v_conditions is not null and (jsonb_typeof(v_conditions) <> 'array' or jsonb_array_length(v_conditions) <> 0) then
            raise exception 'Default process routes cannot have conditions';
          end if;
          v_conditions := null;
        else
          perform private.validate_process_branch_conditions(p_workspace_id, p_applies_to_entity_type_id, v_conditions);
        end if;
      end if;
      insert into process_edges (workspace_id, process_template_id, source_node_id, target_node_id, priority, condition_config, is_default, is_parallel)
      values (p_workspace_id, v_template_id, v_step_node_id, (v_node_by_client_key->>v_target_client_key)::uuid,
        v_route_index - 1, v_conditions, v_is_default, v_is_parallel);
      v_seen_target_keys := v_seen_target_keys || v_target_client_key;
    end loop;
  end loop;

  perform private.validate_process_parallel_template(p_workspace_id, v_template_id);
  return v_template_id;
end;
$$;

create or replace function private.try_complete_process_run(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_completed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from process_step_runs
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id and status = 'active'
  ) or exists (
    select 1 from process_parallel_join_obligations
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id and arrived_at is null
  ) then
    return;
  end if;

  update process_step_runs
  set status = 'skipped', due_at = null
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and status = 'pending';
  update process_runs
  set status = 'completed', completed_at = p_completed_at
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active';
end;
$$;

create or replace function private.advance_process_system_step(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_activation_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step process_step_runs%rowtype;
  v_join process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_route_count integer;
  v_route_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
begin
  select * into v_step from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'active' or v_step.node_type = 'human_task' then
    raise exception 'Process system step is not available';
  end if;

  if v_step.node_type = 'parallel_split' then
    select * into v_join from process_step_runs
    where workspace_id = p_workspace_id
      and process_run_id = p_process_run_id
      and node_type = 'parallel_join'
      and parallel_group_id = v_step.parallel_group_id
    for update;
    if not found then raise exception 'Parallel split has no matching join'; end if;

    select count(*) into v_route_count from process_step_run_routes
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id
      and source_step_run_id = v_step.id and is_parallel;
    if v_route_count < 2 then raise exception 'Parallel split has no valid branch routes'; end if;

    for v_route in
      select * from process_step_run_routes
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id
        and source_step_run_id = v_step.id and is_parallel
      order by priority
    loop
      v_route_ids := v_route_ids || v_route.id;
      v_target_ids := v_target_ids || v_route.target_step_run_id;

      insert into process_parallel_join_obligations (
        workspace_id, process_run_id, join_step_run_id, parallel_group_id, branch_token
      ) values (
        p_workspace_id, p_process_run_id, v_join.id, v_step.parallel_group_id, v_route.id
      );

      with recursive branch_nodes(step_run_id) as (
        select v_route.target_step_run_id
        union
        select next_route.target_step_run_id
        from branch_nodes
        join process_step_run_routes next_route
          on next_route.workspace_id = p_workspace_id
          and next_route.process_run_id = p_process_run_id
          and next_route.source_step_run_id = branch_nodes.step_run_id
        where branch_nodes.step_run_id <> v_join.id
          and next_route.target_step_run_id <> v_join.id
      )
      update process_step_runs branch_step
      set parallel_branch_token = v_route.id
      where branch_step.workspace_id = p_workspace_id
        and branch_step.process_run_id = p_process_run_id
        and branch_step.status = 'pending'
        and branch_step.id in (select step_run_id from branch_nodes);
    end loop;

    update process_step_runs
    set status = 'completed', completed_at = p_activation_at,
      routing_result = jsonb_build_object(
        'selectedRouteIds', to_jsonb(v_route_ids),
        'targetStepRunIds', to_jsonb(v_target_ids),
        'outcome', 'parallel_split',
        'evaluatedAt', p_activation_at
      )
    where workspace_id = p_workspace_id and id = v_step.id;

    for v_route in
      select * from process_step_run_routes
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id
        and source_step_run_id = v_step.id and is_parallel
      order by priority
    loop
      perform private.activate_process_step_run(
        p_workspace_id, p_process_run_id, v_route.target_step_run_id, p_activation_at, v_route.id
      );
    end loop;
    return;
  end if;

  select count(*) into v_route_count from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id;
  if v_route_count > 1 then raise exception 'Parallel join has ambiguous downstream routing'; end if;

  if v_route_count = 0 then
    update process_step_runs
    set status = 'completed', completed_at = p_activation_at,
      routing_result = jsonb_build_object('outcome', 'parallel_join', 'evaluatedAt', p_activation_at)
    where workspace_id = p_workspace_id and id = v_step.id;
    perform private.try_complete_process_run(p_workspace_id, p_process_run_id, p_activation_at);
    return;
  end if;

  select * into v_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = v_step.id;
  if not v_route.is_default or v_route.is_parallel then raise exception 'Parallel join has invalid downstream routing'; end if;

  update process_step_runs
  set status = 'completed', completed_at = p_activation_at,
    routing_result = jsonb_build_object(
      'selectedRouteId', v_route.id,
      'targetStepRunId', v_route.target_step_run_id,
      'outcome', 'parallel_join',
      'evaluatedAt', p_activation_at
    )
  where workspace_id = p_workspace_id and id = v_step.id;
  perform private.activate_process_step_run(
    p_workspace_id, p_process_run_id, v_route.target_step_run_id, p_activation_at, null
  );
end;
$$;

create or replace function private.activate_process_step_run(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid,
  p_activation_at timestamptz,
  p_parallel_branch_token uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step process_step_runs%rowtype;
begin
  select * into v_step from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found or v_step.status <> 'pending' then
    raise exception 'Process route target is not available';
  end if;
  if v_step.parallel_branch_token is not null
    and p_parallel_branch_token is not null
    and v_step.parallel_branch_token <> p_parallel_branch_token then
    raise exception 'Process branch token does not match its target';
  end if;

  update process_step_runs
  set status = 'active', started_at = p_activation_at,
    due_at = case when v_step.node_type = 'human_task'
      then private.process_due_at_from_config(v_step.config, p_activation_at)
      else null end,
    parallel_branch_token = coalesce(v_step.parallel_branch_token, p_parallel_branch_token)
  where workspace_id = p_workspace_id and id = p_step_run_id;

  if v_step.node_type <> 'human_task' then
    perform private.advance_process_system_step(
      p_workspace_id, p_process_run_id, p_step_run_id, p_activation_at
    );
  end if;
end;
$$;

create or replace function start_process_run_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template process_templates%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_start_node_id uuid;
  v_start_step_run_id uuid;
  v_activation_at timestamptz := now();
  v_node process_nodes%rowtype;
  v_assignee_label text;
  v_node_count integer;
  v_start_count integer;
  v_edge process_edges%rowtype;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  select * into v_template from process_templates
  where workspace_id = p_workspace_id and id = p_process_template_id and archived_at is null;
  if not found then raise exception 'Process template not found or archived'; end if;
  if v_template.applies_to_entity_type_id <> p_origin_entity_type_id then
    raise exception 'Process template does not apply to this record''s entity type';
  end if;
  if not exists (
    select 1 from entity_records where workspace_id = p_workspace_id
      and entity_type_id = p_origin_entity_type_id and id = p_origin_record_id and archived_at is null
  ) then raise exception 'Origin record not found or archived'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_origin_record_id::text, 0));
  if exists (
    select 1 from process_runs where workspace_id = p_workspace_id and process_template_id = p_process_template_id
      and origin_record_id = p_origin_record_id and status = 'active'
  ) then raise exception 'This process is already running for this record'; end if;

  select count(*) into v_node_count from process_nodes
  where workspace_id = p_workspace_id and process_template_id = p_process_template_id;
  if v_node_count = 0 then raise exception 'Process template has no steps'; end if;
  perform private.validate_process_parallel_template(p_workspace_id, p_process_template_id);
  select count(*), (array_agg(node.id order by node.position))[1]
    into v_start_count, v_start_node_id
  from process_nodes node
  where node.workspace_id = p_workspace_id and node.process_template_id = p_process_template_id
    and not exists (
      select 1 from process_edges edge where edge.workspace_id = p_workspace_id
        and edge.process_template_id = p_process_template_id and edge.target_node_id = node.id
    );
  if v_start_count <> 1 then raise exception 'Process template must have exactly one start step'; end if;
  for v_edge in select * from process_edges
    where workspace_id = p_workspace_id and process_template_id = p_process_template_id
      and not is_default and not is_parallel
  loop
    perform private.validate_process_branch_conditions(p_workspace_id, p_origin_entity_type_id, v_edge.condition_config);
  end loop;

  insert into process_runs (
    id, workspace_id, process_template_id, process_template_name, process_template_description,
    origin_entity_type_id, origin_record_id, status
  ) values (
    v_run_id, p_workspace_id, p_process_template_id, v_template.name, v_template.description,
    p_origin_entity_type_id, p_origin_record_id, 'active'
  );

  for v_node in select * from process_nodes
    where workspace_id = p_workspace_id and process_template_id = p_process_template_id order by position
  loop
    v_assignee_label := null;
    if v_node.node_type = 'human_task' and v_node.assignee_user_id is not null then
      select email into v_assignee_label from auth.users where id = v_node.assignee_user_id;
    end if;
    insert into process_step_runs (
      id, workspace_id, process_run_id, source_node_id, step_index, node_type, parallel_group_id, name, config,
      status, assignee_user_id, assignee_label
    ) values (
      gen_random_uuid(), p_workspace_id, v_run_id, v_node.id, v_node.position, v_node.node_type,
      v_node.parallel_group_id, v_node.name, v_node.config, 'pending',
      case when v_node.node_type = 'human_task' then v_node.assignee_user_id else null end,
      v_assignee_label
    );
  end loop;

  insert into process_step_run_routes (
    workspace_id, process_run_id, source_step_run_id, target_step_run_id, source_node_id, target_node_id,
    priority, condition_config, condition_summary, is_default, is_parallel
  )
  select edge.workspace_id, v_run_id, source_step.id, target_step.id, edge.source_node_id, edge.target_node_id,
    edge.priority, edge.condition_config,
    case when edge.is_default or edge.is_parallel then null
      else private.process_branch_condition_summary(p_workspace_id, p_origin_entity_type_id, edge.condition_config) end,
    edge.is_default, edge.is_parallel
  from process_edges edge
  join process_step_runs source_step
    on source_step.workspace_id = edge.workspace_id and source_step.process_run_id = v_run_id and source_step.source_node_id = edge.source_node_id
  join process_step_runs target_step
    on target_step.workspace_id = edge.workspace_id and target_step.process_run_id = v_run_id and target_step.source_node_id = edge.target_node_id
  where edge.workspace_id = p_workspace_id and edge.process_template_id = p_process_template_id;

  select id into v_start_step_run_id from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = v_run_id and source_node_id = v_start_node_id;
  perform private.activate_process_step_run(
    p_workspace_id, v_run_id, v_start_step_run_id, v_activation_at, null
  );
  return v_run_id;
end;
$$;

create or replace function complete_process_step_run_authorized(
  p_workspace_id uuid,
  p_process_run_id uuid,
  p_step_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_run process_step_runs%rowtype;
  v_run process_runs%rowtype;
  v_target_step_run process_step_runs%rowtype;
  v_route process_step_run_routes%rowtype;
  v_default_route process_step_run_routes%rowtype;
  v_route_count integer;
  v_default_count integer;
  v_selected_route_id uuid;
  v_outcome text;
  v_evaluation jsonb;
  v_evaluated_conditions jsonb := '[]'::jsonb;
  v_activation_at timestamptz := now();
  v_arrived_count integer := 0;
begin
  if not private.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_process_run_id::text, 0));
  select * into v_run from process_runs
  where workspace_id = p_workspace_id and id = p_process_run_id and status = 'active' for update;
  if not found then raise exception 'Process run is not active'; end if;
  select * into v_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = p_step_run_id for update;
  if not found then raise exception 'Step not found'; end if;
  if v_step_run.node_type <> 'human_task' then raise exception 'System process steps advance automatically'; end if;
  if v_step_run.status <> 'active' then raise exception 'This step is not active'; end if;
  if v_step_run.assignee_user_id is not null and v_step_run.assignee_user_id <> auth.uid() then
    raise exception 'This step is assigned to another member';
  end if;
  perform 1 from entity_records where workspace_id = p_workspace_id
    and entity_type_id = v_run.origin_entity_type_id and id = v_run.origin_record_id and archived_at is null for share;
  if not found then raise exception 'Origin record not found or archived'; end if;

  select count(*), count(*) filter (where is_default)
    into v_route_count, v_default_count
  from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and source_step_run_id = p_step_run_id;

  if v_route_count = 0 then
    if v_step_run.parallel_branch_token is not null
      or exists (
        select 1 from process_step_runs
        where workspace_id = p_workspace_id and process_run_id = p_process_run_id
          and status = 'active' and id <> p_step_run_id
      )
      or exists (
        select 1 from process_parallel_join_obligations
        where workspace_id = p_workspace_id and process_run_id = p_process_run_id and arrived_at is null
      ) then
      raise exception 'Process cannot terminate while parallel work remains';
    end if;
    update process_step_runs set status = 'completed', completed_at = v_activation_at
    where workspace_id = p_workspace_id and id = p_step_run_id;
    perform private.try_complete_process_run(p_workspace_id, p_process_run_id, v_activation_at);
    return;
  end if;

  if v_default_count <> 1 then raise exception 'Process route configuration has no unambiguous default'; end if;
  select * into v_default_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id
    and source_step_run_id = p_step_run_id and is_default;
  if v_route_count = 1 then
    v_selected_route_id := v_default_route.id;
    v_outcome := 'unconditional';
  else
    for v_route in select * from process_step_run_routes
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id
        and source_step_run_id = p_step_run_id and not is_default
      order by priority
    loop
      v_evaluation := private.evaluate_process_branch_conditions(
        p_workspace_id, v_run.origin_entity_type_id, v_run.origin_record_id, v_route.condition_config
      );
      v_evaluated_conditions := v_evaluated_conditions || coalesce(v_evaluation->'conditions', '[]'::jsonb);
      if coalesce((v_evaluation->>'matched')::boolean, false) then
        v_selected_route_id := v_route.id;
        v_outcome := 'matched_condition';
        exit;
      end if;
    end loop;
    if v_selected_route_id is null then
      v_selected_route_id := v_default_route.id;
      v_outcome := 'default_fallback';
    end if;
  end if;

  select * into v_route from process_step_run_routes
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_selected_route_id;
  select * into v_target_step_run from process_step_runs
  where workspace_id = p_workspace_id and process_run_id = p_process_run_id and id = v_route.target_step_run_id for update;
  if not found or v_target_step_run.status <> 'pending' then raise exception 'Process route target is not available'; end if;

  update process_step_runs set status = 'completed', completed_at = v_activation_at,
    routing_result = jsonb_build_object(
      'selectedRouteId', v_route.id,
      'targetStepRunId', v_target_step_run.id,
      'outcome', v_outcome,
      'evaluatedAt', v_activation_at,
      'evaluatedConditions', v_evaluated_conditions
    )
  where workspace_id = p_workspace_id and id = p_step_run_id;

  if v_step_run.parallel_branch_token is null then
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id
      and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending'
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  else
    with recursive reachable(step_run_id) as (
      select v_target_step_run.id
      union
      select route.target_step_run_id
      from process_step_run_routes route
      join reachable on reachable.step_run_id = route.source_step_run_id
      where route.workspace_id = p_workspace_id and route.process_run_id = p_process_run_id
        and route.target_step_run_id <> v_target_step_run.id
    )
    update process_step_runs step_run
    set status = 'skipped', due_at = null
    where step_run.workspace_id = p_workspace_id
      and step_run.process_run_id = p_process_run_id
      and step_run.status = 'pending'
      and step_run.parallel_branch_token = v_step_run.parallel_branch_token
      and not exists (select 1 from reachable where reachable.step_run_id = step_run.id);
  end if;

  if v_target_step_run.node_type = 'parallel_join' then
    if v_step_run.parallel_branch_token is null then
      raise exception 'Only a parallel branch may arrive at a parallel join';
    end if;
    update process_parallel_join_obligations
    set arrived_at = v_activation_at, arrival_source_step_run_id = p_step_run_id
    where workspace_id = p_workspace_id and process_run_id = p_process_run_id
      and join_step_run_id = v_target_step_run.id
      and branch_token = v_step_run.parallel_branch_token
      and arrived_at is null;
    get diagnostics v_arrived_count = row_count;
    if v_arrived_count <> 1 then raise exception 'Parallel join obligation is not available'; end if;
    if not exists (
      select 1 from process_parallel_join_obligations
      where workspace_id = p_workspace_id and process_run_id = p_process_run_id
        and join_step_run_id = v_target_step_run.id and arrived_at is null
    ) then
      perform private.activate_process_step_run(
        p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at, null
      );
    end if;
  else
    perform private.activate_process_step_run(
      p_workspace_id, p_process_run_id, v_target_step_run.id, v_activation_at,
      v_step_run.parallel_branch_token
    );
  end if;
end;
$$;

revoke all on function private.validate_process_parallel_template(uuid, uuid) from public;
revoke all on function private.try_complete_process_run(uuid, uuid, timestamptz) from public;
revoke all on function private.advance_process_system_step(uuid, uuid, uuid, timestamptz) from public;
revoke all on function private.activate_process_step_run(uuid, uuid, uuid, timestamptz, uuid) from public;
revoke all on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) from public;
revoke all on function start_process_run_authorized(uuid, uuid, uuid, uuid) from public;
revoke all on function complete_process_step_run_authorized(uuid, uuid, uuid) from public;
grant execute on function save_process_template_authorized(uuid, uuid, text, text, uuid, jsonb) to authenticated, service_role;
grant execute on function start_process_run_authorized(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function complete_process_step_run_authorized(uuid, uuid, uuid) to authenticated, service_role;

comment on table process_parallel_join_obligations is
  'Per-run expected parallel branch arrivals, created at split activation and never reconstructed from live template edges.';
comment on column process_step_runs.parallel_branch_token is
  'The snapshotted split-route identity carried by every selected step in one parallel branch until it reaches its join.';
