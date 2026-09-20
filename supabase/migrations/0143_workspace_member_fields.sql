-- Workspace Member fields v1.
--
-- Single-member field values are normalized beside Relation values. The
-- source-record lifecycle follows Relation (record delete cascades value
-- rows), but the field FK is deliberately restrictive: safe field deletion
-- must prove no persisted values remain.

do $$
declare
  v_constraint text;
begin
  select pg_get_constraintdef(oid)
    into v_constraint
    from pg_constraint
    where conrelid = 'public.field_definitions'::regclass
      and conname = 'field_definitions_type_check';

  if v_constraint is null
    or v_constraint not like '%text%'
    or v_constraint not like '%number%'
    or v_constraint not like '%date%'
    or v_constraint not like '%boolean%'
    or v_constraint not like '%relation%'
    or v_constraint not like '%choice%'
    or v_constraint like '%workspace_member%'
  then
    raise exception 'Unexpected field_definitions_type_check before workspace_member migration: %', v_constraint;
  end if;
end $$;

alter table field_definitions
  drop constraint field_definitions_type_check;

alter table field_definitions
  add constraint field_definitions_type_check
  check (type in ('text', 'number', 'date', 'boolean', 'relation', 'choice', 'workspace_member'));

alter table field_definitions
  add constraint field_definitions_workspace_entity_id_type_key
  unique (workspace_id, entity_type_id, id, type);

create table entity_record_workspace_member_values (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source_entity_type_id uuid not null,
  source_record_id uuid not null,
  field_definition_id uuid not null,
  field_type text not null default 'workspace_member' check (field_type = 'workspace_member'),
  member_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, source_record_id, field_definition_id),

  foreign key (workspace_id)
    references workspaces(id)
    on delete cascade
    on update cascade,

  foreign key (
    workspace_id,
    source_entity_type_id,
    source_record_id
  )
    references entity_records(workspace_id, entity_type_id, id)
    on delete cascade
    on update cascade,

  foreign key (
    workspace_id,
    source_entity_type_id,
    field_definition_id,
    field_type
  )
    references field_definitions(workspace_id, entity_type_id, id, type)
    on delete no action
    on update cascade,

  foreign key (
    workspace_id,
    member_user_id
  )
    references workspace_memberships(workspace_id, user_id)
    on delete no action
    on update cascade
);

create index entity_record_workspace_member_values_record_idx
  on entity_record_workspace_member_values (workspace_id, source_entity_type_id, source_record_id);

create index entity_record_workspace_member_values_member_idx
  on entity_record_workspace_member_values (workspace_id, member_user_id);

alter table entity_record_workspace_member_values enable row level security;
revoke all on table entity_record_workspace_member_values from public, anon, authenticated;

create or replace function private.workspace_member_value_snapshot(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'field_definition_id', value.field_definition_id,
        'member_user_id', value.member_user_id,
        'email', auth_user.email::text,
        'deactivated_at', membership.deactivated_at
      )
      order by field.position
    ),
    '[]'::jsonb
  )
  from entity_record_workspace_member_values value
  join field_definitions field
    on field.workspace_id = value.workspace_id
   and field.entity_type_id = value.source_entity_type_id
   and field.id = value.field_definition_id
  join workspace_memberships membership
    on membership.workspace_id = value.workspace_id
   and membership.user_id = value.member_user_id
  left join auth.users auth_user
    on auth_user.id = value.member_user_id
  where value.workspace_id = p_workspace_id
    and value.source_entity_type_id = p_entity_type_id
    and value.source_record_id = p_record_id;
$$;

create or replace function private.workspace_member_field_ids_json(
  p_workspace_id uuid,
  p_entity_type_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(id order by position), '[]'::jsonb)
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id
    and type = 'workspace_member'
    and archived_at is null;
$$;

