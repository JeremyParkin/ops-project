// Static migration-content contract for Record Work / Work Settings v1a.
// Mirrors workspace-member-fields-commit.test.ts's approach: these
// assertions read the migration SQL directly and require no live database,
// so they can and do run before the migrations below are applied. Live
// RPC-behavior coverage (configuration, lifecycle, notifications,
// projection, regression) lives in work-settings-commit.test.ts and is
// deliberately NOT run until Jeremy confirms these migrations are applied.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const schemaSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0146_entity_type_work_settings_schema.sql"),
  "utf8",
);
const rpcSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0147_entity_type_work_settings_rpcs.sql"),
  "utf8",
);
const lifecycleSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0148_work_settings_lifecycle_dependency_safety.sql"),
  "utf8",
);
const notificationSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0149_record_work_assignment_notifications.sql"),
  "utf8",
);
const projectionSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0150_list_assigned_record_work_authorized.sql"),
  "utf8",
);
const fieldArchiveRepairSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0153_field_archive_dependency_repair.sql"),
  "utf8",
);

describe("Work Settings schema contract (0146)", () => {
  it("adds work_enabled/assignment/due/status columns with same-EntityType restrictive FKs", () => {
    expect(schemaSql).toContain("add column if not exists work_enabled boolean not null default false");
    expect(schemaSql).toContain("add column if not exists work_assignment_field_id uuid");
    expect(schemaSql).toContain("add column if not exists work_due_field_id uuid");
    expect(schemaSql).toContain("add column if not exists work_status_field_id uuid");
    for (const fk of [
      "entity_types_work_assignment_field_fk",
      "entity_types_work_due_field_fk",
      "entity_types_work_status_field_fk",
    ]) {
      expect(schemaSql).toContain(fk);
    }
    expect(schemaSql).toMatch(/references field_definitions \(workspace_id, entity_type_id, id\)\s*on delete restrict/g);
    expect(schemaSql).toContain(
      "check (not work_enabled or work_assignment_field_id is not null)",
    );
  });

  it("structurally scopes completion options to the EntityType and the configured status field, no shadow type column", () => {
    expect(schemaSql).toContain("create table entity_type_work_completion_options");
    expect(schemaSql).toMatch(
      /foreign key \(workspace_id, entity_type_id, status_field_id\)\s*references field_definitions \(workspace_id, entity_type_id, id\)\s*on delete restrict/,
    );
    expect(schemaSql).toMatch(
      /foreign key \(workspace_id, status_field_id, option_id\)\s*references field_choice_options \(workspace_id, field_definition_id, id\)\s*on delete restrict/,
    );
    expect(schemaSql).not.toMatch(/field_type text/);
    expect(schemaSql).toContain("alter table entity_type_work_completion_options enable row level security");
    expect(schemaSql).toContain(
      "revoke all on table entity_type_work_completion_options from public, anon, authenticated",
    );
  });
});

