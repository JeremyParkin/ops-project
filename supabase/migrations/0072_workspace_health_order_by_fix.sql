-- 0071's list_workspace_health_findings_authorized ended its five-branch
-- UNION ALL with `order by (severity = 'needs_attention') desc, ...` --
-- Postgres rejects an expression (as opposed to a plain output column name
-- or ordinal position) in an ORDER BY applied directly to a set operation:
-- "invalid UNION/INTERSECT/EXCEPT ORDER BY clause". Confirmed directly --
-- every call failed the moment this function actually ran. Fix: wrap the
-- union in a subquery and apply the ORDER BY to that outer, ordinary
-- SELECT, where expressions are permitted; no other line changes.
create or replace function list_workspace_health_findings_authorized(p_workspace_id uuid)
returns table (
  finding_id text,
  check_type text,
  severity text,
  title text,
  detail text,
  entity_type_id uuid,
  entity_type_name text,
  record_id uuid,
  record_label text,
  process_run_id uuid,
  process_template_name text,
  process_step_run_id uuid,
  member_email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_workspace_capability(p_workspace_id, 'workspace.manage_settings');

  return query
  select * from (
    select
      'no_active_fields:' || et.id::text as finding_id,
      'no_active_fields' as check_type,
      'needs_attention' as severity,
      et.name || ' has no active fields' as title,
      'This business object has no active fields, so no data can be recorded against it.' as detail,
      et.id as entity_type_id, et.name as entity_type_name,
      null::uuid as record_id, null::text as record_label,
      null::uuid as process_run_id, null::text as process_template_name,
      null::uuid as process_step_run_id, null::text as member_email
    from entity_types et
    where et.workspace_id = p_workspace_id and et.archived_at is null
      and not exists (
        select 1 from field_definitions fd
        where fd.workspace_id = et.workspace_id and fd.entity_type_id = et.id and fd.archived_at is null
      )

    union all

    select
      'missing_display_field:' || et.id::text,
      'missing_display_field',
      'worth_reviewing',
      et.name || ' has no usable display field',
      'No active text field exists, so records show only a shortened id instead of a readable label.',
      et.id, et.name,
      null::uuid, null::text,
      null::uuid, null::text,
      null::uuid, null::text
    from entity_types et
    where et.workspace_id = p_workspace_id and et.archived_at is null
      and exists (
        select 1 from field_definitions fd
        where fd.workspace_id = et.workspace_id and fd.entity_type_id = et.id and fd.archived_at is null
      )
      and not exists (
        select 1 from field_definitions fd
        where fd.workspace_id = et.workspace_id and fd.entity_type_id = et.id
          and fd.type = 'text' and fd.archived_at is null
      )

    union all

    select
      'recurrence_unreachable:' || r.id::text,
      'recurrence_unreachable',
      'needs_attention',
      'Recurrence rule for ' || coalesce(t.name, 'an archived process') || ' can never fire',
      case
        when t.id is null or t.archived_at is not null then 'The process template this rule starts has been archived.'
        when er.id is null or er.archived_at is not null then 'The origin record this rule is anchored to has been archived.'
        when r.end_date is not null and r.end_date < current_date then 'This rule''s end date has already passed.'
        else 'This rule can no longer produce a new occurrence.'
      end,
      oet.id, oet.name,
      er.id, coalesce(nullif(btrim(er.values ->> df.key), ''), left(er.id::text, 8) || '...'),
      null::uuid, t.name,
      null::uuid, null::text
    from process_recurrence_rules r
    join entity_types oet on oet.workspace_id = r.workspace_id and oet.id = r.origin_entity_type_id
    left join process_templates t on t.workspace_id = r.workspace_id and t.id = r.process_template_id
    left join entity_records er
      on er.workspace_id = r.workspace_id and er.entity_type_id = r.origin_entity_type_id and er.id = r.origin_record_id
    left join field_definitions df
      on df.workspace_id = oet.workspace_id and df.id = oet.display_field_definition_id
      and df.archived_at is null and df.type = 'text'
    where r.workspace_id = p_workspace_id
      and r.active
      and (
        t.id is null or t.archived_at is not null
        or er.id is null or er.archived_at is not null
        or (r.end_date is not null and r.end_date < current_date)
      )

    union all

    select
      'stuck_process_run:' || pr.id::text,
      'stuck_process_run',
      'needs_attention',
      pr.process_template_name || ' run is stuck with no active or pending steps',
      'This process run is still active, but none of its steps are active or pending -- it should have completed and did not.',
      oet.id, oet.name,
      er.id, coalesce(nullif(btrim(er.values ->> df.key), ''), left(er.id::text, 8) || '...'),
      pr.id, pr.process_template_name,
      null::uuid, null::text
    from process_runs pr
    join entity_types oet on oet.workspace_id = pr.workspace_id and oet.id = pr.origin_entity_type_id
    left join entity_records er
      on er.workspace_id = pr.workspace_id and er.entity_type_id = pr.origin_entity_type_id and er.id = pr.origin_record_id
    left join field_definitions df
      on df.workspace_id = oet.workspace_id and df.id = oet.display_field_definition_id
      and df.archived_at is null and df.type = 'text'
    where pr.workspace_id = p_workspace_id
      and pr.status = 'active'
      and not exists (
        select 1 from process_step_runs psr
        where psr.workspace_id = pr.workspace_id and psr.process_run_id = pr.id
          and psr.status in ('active', 'pending')
      )

    union all

    select
      'deactivated_assignee:' || psr.id::text,
      'deactivated_assignee',
      'needs_attention',
      psr.name || ' is assigned to a deactivated member',
      'The member currently assigned to this active step, ' || coalesce(au.email, 'unknown') || ', has been deactivated and cannot act on it.',
      oet.id, oet.name,
      er.id, coalesce(nullif(btrim(er.values ->> df.key), ''), left(er.id::text, 8) || '...'),
      pr.id, pr.process_template_name,
      psr.id, au.email::text
    from process_step_runs psr
    join process_runs pr on pr.workspace_id = psr.workspace_id and pr.id = psr.process_run_id
    join entity_types oet on oet.workspace_id = pr.workspace_id and oet.id = pr.origin_entity_type_id
    left join entity_records er
      on er.workspace_id = pr.workspace_id and er.entity_type_id = pr.origin_entity_type_id and er.id = pr.origin_record_id
    left join field_definitions df
      on df.workspace_id = oet.workspace_id and df.id = oet.display_field_definition_id
      and df.archived_at is null and df.type = 'text'
    join workspace_memberships wm
      on wm.workspace_id = psr.workspace_id and wm.user_id = psr.assignee_user_id and wm.deactivated_at is not null
    join auth.users au on au.id = wm.user_id
    where psr.workspace_id = p_workspace_id
      and psr.status = 'active'
      and psr.assignee_user_id is not null
  ) all_findings
  order by (all_findings.severity = 'needs_attention') desc, all_findings.check_type, all_findings.finding_id;
end;
$$;
