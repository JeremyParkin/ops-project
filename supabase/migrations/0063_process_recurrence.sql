-- Phase 8D.1: Recurrence. Origin-record-anchored process scheduling ("run
-- this process for THIS business object on a schedule"). Deliberately does
-- NOT support template-only recurrence or dynamic/filtered batch recurrence
-- -- every recurrence rule requires a real origin record, preserving
-- ProcessRun's existing origin-record invariant unchanged.
--
-- Architecture mirrors two already-established patterns in this codebase
-- rather than inventing new ones:
--  - Idempotent scheduled work: a durable claim row with a deterministic
--    identity (recurrence_rule_id, occurrence_date), inserted via
--    `on conflict do nothing` before any side effect runs -- the same shape
--    as record_import_batches (0061) and originating_process_step_run_id
--    (0041).
--  - System-vs-interactive authority: process_runs already has a canonical,
--    unwrapped implementation (start_process_run_authorized_member) plus a
--    thin interactive wrapper that adds a `processes.operate` capability
--    check. This migration adds a second thin wrapper -- start_process_run_
--    system -- granted only to service_role, with zero interactive
--    capability check (not merely a bypassed one), calling the exact same
--    canonical member function. There is exactly one process-start
--    implementation; two authority-gated doors into it.

-- 1. Workspace timezone. No existing durable timezone concept anywhere in
-- this schema. Every existing (and new, absent explicit override) workspace
-- defaults to UTC -- an honest neutral default, never a guess at a real
-- workspace's actual timezone from browser/IP/anything else. A builder with
-- workspace.manage_settings (defined in the capability vocabulary since
-- 0045, never consumed by any RPC until now) must explicitly set it before
-- local-wall-clock recurrence behaves the way they expect; until then,
-- schedules are computed and displayed in UTC.
alter table workspaces add column if not exists timezone text not null default 'UTC';

create or replace function set_workspace_timezone_authorized(
  p_workspace_id uuid,
  p_timezone text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'workspace.manage_settings');

  if p_timezone is null or btrim(p_timezone) = '' then
    raise exception 'Timezone is required';
  end if;

  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Unrecognized timezone: %', p_timezone;
  end if;

  update workspaces set timezone = p_timezone, updated_at = now() where id = p_workspace_id;

  if not found then
    raise exception 'Workspace not found';
  end if;
end;
$$;

revoke all on function set_workspace_timezone_authorized(uuid, text) from public, anon;
grant execute on function set_workspace_timezone_authorized(uuid, text) to authenticated, service_role;

-- 2. Recurrence rules. One row per "run this template for this record on
-- this schedule." process_template_id/origin_entity_type_id/origin_record_id
-- are immutable after creation -- the same identity-preservation posture as
-- ProcessTemplate.appliesToEntityTypeId -- so editing a rule only ever
-- changes its schedule, never what it runs or where.
create table process_recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  process_template_id uuid not null,
  origin_entity_type_id uuid not null,
  origin_record_id uuid not null,

  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  interval_count integer not null default 1 check (interval_count between 1 and 999),
  day_of_week smallint check (day_of_week between 0 and 6),
  day_of_month smallint check (day_of_month between 1 and 31),
  start_date date not null,
  end_date date,
  time_of_day time not null,
  active boolean not null default true,

  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (end_date is null or end_date >= start_date),
  check ((frequency = 'weekly') = (day_of_week is not null)),
  check ((frequency = 'monthly') = (day_of_month is not null)),

  unique (workspace_id, id),

  foreign key (workspace_id, process_template_id)
    references process_templates(workspace_id, id)
    on delete restrict,

  foreign key (workspace_id, origin_entity_type_id, origin_record_id)
    references entity_records(workspace_id, entity_type_id, id)
    on delete restrict
);

-- At most one active rule per template+origin -- a builder edits the
-- existing rule to reschedule rather than accumulating parallel ones.
create unique index process_recurrence_rules_one_active_per_origin_idx
  on process_recurrence_rules (workspace_id, process_template_id, origin_record_id)
  where active;

create index process_recurrence_rules_origin_idx
  on process_recurrence_rules (workspace_id, origin_entity_type_id, origin_record_id);

-- The scheduler's discovery scan filters on (active, template not archived,
-- origin not archived); this index supports the active-rule half of that
-- directly, matching the shape of the existing due-wait/due-step indexes.
create index process_recurrence_rules_active_idx
  on process_recurrence_rules (workspace_id, id)
  where active;