create or replace function private.workspace_member_change_fields(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_old_members jsonb,
  p_new_members jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fields jsonb := '[]'::jsonb;
  v_field field_definitions%rowtype;
  v_old_user_id uuid;
  v_new_user_id uuid;
  v_old_email text;
  v_new_email text;
begin
  for v_field in
    select *
    from field_definitions
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id
      and type = 'workspace_member'
      and archived_at is null
    order by position
  loop
    begin
      v_old_user_id := (
        select (member ->> 'member_user_id')::uuid
        from jsonb_array_elements(coalesce(p_old_members, '[]'::jsonb)) member
        where member ->> 'field_definition_id' = v_field.id::text
        limit 1
      );
    exception when invalid_text_representation then
      v_old_user_id := null;
    end;

    begin
      v_new_user_id := (
        select (member ->> 'member_user_id')::uuid
        from jsonb_array_elements(coalesce(p_new_members, '[]'::jsonb)) member
        where member ->> 'field_definition_id' = v_field.id::text
        limit 1
      );
    exception when invalid_text_representation then
      v_new_user_id := null;
    end;

    if v_old_user_id is distinct from v_new_user_id then
      select member ->> 'email'
        into v_old_email
        from jsonb_array_elements(coalesce(p_old_members, '[]'::jsonb)) member
        where member ->> 'field_definition_id' = v_field.id::text
        limit 1;

      select member ->> 'email'
        into v_new_email
        from jsonb_array_elements(coalesce(p_new_members, '[]'::jsonb)) member
        where member ->> 'field_definition_id' = v_field.id::text
        limit 1;

      v_fields := v_fields || jsonb_build_array(jsonb_build_object(
        'field_definition_id', v_field.id,
        'field_key', v_field.key,
        'field_name_snapshot', v_field.name,
        'field_type', 'workspace_member',
        'old_value', case when v_old_user_id is null then null else to_jsonb(v_old_user_id::text) end,
        'new_value', case when v_new_user_id is null then null else to_jsonb(v_new_user_id::text) end,
        'old_workspace_member_email_snapshot', v_old_email,
        'new_workspace_member_email_snapshot', v_new_email
      ));
    end if;
  end loop;

  return v_fields;
end;
$$;

create or replace function private.workspace_member_append_activity(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_event_type text,
  p_old_members jsonb,
  p_new_members jsonb,
  p_effective_actor uuid default null,
  p_real_actor uuid default null,
  p_authority_kind text default null,
  p_workflow_id uuid default null,
  p_process_step_run_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member_fields jsonb;
begin
  v_member_fields := private.workspace_member_change_fields(
    p_workspace_id,
    p_entity_type_id,
    p_old_members,
    p_new_members
  );

  if jsonb_array_length(v_member_fields) = 0 then
    return;
  end if;

  perform private.record_change_insert(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_event_type,
    p_effective_actor,
    p_real_actor,
    coalesce(p_authority_kind, 'human'),
    p_workflow_id,
    p_process_step_run_id,
    null,
    jsonb_build_object('fields', v_member_fields, 'relations', '[]'::jsonb)
  );
end;
$$;

create or replace function private.apply_workspace_member_record_values(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_field_ids jsonb,
  p_workspace_members jsonb,
  p_allow_existing_deactivated boolean,
  p_validate_required boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member jsonb;
  v_field_id uuid;
  v_member_user_id uuid;
  v_field field_definitions%rowtype;
  v_deactivated_at timestamptz;
begin
  if p_workspace_members is null or jsonb_typeof(p_workspace_members) <> 'array' then
    raise exception 'p_workspace_members must be a JSON array';
  end if;

  if p_field_ids is null or jsonb_typeof(p_field_ids) <> 'array' then
    raise exception 'p_workspace_member_field_ids must be a JSON array';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_workspace_members) member
    group by member ->> 'field_definition_id'
    having count(*) > 1
  ) then
    raise exception 'A Workspace Member field can have only one value.';
  end if;

  if p_validate_required then
    for v_field in
      select *
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and type = 'workspace_member'
        and required = true
        and archived_at is null
    loop
      if not exists (
        select 1
        from jsonb_array_elements(p_workspace_members) member
        where member ->> 'field_definition_id' = v_field.id::text
      ) then
        raise exception '% is required.', v_field.name;
      end if;
    end loop;
  end if;

  for v_field_id in
    select trim(both '"' from field_id::text)::uuid
    from jsonb_array_elements(p_field_ids) field_id
  loop
    if not exists (
      select 1
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and id = v_field_id
        and type = 'workspace_member'
    ) then
      raise exception 'Workspace Member values must reference Workspace Member fields on this object.';
    end if;
  end loop;

  for v_member in
    select *
    from jsonb_array_elements(p_workspace_members)
  loop
    begin
      v_field_id := (v_member ->> 'field_definition_id')::uuid;
      v_member_user_id := (v_member ->> 'member_user_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Workspace Member values must use valid UUIDs.';
    end;

    select *
      into v_field
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and id = v_field_id
        and type = 'workspace_member'
        and archived_at is null;

    if not found then
      raise exception 'Workspace Member values must reference active Workspace Member fields on this object.';
    end if;

    if not exists (
      select 1
      from jsonb_array_elements(p_field_ids) field_id
      where trim(both '"' from field_id::text) = v_field_id::text
    ) then
      raise exception 'Workspace Member payload included a field outside p_workspace_member_field_ids.';
    end if;

    select deactivated_at
      into v_deactivated_at
      from workspace_memberships
      where workspace_id = p_workspace_id
        and user_id = v_member_user_id;

    if not found then
      raise exception '% must reference a workspace member.', v_field.name;
    end if;

    if v_deactivated_at is not null and not (
      p_allow_existing_deactivated
      and exists (
        select 1
        from entity_record_workspace_member_values existing
        where existing.workspace_id = p_workspace_id
          and existing.source_entity_type_id = p_entity_type_id
          and existing.source_record_id = p_record_id
          and existing.field_definition_id = v_field_id
          and existing.member_user_id = v_member_user_id
      )
    ) then
      raise exception '% must reference an active workspace member.', v_field.name;
    end if;
  end loop;

  delete from entity_record_workspace_member_values value
  where value.workspace_id = p_workspace_id
    and value.source_entity_type_id = p_entity_type_id
    and value.source_record_id = p_record_id
    and value.field_definition_id in (
      select trim(both '"' from field_id::text)::uuid
      from jsonb_array_elements(p_field_ids) field_id
    );

  for v_member in
    select *
    from jsonb_array_elements(p_workspace_members)
  loop
    v_field_id := (v_member ->> 'field_definition_id')::uuid;
    v_member_user_id := (v_member ->> 'member_user_id')::uuid;

    insert into entity_record_workspace_member_values (
      workspace_id,
      source_entity_type_id,
      source_record_id,
      field_definition_id,
      member_user_id
    )
    values (
      p_workspace_id,
      p_entity_type_id,
      p_record_id,
      v_field_id,
      v_member_user_id
    );
  end loop;
end;
$$;

create or replace function list_workspace_member_values_for_records_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_ids uuid[]
)
returns table (
  source_record_id uuid,
  field_definition_id uuid,
  member_user_id uuid,
  email text,
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
    membership.deactivated_at
  from entity_record_workspace_member_values value
  join workspace_memberships membership
    on membership.workspace_id = value.workspace_id
   and membership.user_id = value.member_user_id
  left join auth.users auth_user
    on auth_user.id = value.member_user_id
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

create or replace function public.add_field_definition_core(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_name text,
  p_slug text,
  p_key text,
  p_type text,
  p_required boolean,
  p_related_entity_type_id uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_field_definition_id uuid := gen_random_uuid();
  v_next_position integer;
  v_record_count integer;
begin
  if p_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice', 'workspace_member') then
    raise exception 'Unsupported field type: %', p_type;
  end if;

  if p_type = 'relation' and p_related_entity_type_id is null then
    raise exception 'Relation fields require a related entity type';
  end if;

  if p_type <> 'relation' and p_related_entity_type_id is not null then
    raise exception 'Only relation fields may declare a related entity type';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  if p_required then
    select count(*)
      into v_record_count
    from entity_records
    where workspace_id = p_workspace_id
      and entity_type_id = p_entity_type_id;

    if v_record_count > 0 then
      raise exception 'Cannot add a required field to an object that already has records';
    end if;
  end if;

  select coalesce(max(position), 0) + 1
    into v_next_position
  from field_definitions
  where workspace_id = p_workspace_id
    and entity_type_id = p_entity_type_id;

  insert into field_definitions (
    id, workspace_id, entity_type_id, key, name, slug, type,
    related_entity_type_id, required, position
  )
  values (
    v_field_definition_id, p_workspace_id, p_entity_type_id, p_key, p_name, p_slug, p_type,
    p_related_entity_type_id, p_required, v_next_position
  );

  return v_field_definition_id;
end;
$$;

create or replace function public.create_entity_type_with_fields_core(
  p_workspace_id uuid,
  p_entity_name text,
  p_entity_slug text,
  p_entity_description text,
  p_fields jsonb
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entity_type_id uuid := gen_random_uuid();
  v_field jsonb;
  v_field_definition_id uuid;
  v_field_type text;
  v_field_position integer;
  v_related_entity_type_id uuid;
  v_choice_options jsonb;
  v_choice_option jsonb;
  v_choice_option_id uuid;
  v_choice_option_label text;
  v_choice_option_color text;
  v_choice_option_position integer;
  v_display_field_definition_id uuid;
  v_display_field_name text;
  v_entity_name text := trim(p_entity_name);
  v_entity_description text := nullif(trim(coalesce(p_entity_description, '')), '');
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'p_fields must be a JSON array';
  end if;

  if jsonb_array_length(p_fields) = 0 then
    raise exception 'p_fields must include at least one field';
  end if;

  insert into entity_types (id, workspace_id, name, slug, description)
  values (
    v_entity_type_id,
    p_workspace_id,
    v_entity_name,
    trim(p_entity_slug),
    v_entity_description
  );

  for v_field in select * from jsonb_array_elements(p_fields)
  loop
    v_field_definition_id := gen_random_uuid();
    v_field_type := v_field->>'type';
    v_field_position := (v_field->>'position')::integer;
    v_related_entity_type_id := nullif(v_field->>'related_entity_type_id', '')::uuid;
    v_choice_options := v_field->'choice_options';

    if v_field_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice', 'workspace_member') then
      raise exception 'Unsupported field type: %', v_field_type;
    end if;

    if v_field_position <= 0 then
      raise exception 'Field position must be positive';
    end if;

    if v_field_type = 'relation' and v_related_entity_type_id is null then
      raise exception 'Relation fields require a related entity type';
    end if;

    if v_field_type <> 'relation' and v_related_entity_type_id is not null then
      raise exception 'Only relation fields may declare a related entity type';
    end if;

    if v_field_type <> 'choice' and v_choice_options is not null then
      raise exception 'Only choice fields may declare choice_options';
    end if;

    if v_field_type = 'choice'
      and v_choice_options is not null
      and jsonb_typeof(v_choice_options) <> 'array' then
      raise exception 'choice_options must be a JSON array';
    end if;

    insert into field_definitions (
      id,
      workspace_id,
      entity_type_id,
      key,
      name,
      slug,
      type,
      related_entity_type_id,
      required,
      position
    )
    values (
      v_field_definition_id,
      p_workspace_id,
      v_entity_type_id,
      v_field->>'key',
      v_field->>'name',
      v_field->>'slug',
      v_field_type,
      v_related_entity_type_id,
      coalesce((v_field->>'required')::boolean, false),
      v_field_position
    );

    perform private.governance_audit_insert(
      p_workspace_id,
      'field_created',
      'field',
      v_field_definition_id,
      v_field->>'name',
      null,
      null,
      v_entity_type_id,
      v_entity_name,
      jsonb_build_object('new', jsonb_build_object(
        'name', v_field->>'name',
        'required', coalesce((v_field->>'required')::boolean, false),
        'type', v_field_type
      ))
    );

    if v_field_type = 'choice' and v_choice_options is not null then
      v_choice_option_position := 0;

      for v_choice_option in select * from jsonb_array_elements(v_choice_options)
      loop
        v_choice_option_position := v_choice_option_position + 1;
        v_choice_option_id := gen_random_uuid();

        if jsonb_typeof(v_choice_option) <> 'object' then
          raise exception 'Each choice option must be a JSON object';
        end if;

        v_choice_option_label := trim(coalesce(v_choice_option->>'label', ''));
        v_choice_option_color := nullif(v_choice_option->>'color', '');

        if v_choice_option_label = '' then
          raise exception 'Choice option label is required';
        end if;

        if v_choice_option_color is not null
          and v_choice_option_color not in (
            'gray', 'red', 'amber', 'emerald', 'blue', 'violet',
            'orange', 'teal', 'cyan', 'indigo', 'rose', 'lime'
          ) then
          raise exception 'Unsupported choice option color: %', v_choice_option_color;
        end if;

        if v_choice_option ? 'archived_at' then
          raise exception 'Initial choice options cannot be archived';
        end if;

        insert into field_choice_options (
          id,
          workspace_id,
          field_definition_id,
          label,
          color,
          position
        )
        values (
          v_choice_option_id,
          p_workspace_id,
          v_field_definition_id,
          v_choice_option_label,
          v_choice_option_color,
          v_choice_option_position
        );

        perform private.governance_audit_insert(
          p_workspace_id,
          'choice_option_created',
          'choice_option',
          v_choice_option_id,
          v_choice_option_label,
          v_field_definition_id,
          v_field->>'name',
          v_entity_type_id,
          v_entity_name,
          jsonb_build_object('new', jsonb_build_object('label', v_choice_option_label))
        );
      end loop;
    end if;

    if v_field_type = 'text' and v_display_field_definition_id is null then
      v_display_field_definition_id := v_field_definition_id;
      v_display_field_name := v_field->>'name';
    end if;
  end loop;

  if v_display_field_definition_id is not null then
    perform private.assign_initial_entity_type_display(
      p_workspace_id,
      v_entity_type_id,
      v_display_field_definition_id
    );
  end if;

  perform private.governance_audit_insert(
    p_workspace_id,
    'entity_type_created',
    'entity_type',
    v_entity_type_id,
    v_entity_name,
    null,
    null,
    null,
    null,
    jsonb_build_object('new', jsonb_build_object(
      'name', v_entity_name,
      'description', v_entity_description,
      'display_field_definition_id', v_display_field_definition_id,
      'display_field_name', v_display_field_name
    ))
  );

  return v_entity_type_id;
end;
$$;

create or replace function delete_field_definition_if_safe(
  p_workspace_id uuid, p_entity_type_id uuid, p_field_definition_id uuid
)
returns table (
  deleted boolean, record_value_count bigint, relation_value_count bigint, workflow_reference_count bigint,
  display_field_reference_count bigint, view_reference_count bigint, process_branch_reference_count bigint
)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_field field_definitions%rowtype;
  v_template_token text;
  v_process_branch_reference_count bigint := 0;
  v_workspace_member_value_count bigint := 0;
begin
  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id for update;
  if not found then raise exception 'Field definition not found.'; end if;

  select count(*) into record_value_count from entity_records
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and values ? v_field.key;
  select count(*) into relation_value_count from entity_record_relation_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  select count(*) into v_workspace_member_value_count from entity_record_workspace_member_values
  where workspace_id = p_workspace_id and source_entity_type_id = p_entity_type_id and field_definition_id = p_field_definition_id;
  relation_value_count := relation_value_count + v_workspace_member_value_count;
  select count(*) into display_field_reference_count from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id and display_field_definition_id = p_field_definition_id;
  v_template_token := '{{field:' || p_field_definition_id::text || '}}';
  select count(*) into workflow_reference_count from workflows workflow
  where workflow.workspace_id = p_workspace_id and (
    exists (select 1 from jsonb_array_elements_text(coalesce(workflow.action_config #> '{triggerConfig,watchedFieldDefinitionIds}', '[]'::jsonb)) watched(field_definition_id) where watched.field_definition_id = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(coalesce(workflow.action_config -> 'conditions', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(workflow.actions) action where action ->> 'relatedFieldDefinitionId' = p_field_definition_id::text or exists (
      select 1 from jsonb_array_elements(coalesce(action -> 'fieldMappings', '[]'::jsonb)) mapping
      where mapping ->> 'targetFieldDefinitionId' = p_field_definition_id::text
        or mapping #>> '{source,sourceFieldDefinitionId}' = p_field_definition_id::text
        or coalesce(mapping #>> '{source,template}', '') like '%' || v_template_token || '%'
    ))
  );
  select count(*) into view_reference_count from entity_views view
  where view.workspace_id = p_workspace_id and view.entity_type_id = p_entity_type_id and (
    exists (select 1 from jsonb_array_elements(coalesce(view.filters, '[]'::jsonb)) filter where filter ->> 'fieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements(coalesce(view.sorts, '[]'::jsonb)) sort where sort ->> 'fieldDefinitionId' = p_field_definition_id::text)
    or exists (select 1 from jsonb_array_elements_text(coalesce(view.column_field_definition_ids, '[]'::jsonb)) column_field_definition_id where column_field_definition_id = p_field_definition_id::text)
  );
  select count(*) into v_process_branch_reference_count
  from process_edges edge join process_templates template on template.workspace_id = edge.workspace_id and template.id = edge.process_template_id
  where edge.workspace_id = p_workspace_id and template.applies_to_entity_type_id = p_entity_type_id
    and exists (select 1 from jsonb_array_elements(coalesce(edge.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_run_routes route
  join process_step_runs source_step on source_step.workspace_id = route.workspace_id and source_step.id = route.source_step_run_id
  join process_runs run on run.workspace_id = route.workspace_id and run.id = route.process_run_id
  where route.workspace_id = p_workspace_id and run.origin_entity_type_id = p_entity_type_id and run.status = 'active' and source_step.status in ('pending', 'active')
    and exists (select 1 from jsonb_array_elements(coalesce(route.condition_config, '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text);
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_nodes node join process_templates template on template.workspace_id = node.workspace_id and template.id = node.process_template_id
  where node.workspace_id = p_workspace_id and node.node_type = 'condition_wait' and (
    (template.applies_to_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (node.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(node.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or node.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  select v_process_branch_reference_count + count(*) into v_process_branch_reference_count
  from process_step_runs step join process_runs run on run.workspace_id = step.workspace_id and run.id = step.process_run_id
  where step.workspace_id = p_workspace_id and step.node_type = 'condition_wait' and step.status in ('pending', 'active') and run.status = 'active' and (
    (run.origin_entity_type_id = p_entity_type_id and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or (step.config #>> '{condition_wait_rule,target,target_entity_type_id}' = p_entity_type_id::text and exists (select 1 from jsonb_array_elements(coalesce(step.config #> '{condition_wait_rule,conditions}', '[]'::jsonb)) condition where condition ->> 'sourceFieldDefinitionId' = p_field_definition_id::text))
    or step.config #>> '{condition_wait_rule,target,relation_field_definition_id}' = p_field_definition_id::text
  );
  process_branch_reference_count := v_process_branch_reference_count;
  if record_value_count = 0 and relation_value_count = 0 and workflow_reference_count = 0 and display_field_reference_count = 0 and view_reference_count = 0 and v_process_branch_reference_count = 0 then
    delete from field_definitions where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id;
    deleted := true;
  else
    deleted := false;
  end if;
  return next;
end;
$$;

alter function private.field_definition_type_change_dependencies(uuid, uuid, uuid)
  rename to field_definition_type_change_dependencies_pre_workspace_member;

create function private.field_definition_type_change_dependencies(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid
)
returns table (
  pristine boolean,
  record_value_count bigint,
  relation_value_count bigint,
  choice_option_count bigint,
  display_field_reference_count bigint,
  quality_review_reference_count bigint,
  people_sensitive_reference_count bigint,
  view_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  d record;
  v_workspace_member_value_count bigint := 0;
begin
  select * into d
  from private.field_definition_type_change_dependencies_pre_workspace_member(
    p_workspace_id,
    p_entity_type_id,
    p_field_definition_id
  );

  select count(*) into v_workspace_member_value_count
  from entity_record_workspace_member_values
  where workspace_id = p_workspace_id
    and source_entity_type_id = p_entity_type_id
    and field_definition_id = p_field_definition_id;

  record_value_count := d.record_value_count;
  relation_value_count := d.relation_value_count + v_workspace_member_value_count;
  choice_option_count := d.choice_option_count;
  display_field_reference_count := d.display_field_reference_count;
  quality_review_reference_count := d.quality_review_reference_count;
  people_sensitive_reference_count := d.people_sensitive_reference_count;
  view_reference_count := d.view_reference_count;
  workflow_reference_count := d.workflow_reference_count;
  process_reference_count := d.process_reference_count;
  pristine := d.pristine and v_workspace_member_value_count = 0;

  return next;
end;
$$;

revoke all on function private.field_definition_type_change_dependencies_pre_workspace_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.field_definition_type_change_dependencies_pre_workspace_member(uuid, uuid, uuid) to service_role;
revoke all on function private.field_definition_type_change_dependencies(uuid, uuid, uuid) from public, authenticated;
grant execute on function private.field_definition_type_change_dependencies(uuid, uuid, uuid) to service_role;

create or replace function change_field_definition_type_if_safe_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_field_definition_id uuid,
  p_new_type text,
  p_new_related_entity_type_id uuid
)
returns table (
  changed boolean,
  record_value_count bigint,
  relation_value_count bigint,
  choice_option_count bigint,
  display_field_reference_count bigint,
  quality_review_reference_count bigint,
  people_sensitive_reference_count bigint,
  view_reference_count bigint,
  workflow_reference_count bigint,
  process_reference_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_field field_definitions%rowtype;
  v_entity entity_types%rowtype;
  v_old_type text;
  v_old_related_entity_type_id uuid;
  d record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'schema.manage');

  if p_new_type not in ('text', 'number', 'date', 'boolean', 'relation', 'choice', 'workspace_member') then
    raise exception 'Unsupported field type: %', p_new_type;
  end if;

  if p_new_type = 'relation' and p_new_related_entity_type_id is null then
    raise exception 'Relation fields require a related entity type';
  end if;

  if p_new_type <> 'relation' and p_new_related_entity_type_id is not null then
    raise exception 'Only relation fields may declare a related entity type';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  select * into v_entity from entity_types
  where workspace_id = p_workspace_id and id = p_entity_type_id
  for update;
  if not found then
    raise exception 'Entity type not found.';
  end if;

  select * into v_field from field_definitions
  where workspace_id = p_workspace_id and entity_type_id = p_entity_type_id and id = p_field_definition_id
  for update;
  if not found then
    raise exception 'Field definition not found.';
  end if;

  if v_field.type = p_new_type then
    raise exception 'Field is already this type.';
  end if;

  select * into d from private.field_definition_type_change_dependencies(p_workspace_id, p_entity_type_id, p_field_definition_id);

  if d.pristine then
    v_old_type := v_field.type;
    v_old_related_entity_type_id := v_field.related_entity_type_id;

    update field_definitions
    set type = p_new_type,
        related_entity_type_id = p_new_related_entity_type_id,
        updated_at = now()
    where workspace_id = p_workspace_id and id = p_field_definition_id;

    perform private.governance_audit_insert(
      p_workspace_id, 'field_type_changed', 'field', v_field.id, v_field.name, null, null, v_entity.id, v_entity.name,
      jsonb_build_object(
        'old', jsonb_build_object('type', v_old_type, 'relatedEntityTypeId', v_old_related_entity_type_id),
        'new', jsonb_build_object('type', p_new_type, 'relatedEntityTypeId', p_new_related_entity_type_id)
      )
    );
  end if;

  return query select d.pristine, d.record_value_count, d.relation_value_count, d.choice_option_count,
    d.display_field_reference_count, d.quality_review_reference_count, d.people_sensitive_reference_count,
    d.view_reference_count, d.workflow_reference_count, d.process_reference_count;
end;
$$;

create or replace function private.bulk_create_entity_records_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_import_id uuid,
  p_rows jsonb
)
returns table (imported_row_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_count integer;
  v_row jsonb;
  v_values jsonb;
  v_relation jsonb;
  v_record_id uuid;
  v_field field_definitions%rowtype;
  v_inserted_count integer := 0;
begin
  perform private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate');

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty JSON array';
  end if;

  if not exists (
    select 1 from entity_types
    where workspace_id = p_workspace_id and id = p_entity_type_id and archived_at is null
  ) then
    raise exception 'Object not found or archived';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));

  insert into record_import_batches (id, workspace_id, entity_type_id, actor_user_id)
  values (p_import_id, p_workspace_id, p_entity_type_id, auth.uid())
  on conflict (id) do nothing;

  if not found then
    select record_import_batches.imported_row_count
      into v_existing_count
      from record_import_batches
      where id = p_import_id
        and workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id;

    if not found then
      raise exception 'Import ID already used for a different object';
    end if;

    return query select v_existing_count;
    return;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_values := coalesce(v_row->'values', '{}'::jsonb);

    for v_field in
      select *
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and required = true
        and archived_at is null
      order by position
    loop
      if v_field.type = 'relation' then
        if not exists (
          select 1
          from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb)) relation
          where relation->>'field_definition_id' = v_field.id::text
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'workspace_member' then
        if not exists (
          select 1
          from jsonb_array_elements(coalesce(v_row->'workspace_members', '[]'::jsonb)) member
          where member->>'field_definition_id' = v_field.id::text
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'text' then
        if not (
          v_values ? v_field.key
          and jsonb_typeof(v_values -> v_field.key) = 'string'
          and btrim(v_values ->> v_field.key) <> ''
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'number' then
        if not (
          v_values ? v_field.key
          and jsonb_typeof(v_values -> v_field.key) = 'number'
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'date' then
        if not (
          v_values ? v_field.key
          and jsonb_typeof(v_values -> v_field.key) = 'string'
          and v_values ->> v_field.key ~ '^\d{4}-\d{2}-\d{2}$'
          and to_char(to_date(v_values ->> v_field.key, 'YYYY-MM-DD'), 'YYYY-MM-DD') =
            v_values ->> v_field.key
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'boolean' then
        if not (
          v_values ? v_field.key
          and jsonb_typeof(v_values -> v_field.key) = 'boolean'
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      elsif v_field.type = 'choice' then
        if not (
          v_values ? v_field.key
          and jsonb_typeof(v_values -> v_field.key) = 'string'
        ) then
          raise exception '% is required.', v_field.name;
        end if;
      end if;
    end loop;

    for v_field in
      select *
      from field_definitions
      where workspace_id = p_workspace_id
        and entity_type_id = p_entity_type_id
        and type = 'choice'
        and archived_at is null
    loop
      if v_values ? v_field.key and v_values -> v_field.key <> 'null'::jsonb then
        begin
          if jsonb_typeof(v_values -> v_field.key) <> 'string'
            or not exists (
              select 1 from field_choice_options
              where workspace_id = p_workspace_id
                and field_definition_id = v_field.id
                and id = (v_values ->> v_field.key)::uuid
                and archived_at is null
            )
          then
            raise exception '% must reference an active option.', v_field.name;
          end if;
        exception
          when invalid_text_representation then
            raise exception '% must reference an active option.', v_field.name;
        end;
      end if;
    end loop;

    for v_relation in select * from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb))
    loop
      begin
        select * into v_field
        from field_definitions
        where workspace_id = p_workspace_id
          and id = (v_relation ->> 'field_definition_id')::uuid
          and type = 'relation';

        if not found
          or v_field.related_entity_type_id is distinct from (v_relation ->> 'target_entity_type_id')::uuid
        then
          raise exception 'A relation must reference its own configured related object.';
        end if;

        if not exists (
          select 1 from entity_records
          where workspace_id = p_workspace_id
            and entity_type_id = v_field.related_entity_type_id
            and id = (v_relation ->> 'target_record_id')::uuid
            and archived_at is null
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;

        if not private.can_view_people_sensitive_record(
          p_workspace_id, v_field.related_entity_type_id, (v_relation ->> 'target_record_id')::uuid,
          private.current_effective_user(p_workspace_id)
        ) then
          raise exception '% must reference an active record.', v_field.name;
        end if;
      exception
        when invalid_text_representation then
          raise exception 'A relation must reference a valid record.';
      end;
    end loop;

    v_record_id := gen_random_uuid();

    insert into entity_records (id, workspace_id, entity_type_id, values, import_batch_id)
    values (v_record_id, p_workspace_id, p_entity_type_id, v_values, p_import_id);

    for v_relation in select * from jsonb_array_elements(coalesce(v_row->'relations', '[]'::jsonb))
    loop
      insert into entity_record_relation_values (
        workspace_id,
        source_entity_type_id,
        source_record_id,
        field_definition_id,
        target_entity_type_id,
        target_record_id
      )
      values (
        p_workspace_id,
        p_entity_type_id,
        v_record_id,
        (v_relation->>'field_definition_id')::uuid,
        (v_relation->>'target_entity_type_id')::uuid,
        (v_relation->>'target_record_id')::uuid
      );
    end loop;

    perform private.apply_workspace_member_record_values(
      p_workspace_id,
      p_entity_type_id,
      v_record_id,
      private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
      coalesce(v_row->'workspace_members', '[]'::jsonb),
      false,
      true
    );

    v_inserted_count := v_inserted_count + 1;
  end loop;

  update record_import_batches
  set imported_row_count = v_inserted_count
  where id = p_import_id;

  return query select v_inserted_count;
end;
$$;

create or replace function public.bulk_create_entity_records_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_import_id uuid,
  p_rows jsonb
)
returns table (imported_row_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_record entity_records%rowtype;
  a record;
  v_relations jsonb;
  v_members jsonb;
begin
  if auth.role() = 'service_role' and auth.uid() is null then
    return query select * from private.bulk_create_entity_records_authorized(
      p_workspace_id, p_entity_type_id, p_import_id, p_rows
    );
    return;
  end if;

  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return query select * from private.bulk_create_entity_records_authorized(
    p_workspace_id, p_entity_type_id, p_import_id, p_rows
  );

  select record_import_batches.imported_row_count
    into v_count
    from record_import_batches
    where record_import_batches.id = p_import_id;

  for v_record in
    select *
    from entity_records
    where workspace_id = p_workspace_id
      and import_batch_id = p_import_id
  loop
    if not exists (
      select 1
      from record_change_events
      where entity_record_id = v_record.id
        and event_type = 'record_created'
    ) then
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'field_definition_id', field_definition_id,
          'target_entity_type_id', target_entity_type_id,
          'target_record_id', target_record_id
        )),
        '[]'::jsonb
      )
        into v_relations
        from entity_record_relation_values
        where workspace_id = p_workspace_id
          and source_record_id = v_record.id;

      perform private.record_change_insert(
        p_workspace_id,
        p_entity_type_id,
        v_record.id,
        'record_created',
        a.effective_actor_user_id,
        a.real_actor_user_id,
        a.authority_kind,
        null,
        null,
        p_import_id,
        private.record_change_payload(
          p_workspace_id,
          p_entity_type_id,
          v_record.id,
          null,
          v_record.values,
          '[]'::jsonb,
          v_relations
        )
      );
    end if;

    v_members := private.workspace_member_value_snapshot(
      p_workspace_id,
      p_entity_type_id,
      v_record.id
    );
    perform private.workspace_member_append_activity(
      p_workspace_id,
      p_entity_type_id,
      v_record.id,
      'record_updated',
      '[]'::jsonb,
      v_members,
      a.effective_actor_user_id,
      a.real_actor_user_id,
      a.authority_kind
    );
  end loop;
end;
$$;

revoke all on function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.bulk_create_entity_records_authorized(uuid, uuid, uuid, jsonb)
  to authenticated, service_role;

create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_workspace_members jsonb,
  p_originating_process_step_run_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_new_members jsonb;
  a record;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  if p_originating_process_step_run_id is not null then
    raise exception 'Process provenance requires the trusted process door';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  select * into a from private.record_change_interactive_attribution(p_workspace_id);

  v_record_id := private.record_create_core(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );

  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
    p_workspace_members,
    false,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, v_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    'record_updated',
    '[]'::jsonb,
    v_new_members,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );

  return v_record_id;
end;
$$;

create or replace function create_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.create_entity_record_with_relations_authorized(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    '[]'::jsonb,
    p_originating_process_step_run_id
  );
end;
$$;

create or replace function update_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_workspace_member_field_ids jsonb,
  p_workspace_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_old_members jsonb;
  v_new_members jsonb;
  a record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  v_old_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  v_record_id := public.update_entity_record_with_relations_authorized(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations
  );

  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_workspace_member_field_ids,
    p_workspace_members,
    true,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    'record_updated',
    v_old_members,
    v_new_members,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );

  return v_record_id;
end;
$$;

create or replace function update_entity_record_with_relations_authorized(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.require_interactive_workspace_capability(p_workspace_id, 'records.operate');
  select * into a from private.record_change_interactive_attribution(p_workspace_id);
  return private.record_update_core(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    a.effective_actor_user_id,
    a.real_actor_user_id,
    a.authority_kind
  );
end;
$$;

create or replace function create_entity_record_with_relations_automation_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_workspace_members jsonb,
  p_originating_workflow_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.assert_automation_cause(
    p_workspace_id,
    p_originating_workflow_id,
    p_entity_type_id,
    p_action_type,
    p_related_field_definition_id
  );
  v_record_id := private.record_create_core(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
    p_workspace_members,
    false,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, v_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    'record_updated',
    '[]'::jsonb,
    v_new_members,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
  return v_record_id;
end;
$$;

create or replace function create_entity_record_with_relations_automation_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_workflow_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.create_entity_record_with_relations_automation_system(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    '[]'::jsonb,
    p_originating_workflow_id,
    p_action_type,
    p_related_field_definition_id
  );
end;
$$;

create or replace function update_entity_record_with_relations_automation_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_workspace_member_field_ids jsonb,
  p_workspace_members jsonb,
  p_originating_workflow_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_old_members jsonb;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  v_old_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  v_record_id := public.update_entity_record_with_relations_automation_system(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    p_originating_workflow_id,
    p_action_type,
    p_related_field_definition_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_workspace_member_field_ids,
    p_workspace_members,
    true,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    'record_updated',
    v_old_members,
    v_new_members,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
  return v_record_id;
end;
$$;

create or replace function update_entity_record_with_relations_automation_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_originating_workflow_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.assert_automation_cause(
    p_workspace_id,
    p_originating_workflow_id,
    p_entity_type_id,
    p_action_type,
    p_related_field_definition_id
  );
  return private.record_update_core(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    null,
    null,
    'automation',
    p_originating_workflow_id
  );
end;
$$;

create or replace function create_entity_record_with_relations_process_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_workspace_members jsonb,
  p_originating_process_step_run_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.assert_process_cause(
    p_workspace_id,
    p_originating_process_step_run_id,
    p_entity_type_id,
    p_action_type,
    p_related_field_definition_id
  );
  v_record_id := private.record_create_core(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    private.workspace_member_field_ids_json(p_workspace_id, p_entity_type_id),
    p_workspace_members,
    false,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, v_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    v_record_id,
    'record_updated',
    '[]'::jsonb,
    v_new_members,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
  return v_record_id;
end;
$$;

create or replace function create_entity_record_with_relations_process_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_values jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.create_entity_record_with_relations_process_system(
    p_workspace_id,
    p_entity_type_id,
    p_values,
    p_relations,
    '[]'::jsonb,
    p_originating_process_step_run_id,
    p_action_type,
    p_related_field_definition_id
  );
end;
$$;

create or replace function update_entity_record_with_relations_process_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_workspace_member_field_ids jsonb,
  p_workspace_members jsonb,
  p_originating_process_step_run_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record_id uuid;
  v_old_members jsonb;
  v_new_members jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  v_old_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  v_record_id := public.update_entity_record_with_relations_process_system(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    p_originating_process_step_run_id,
    p_action_type,
    p_related_field_definition_id
  );
  perform private.apply_workspace_member_record_values(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_workspace_member_field_ids,
    p_workspace_members,
    true,
    true
  );
  v_new_members := private.workspace_member_value_snapshot(p_workspace_id, p_entity_type_id, p_record_id);
  perform private.workspace_member_append_activity(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    'record_updated',
    v_old_members,
    v_new_members,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
  return v_record_id;
end;
$$;

create or replace function update_entity_record_with_relations_process_system(
  p_workspace_id uuid,
  p_entity_type_id uuid,
  p_record_id uuid,
  p_values jsonb,
  p_relation_field_ids jsonb,
  p_relations jsonb,
  p_originating_process_step_run_id uuid,
  p_action_type text,
  p_related_field_definition_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0));
  perform private.assert_process_cause(
    p_workspace_id,
    p_originating_process_step_run_id,
    p_entity_type_id,
    p_action_type,
    p_related_field_definition_id
  );
  return private.record_update_core(
    p_workspace_id,
    p_entity_type_id,
    p_record_id,
    p_values,
    p_relation_field_ids,
    p_relations,
    null,
    null,
    'process',
    null,
    p_originating_process_step_run_id
  );
end;
$$;

revoke all on function
  create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, jsonb, uuid),
  update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb)
from public, anon;
grant execute on function
  create_entity_record_with_relations_authorized(uuid, uuid, jsonb, jsonb, jsonb, uuid),
  update_entity_record_with_relations_authorized(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb)
to authenticated, service_role;

revoke all on function
  create_entity_record_with_relations_automation_system(uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid),
  update_entity_record_with_relations_automation_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, uuid),
  create_entity_record_with_relations_process_system(uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid),
  update_entity_record_with_relations_process_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, uuid)
from public, anon, authenticated;
grant execute on function
  create_entity_record_with_relations_automation_system(uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid),
  update_entity_record_with_relations_automation_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, uuid),
  create_entity_record_with_relations_process_system(uuid, uuid, jsonb, jsonb, jsonb, uuid, text, uuid),
  update_entity_record_with_relations_process_system(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, uuid, text, uuid)
to service_role;