describe("Work Settings configuration RPC contract (0147)", () => {
  it("extends governance vocabulary with exactly the two new configuration events", () => {
    expect(rpcSql).toContain("'entity_type_work_mapping_configured', 'entity_type_work_enabled_changed'");
  });

  it("keeps mapping and enable/disable as two separate RPCs, neither touching the other's concern", () => {
    expect(rpcSql).toContain("function set_entity_type_work_mapping_authorized(");
    expect(rpcSql).toContain("function set_entity_type_work_enabled_authorized(");
    const mappingStart = rpcSql.indexOf("function set_entity_type_work_mapping_authorized(");
    const enabledStart = rpcSql.indexOf("function set_entity_type_work_enabled_authorized(");
    const mappingBody = rpcSql.slice(mappingStart, enabledStart);
    expect(mappingBody).not.toContain("work_enabled =");
    expect(rpcSql).not.toContain("p_work_enabled"); // enable/disable RPC takes no mapping params, mapping RPC takes no enabled param
  });

  it("validates field type authoritatively (workspace_member/date/choice) with no shadow type column anywhere", () => {
    expect(rpcSql).toContain("Assignment field must be a Workspace Member field.");
    expect(rpcSql).toContain("Due date field must be a Date field.");
    expect(rpcSql).toContain("Status field must be a Choice field.");
    expect(rpcSql).toContain("Completion options require a configured status field.");
  });

  it("re-validates the preserved mapping before enabling", () => {
    const enabledBody = rpcSql.slice(rpcSql.indexOf("function set_entity_type_work_enabled_authorized("));
    expect(enabledBody).toContain("no longer an active Workspace Member field");
    expect(enabledBody).toContain("no longer an active Date field");
    expect(enabledBody).toContain("no longer an active Choice field");
    expect(enabledBody).toContain("no longer valid for the status field");
  });

  it("uses the standard schema.manage + entity-type advisory-lock convention", () => {
    expect(rpcSql.match(/require_interactive_workspace_capability\(p_workspace_id, 'schema\.manage'\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(rpcSql.match(/pg_advisory_xact_lock\(hashtextextended\(p_entity_type_id::text, 0\)\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Work Settings lifecycle/dependency safety contract (0148)", () => {
  it("initially blocked archival of a field referenced by the Work Settings mapping", () => {
    expect(lifecycleSql).toContain(
      "This field is used by Work Settings and cannot be archived while configured.",
    );
    expect(lifecycleSql).toMatch(
      /work_assignment_field_id = p_field_definition_id\s*or work_due_field_id = p_field_definition_id\s*or work_status_field_id = p_field_definition_id/,
    );
  });

  it("folds Work Settings references into existing buckets for hard-delete and type-change safety, with no return-shape change", () => {
    expect(lifecycleSql).toContain("display_field_reference_count := display_field_reference_count + v_work_settings_reference_count");
    expect(lifecycleSql).toContain("pristine := d.pristine and v_workspace_member_value_count = 0 and v_work_settings_reference_count = 0");
  });

  it("adds a new named work_completion_reference_count column to Choice option hard delete", () => {
    expect(lifecycleSql).toContain("drop function if exists delete_field_choice_option_if_safe(uuid, uuid, uuid)");
    expect(lifecycleSql).toContain("drop function if exists delete_field_choice_option_if_safe_authorized(uuid, uuid, uuid)");
    expect(lifecycleSql).toContain("work_completion_reference_count bigint");
    expect(lifecycleSql).toContain("from entity_type_work_completion_options c");
  });
});

describe("Field archive dependency repair contract (0153)", () => {
  it("adds a typed archive RPC and keeps the legacy archive RPC as a wrapper", () => {
    expect(fieldArchiveRepairSql).toContain("function archive_field_definition_with_dependencies_authorized(");
    expect(fieldArchiveRepairSql).toContain("blocked_reason text");
    expect(fieldArchiveRepairSql).toContain("function archive_field_definition_authorized(");
    expect(fieldArchiveRepairSql).toContain("from archive_field_definition_with_dependencies_authorized(");
  });

  it("blocks enabled assignment archival but permits confirmed optional or dormant Work Settings repair", () => {
    expect(fieldArchiveRepairSql).toContain("blocked_reason := 'work_assignment_enabled'");
    expect(fieldArchiveRepairSql).toContain("blocked_reason := 'work_settings_confirmation_required'");
    expect(fieldArchiveRepairSql).toContain("p_confirm_work_settings_clear");
    expect(fieldArchiveRepairSql).toContain("delete from entity_type_work_completion_options");
    expect(fieldArchiveRepairSql).toContain("cleared_work_assignment := v_work_assignment_ref and not e.work_enabled");
  });

  it("makes display-field protection authoritative and leaves saved-view archive unblocked", () => {
    expect(fieldArchiveRepairSql).toContain("e.display_field_definition_id = p_field_definition_id");
    expect(fieldArchiveRepairSql).not.toContain("entity_views");
  });
});

describe("Record Work notification contract (0149)", () => {
  it("adds exactly record_work_assigned and record_work_reassigned, never record_work_unassigned", () => {
    const checkConstraint = notificationSql.slice(
      notificationSql.indexOf("add constraint notifications_event_type_check"),
      notificationSql.indexOf("));", notificationSql.indexOf("add constraint notifications_event_type_check")),
    );
    expect(checkConstraint).toContain("'record_work_assigned',\n    'record_work_reassigned'");
    expect(checkConstraint).not.toContain("record_work_unassigned");
  });

  it("wires the notification hook into exactly the seven workspace-member-aware write paths", () => {
    expect(notificationSql.match(/perform private\.record_work_notify_if_configured\(/g)).toHaveLength(7);
    expect(notificationSql).toContain("create or replace function public.bulk_create_entity_records_authorized");
  });

  it("only inspects the configured assignment field and confirms active, non-completed work before notifying", () => {
    const hookBody = notificationSql.slice(
      notificationSql.indexOf("create or replace function private.record_work_notify_if_configured"),
      notificationSql.indexOf("revoke all on function private.record_work_notify_if_configured"),
    );
    expect(hookBody).toContain("et.work_assignment_field_id::text");
    expect(hookBody).toContain("if v_new_user_id is null or v_old_user_id is not distinct from v_new_user_id then");
    expect(hookBody).toContain("and archived_at is null");
    expect(hookBody).toContain("entity_type_work_completion_options c");
  });

  it("dedups via a fresh re-query of the persisted value row, not an assignment_generation counter", () => {
    const hookBody = notificationSql.slice(
      notificationSql.indexOf("create or replace function private.record_work_notify_if_configured"),
      notificationSql.indexOf("revoke all on function private.record_work_notify_if_configured"),
    );
    expect(hookBody).toContain("select id into v_value_row_id");
    expect(hookBody).toContain("from entity_record_workspace_member_values");
    expect(hookBody).toContain("'record_work:' || v_value_row_id::text");
    expect(hookBody).toContain("on conflict (workspace_id, dedup_key) do nothing");
    expect(hookBody).not.toContain("assignment_generation");
  });
});

describe("Assigned Records projection contract (0150)", () => {
  it("scopes to the current effective user's configured assignment value on work-enabled EntityTypes", () => {
    expect(projectionSql).toContain("v.member_user_id = v_user_id");
    expect(projectionSql).toContain("et.work_assignment_field_id = v.field_definition_id");
    expect(projectionSql).toContain("et.work_enabled");
    expect(projectionSql).toContain("er.archived_at is null");
  });

  it("re-checks people-sensitive visibility per record -- assignment does not confer visibility", () => {
    expect(projectionSql).toContain(
      "private.can_view_people_sensitive_record(p_workspace_id, et.id, er.id, v_user_id)",
    );
  });

  it("derives overdue from workspace-local calendar date, not UTC or a personal timezone", () => {
    expect(projectionSql).toContain("(now() at time zone w.timezone)::date");
    expect(projectionSql).not.toMatch(/'UTC'/);
  });

  it("excludes records currently in a configured completion state", () => {
    expect(projectionSql).toContain("entity_type_work_completion_options completion");
    expect(projectionSql).toContain("completion.option_id::text = (er.values ->> status_field.key)");
  });
});