alter table process_recurrence_rules enable row level security;

create policy process_recurrence_rules_member_read on process_recurrence_rules
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

revoke all on table process_recurrence_rules from public, anon;
grant select on table process_recurrence_rules to authenticated;

-- 3. Recurrence occurrences. The durable idempotency ledger: a scheduled
-- occurrence's identity is (recurrence_rule_id, occurrence_date) -- never
-- wall-clock invocation time -- so a repeated or concurrent scheduler call
-- for the same occurrence claims the same row and starts at most one
-- ProcessRun. status distinguishes a successfully started occurrence from
-- one that was claimed but failed to start (most commonly: the prior
-- period's run is still active) -- a failed claim is not retried until the
-- next period, matching this codebase's existing preference for visible,
-- explicit failure over silent auto-retry (action-node failures work the
-- same way: a human must retry, nothing retries itself).
create table process_recurrence_occurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  recurrence_rule_id uuid not null,
  occurrence_date date not null,
  scheduled_for timestamptz not null,
  status text not null check (status in ('started', 'failed')),
  process_run_id uuid,
  created_at timestamptz not null default now(),

  check ((status = 'started') = (process_run_id is not null)),

  unique (workspace_id, id),
  unique (workspace_id, recurrence_rule_id, occurrence_date),

  foreign key (workspace_id, recurrence_rule_id)
    references process_recurrence_rules(workspace_id, id)
    on delete cascade,

  -- Column-scoped SET NULL, not a plain one: a plain "on delete set null" on
  -- this composite FK would null every referencing column including
  -- workspace_id, tripping the workspace-immutability trigger even though
  -- workspace_id's actual value never changes -- the exact defect 0044
  -- already found and fixed for originating_process_step_run_id. process_
  -- runs are never actually hard-deleted in this product today (no delete
  -- feature exists), so this path is not currently reachable, but getting
  -- the FK right now avoids reintroducing a known-bad pattern.
  foreign key (workspace_id, process_run_id)
    references process_runs(workspace_id, id)
    on delete set null (process_run_id)
);

create index process_recurrence_occurrences_rule_idx
  on process_recurrence_occurrences (workspace_id, recurrence_rule_id, occurrence_date desc);

alter table process_recurrence_occurrences enable row level security;

create policy process_recurrence_occurrences_member_read on process_recurrence_occurrences
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

revoke all on table process_recurrence_occurrences from public, anon;
grant select on table process_recurrence_occurrences to authenticated;

-- 4. Traceability from the ProcessRun side (provenance only -- the
-- uniqueness above is what actually enforces idempotency; this is the same
-- dual-purpose pattern originating_process_step_run_id already established
-- on entity_records/process_runs in 0041). "The resulting ProcessRun should
-- be indistinguishable from another canonical process run except for its
-- durable recurrence-origin metadata" -- this column is that metadata.
alter table process_runs add column if not exists originating_recurrence_occurrence_id uuid;

alter table process_runs
  add constraint process_runs_originating_recurrence_occurrence_fkey
    foreign key (workspace_id, originating_recurrence_occurrence_id)
    references process_recurrence_occurrences (workspace_id, id) on delete set null (originating_recurrence_occurrence_id);

create unique index process_runs_originating_recurrence_occurrence_uniq
  on process_runs (workspace_id, originating_recurrence_occurrence_id)
  where originating_recurrence_occurrence_id is not null;

-- 5. Pure occurrence-date math. No table access, no security definer, no
-- capability check needed -- every input is an explicit scalar parameter,
-- so the same deterministic instant always produces the same result. This
-- is both the scheduler's discovery math AND directly callable by any
-- authenticated user for testing, with zero risk (it reads nothing, writes
-- nothing). "Latest due occurrence only": this returns at most one row, the
-- single most recent occurrence on or before p_as_of (and on or before
-- p_end_date, if set) -- it never enumerates missed occurrences, so a
-- backlog is structurally impossible, not merely policy.
--
-- Calendar/timezone conversion mirrors private.process_wait_resume_at_from_
-- config (0037) exactly: convert the "as of" instant to the target zone's
-- local date via `at time zone`, do all date arithmetic in local calendar
-- terms, then convert the local scheduled date + time back to a UTC instant
-- the same way. This reuses Postgres's own IANA-timezone-aware conversion
-- for DST, rather than hand-rolling it -- the same reason the existing wait
-- rules never hand-roll it either.
--
-- Monthly semantics: a day-of-month that doesn't exist in a given month
-- (e.g. 31 in February) clamps to that month's last valid day, per interval-
-- month "bucket" anchored to the rule's start_date -- not skipped.
create or replace function compute_recurrence_occurrence_date(
  p_frequency text,
  p_interval_count integer,
  p_day_of_week smallint,
  p_day_of_month smallint,
  p_start_date date,
  p_end_date date,
  p_time_of_day time,
  p_timezone text,
  p_as_of timestamptz
)
returns table (occurrence_date date, scheduled_for timestamptz)
language plpgsql
immutable
as $$
declare
  v_as_of_local_date date;
  v_upper_bound date;
  v_candidate date;
  v_last_valid date;
  v_month_start date;
  v_last_day_of_month integer;
  v_target_day integer;
  v_iterations integer := 0;
  v_max_iterations constant integer := 100000;
begin
  if p_frequency not in ('daily', 'weekly', 'monthly') then
    raise exception 'Unsupported recurrence frequency: %', p_frequency;
  end if;
  if p_interval_count is null or p_interval_count < 1 then
    raise exception 'Recurrence interval must be a positive integer';
  end if;
  if p_timezone is null or btrim(p_timezone) = '' then
    raise exception 'Recurrence requires a timezone';
  end if;

  v_as_of_local_date := (p_as_of at time zone p_timezone)::date;
  v_upper_bound := least(v_as_of_local_date, coalesce(p_end_date, v_as_of_local_date));

  if v_upper_bound < p_start_date then
    return;
  end if;

  if p_frequency = 'daily' then
    v_candidate := p_start_date;
    while v_candidate <= v_upper_bound and v_iterations < v_max_iterations loop
      v_last_valid := v_candidate;
      v_candidate := v_candidate + (p_interval_count || ' days')::interval;
      v_iterations := v_iterations + 1;
    end loop;

  elsif p_frequency = 'weekly' then
    if p_day_of_week is null then
      raise exception 'Weekly recurrence requires a day of week';
    end if;
    v_candidate := p_start_date;
    while extract(dow from v_candidate) <> p_day_of_week and v_iterations < v_max_iterations loop
      v_candidate := v_candidate + 1;
      v_iterations := v_iterations + 1;
    end loop;
    v_iterations := 0;
    while v_candidate <= v_upper_bound and v_iterations < v_max_iterations loop
      v_last_valid := v_candidate;
      v_candidate := v_candidate + (p_interval_count * 7 || ' days')::interval;
      v_iterations := v_iterations + 1;
    end loop;

  elsif p_frequency = 'monthly' then
    if p_day_of_month is null then
      raise exception 'Monthly recurrence requires a day of month';
    end if;
    v_month_start := date_trunc('month', p_start_date)::date;
    loop
      v_last_day_of_month := extract(day from ((v_month_start + interval '1 month') - interval '1 day'))::integer;
      v_target_day := least(p_day_of_month, v_last_day_of_month);
      v_candidate := v_month_start + (v_target_day - 1);

      exit when v_candidate > v_upper_bound or v_iterations >= v_max_iterations;

      if v_candidate >= p_start_date then
        v_last_valid := v_candidate;
      end if;

      v_month_start := (v_month_start + (p_interval_count || ' months')::interval)::date;
      v_iterations := v_iterations + 1;
    end loop;
  end if;

  if v_last_valid is null then
    return;
  end if;

  occurrence_date := v_last_valid;
  scheduled_for := (v_last_valid::timestamp + p_time_of_day) at time zone p_timezone;
  return next;
end;
$$;

revoke all on function compute_recurrence_occurrence_date(text, integer, smallint, smallint, date, date, time, text, timestamptz) from public, anon;
grant execute on function compute_recurrence_occurrence_date(text, integer, smallint, smallint, date, date, time, text, timestamptz) to authenticated, service_role;

-- 6. Interactive rule management -- automation.manage, matching Process
-- Template configuration exactly (recurrence is configuration, not an
-- interactive run action; processes.operate is deliberately not sufficient
-- here, same distinction start_process_run_authorized already draws
-- between configuring and operating). Origin/template are validated but
-- never accepted as editable afterward -- only update_process_recurrence_
-- rule_authorized's schedule fields and set_process_recurrence_rule_active_
-- authorized's active flag can change an existing rule.
create or replace function create_process_recurrence_rule_authorized(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_frequency text,
  p_interval_count integer,
  p_day_of_week smallint,
  p_day_of_month smallint,
  p_start_date date,
  p_end_date date,
  p_time_of_day time
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule_id uuid;
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');

  if not exists (
    select 1 from process_templates
    where workspace_id = p_workspace_id and id = p_process_template_id and archived_at is null
  ) then
    raise exception 'Process template not found or archived';
  end if;

  if not exists (
    select 1 from process_templates
    where workspace_id = p_workspace_id and id = p_process_template_id
      and applies_to_entity_type_id = p_origin_entity_type_id
  ) then
    raise exception 'Process template does not apply to this record''s entity type';
  end if;

  if not exists (
    select 1 from entity_records
    where workspace_id = p_workspace_id and entity_type_id = p_origin_entity_type_id
      and id = p_origin_record_id and archived_at is null
  ) then
    raise exception 'Origin record not found or archived';
  end if;

  -- interval_count/frequency/day_of_week/day_of_month/end_date>=start_date
  -- are enforced by table CHECK constraints; a malformed combination raises
  -- there rather than being silently coerced.
  insert into process_recurrence_rules (
    id, workspace_id, process_template_id, origin_entity_type_id, origin_record_id,
    frequency, interval_count, day_of_week, day_of_month, start_date, end_date, time_of_day,
    created_by
  )
  values (
    gen_random_uuid(), p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id,
    p_frequency, p_interval_count, p_day_of_week, p_day_of_month, p_start_date, p_end_date, p_time_of_day,
    auth.uid()
  )
  returning id into v_rule_id;

  return v_rule_id;
end;
$$;

revoke all on function create_process_recurrence_rule_authorized(uuid, uuid, uuid, uuid, text, integer, smallint, smallint, date, date, time) from public, anon;
grant execute on function create_process_recurrence_rule_authorized(uuid, uuid, uuid, uuid, text, integer, smallint, smallint, date, date, time) to authenticated, service_role;

create or replace function update_process_recurrence_rule_authorized(
  p_workspace_id uuid,
  p_recurrence_rule_id uuid,
  p_frequency text,
  p_interval_count integer,
  p_day_of_week smallint,
  p_day_of_month smallint,
  p_start_date date,
  p_end_date date,
  p_time_of_day time
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');

  update process_recurrence_rules
  set frequency = p_frequency,
      interval_count = p_interval_count,
      day_of_week = p_day_of_week,
      day_of_month = p_day_of_month,
      start_date = p_start_date,
      end_date = p_end_date,
      time_of_day = p_time_of_day,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_recurrence_rule_id;

  if not found then
    raise exception 'Recurrence rule not found';
  end if;
end;
$$;

revoke all on function update_process_recurrence_rule_authorized(uuid, uuid, text, integer, smallint, smallint, date, date, time) from public, anon;
grant execute on function update_process_recurrence_rule_authorized(uuid, uuid, text, integer, smallint, smallint, date, date, time) to authenticated, service_role;

create or replace function set_process_recurrence_rule_active_authorized(
  p_workspace_id uuid,
  p_recurrence_rule_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_interactive_workspace_capability(p_workspace_id, 'automation.manage');

  update process_recurrence_rules
  set active = p_active, updated_at = now()
  where workspace_id = p_workspace_id and id = p_recurrence_rule_id;

  if not found then
    raise exception 'Recurrence rule not found';
  end if;
end;
$$;

revoke all on function set_process_recurrence_rule_active_authorized(uuid, uuid, boolean) from public, anon;
grant execute on function set_process_recurrence_rule_active_authorized(uuid, uuid, boolean) to authenticated, service_role;

-- 7. System-only process start. Deliberately not the interactive wrapper
-- called with a service-role session -- a dedicated, narrowly granted
-- function, matching resume_due_process_waits_system/dispatch_process_
-- condition_wait_wakeups_system exactly: PUBLIC/anon/authenticated all
-- revoked, so an interactive caller cannot invoke this path at all, not
-- merely fail a capability check inside it. Delegates to the unmodified
-- canonical start_process_run_authorized_member -- there is exactly one
-- process-start implementation.
create or replace function start_process_run_system(
  p_workspace_id uuid,
  p_process_template_id uuid,
  p_origin_entity_type_id uuid,
  p_origin_record_id uuid,
  p_originating_recurrence_occurrence_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
begin
  v_run_id := start_process_run_authorized_member(
    p_workspace_id, p_process_template_id, p_origin_entity_type_id, p_origin_record_id
  );

  update process_runs
  set originating_recurrence_occurrence_id = p_originating_recurrence_occurrence_id
  where workspace_id = p_workspace_id and id = v_run_id;

  return v_run_id;
end;
$$;

revoke all on function start_process_run_system(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function start_process_run_system(uuid, uuid, uuid, uuid, uuid) to service_role;

-- 8. Scheduler-callable batch discovery. Same shape as resume_due_process_
-- waits_system: bounded batch, deterministic order, FOR UPDATE SKIP LOCKED,
-- per-rule exception isolation so one bad rule can't fail the batch.
--
-- "Only the latest due occurrence" comes directly from compute_recurrence_
-- occurrence_date returning at most one row -- older missed occurrences are
-- never computed at all, so they can never be claimed or started, on this
-- pass or any later one. Nothing needs to explicitly mark them "skipped";
-- the math guarantees they're permanently and deterministically excluded
-- once time has moved past them.
--
-- Filters directly implement rule-lifecycle policy: an inactive rule, an
-- archived template, or an archived origin record are excluded by the JOIN/
-- WHERE clause itself -- none of them mutates or deletes the rule row or
-- any occurrence history, they simply stop producing candidates.
create or replace function discover_and_start_recurrence_occurrences_system(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rule record;
  v_now timestamptz := clock_timestamp();
  v_occurrence record;
  v_occurrence_id uuid;
  v_run_id uuid;
  v_started integer := 0;
  v_failed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Recurrence batch limit must be between 1 and 500';
  end if;

  for v_rule in
    select r.*, w.timezone as workspace_timezone
    from process_recurrence_rules r
    join workspaces w on w.id = r.workspace_id
    join process_templates t
      on t.workspace_id = r.workspace_id and t.id = r.process_template_id and t.archived_at is null
    join entity_records er
      on er.workspace_id = r.workspace_id and er.entity_type_id = r.origin_entity_type_id
      and er.id = r.origin_record_id and er.archived_at is null
    where r.active
    order by r.id
    limit p_limit
    for update of r skip locked
  loop
    begin
      select occurrence_date, scheduled_for
        into v_occurrence
      from compute_recurrence_occurrence_date(
        v_rule.frequency, v_rule.interval_count, v_rule.day_of_week, v_rule.day_of_month,
        v_rule.start_date, v_rule.end_date, v_rule.time_of_day, v_rule.workspace_timezone, v_now
      );

      if not found then
        continue;
      end if;

      v_occurrence_id := null;
      insert into process_recurrence_occurrences (
        id, workspace_id, recurrence_rule_id, occurrence_date, scheduled_for, status
      )
      values (
        gen_random_uuid(), v_rule.workspace_id, v_rule.id, v_occurrence.occurrence_date, v_occurrence.scheduled_for, 'failed'
      )
      on conflict (workspace_id, recurrence_rule_id, occurrence_date) do nothing
      returning id into v_occurrence_id;

      if v_occurrence_id is null then
        -- Already claimed by this or a prior invocation.
        continue;
      end if;

      begin
        v_run_id := start_process_run_system(
          v_rule.workspace_id, v_rule.process_template_id, v_rule.origin_entity_type_id, v_rule.origin_record_id,
          v_occurrence_id
        );
        update process_recurrence_occurrences
        set status = 'started', process_run_id = v_run_id
        where workspace_id = v_rule.workspace_id and id = v_occurrence_id;
        v_started := v_started + 1;
      exception when others then
        -- The occurrence row itself (inserted above, outside this nested
        -- block) is not rolled back by this handler -- only stays 'failed'.
        -- Most commonly: the template's prior-period run for this record is
        -- still active. Not retried until the next period, matching this
        -- codebase's existing no-silent-auto-retry posture for process
        -- action failures.
        v_failed := v_failed + 1;
      end;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('started', v_started, 'failed', v_failed);
end;
$$;

revoke all on function discover_and_start_recurrence_occurrences_system(integer) from public, anon, authenticated;
grant execute on function discover_and_start_recurrence_occurrences_system(integer) to service_role;
