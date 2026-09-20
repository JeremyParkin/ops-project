import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0143_workspace_member_fields.sql"),
  "utf8",
);
const assignmentLockMigrationSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0144_workspace_member_assignment_deactivation_lock.sql"),
  "utf8",
);

function functionBody(name: string, signatureFragment: string) {
  let start = migrationSql.indexOf(`create or replace function ${name}(\n${signatureFragment}`);
  if (start < 0) {
    start = migrationSql.indexOf(`create function ${name}(\n${signatureFragment}`);
  }
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = migrationSql.indexOf("as $$", start);
  const bodyEnd = migrationSql.indexOf("\n$$;", bodyStart);
  expect(bodyStart).toBeGreaterThanOrEqual(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return migrationSql.slice(bodyStart, bodyEnd);
}

function firstFunctionBody(name: string) {
  let start = migrationSql.indexOf(`create or replace function ${name}(`);
  if (start < 0) {
    start = migrationSql.indexOf(`create function ${name}(`);
  }
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = migrationSql.indexOf("as $$", start);
  const bodyEnd = migrationSql.indexOf("\n$$;", bodyStart);
  expect(bodyStart).toBeGreaterThanOrEqual(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return migrationSql.slice(bodyStart, bodyEnd);
}

describe("Workspace Member field migration contract", () => {
  it("stores normalized values without silently cascading field deletes or exposing raw table grants", () => {
    expect(migrationSql).toContain("create table entity_record_workspace_member_values");
    expect(migrationSql).toMatch(
      /foreign key \(\s*workspace_id,\s*source_entity_type_id,\s*field_definition_id,\s*field_type\s*\)\s*references field_definitions\(workspace_id, entity_type_id, id, type\)\s*on delete no action\s*on update cascade/i,
    );
    expect(migrationSql).toContain("references entity_records(workspace_id, entity_type_id, id)");
    expect(migrationSql).toContain("on delete cascade");
    expect(migrationSql).toContain("alter table entity_record_workspace_member_values enable row level security");
    expect(migrationSql).toContain("revoke all on table entity_record_workspace_member_values from public, anon, authenticated");
    expect(migrationSql).not.toMatch(/grant\s+select\s+on\s+table\s+entity_record_workspace_member_values/i);
  });

  it("keeps legacy and member-aware create RPC overloads distinct without recursive public create calls", () => {
    const interactiveCreate = functionBody(
      "create_entity_record_with_relations_authorized",
      "  p_workspace_id uuid,\n  p_entity_type_id uuid,\n  p_values jsonb,\n  p_relations jsonb,\n  p_workspace_members jsonb,",
    );
    expect(interactiveCreate).toContain("v_record_id := private.record_create_core(");
    expect(interactiveCreate).not.toContain("public.create_entity_record_with_relations_authorized(");

    const legacyInteractiveCreate = functionBody(
      "create_entity_record_with_relations_authorized",
      "  p_workspace_id uuid,\n  p_entity_type_id uuid,\n  p_values jsonb,\n  p_relations jsonb,\n  p_originating_process_step_run_id uuid default null",
    );
    expect(legacyInteractiveCreate).toContain("'[]'::jsonb");
    expect(legacyInteractiveCreate).toContain("p_originating_process_step_run_id");

    const automationCreate = functionBody(
      "create_entity_record_with_relations_automation_system",
      "  p_workspace_id uuid,\n  p_entity_type_id uuid,\n  p_values jsonb,\n  p_relations jsonb,\n  p_workspace_members jsonb,",
    );
    expect(automationCreate).toContain("perform private.assert_automation_cause(");
    expect(automationCreate).toContain("v_record_id := private.record_create_core(");
    expect(automationCreate).not.toContain("public.create_entity_record_with_relations_automation_system(");

    const processCreate = functionBody(
      "create_entity_record_with_relations_process_system",
      "  p_workspace_id uuid,\n  p_entity_type_id uuid,\n  p_values jsonb,\n  p_relations jsonb,\n  p_workspace_members jsonb,",
    );
    expect(processCreate).toContain("perform private.assert_process_cause(");
    expect(processCreate).toContain("v_record_id := private.record_create_core(");
    expect(processCreate).not.toContain("public.create_entity_record_with_relations_process_system(");
  });

  it("routes all record mutation doors through Workspace Member validation hooks", () => {
    expect(migrationSql.match(/perform private\.apply_workspace_member_record_values\(/g)).toHaveLength(7);
    expect(migrationSql).toContain("create or replace function public.bulk_create_entity_records_authorized");
    expect(migrationSql).toContain("workspace_members");
    expect(migrationSql).toContain("Workspace Member payload included a field outside p_workspace_member_field_ids.");
    expect(migrationSql).toContain("must reference an active workspace member.");
    expect(migrationSql).toContain("is required.");
  });

  it("serializes Workspace Member assignment against membership deactivation", () => {
    expect(assignmentLockMigrationSql).toContain(
      "create or replace function private.apply_workspace_member_record_values",
    );
    expect(assignmentLockMigrationSql).toMatch(
      /select distinct \(member ->> 'member_user_id'\)::uuid\s+from jsonb_array_elements\(p_workspace_members\) member\s+order by \(member ->> 'member_user_id'\)::uuid/i,
    );
    expect(assignmentLockMigrationSql).toMatch(
      /from workspace_memberships\s+where workspace_id = p_workspace_id\s+and user_id = v_locked_member_user_id\s+for update;/i,
    );
    expect(assignmentLockMigrationSql).toContain("must reference an active workspace member.");
  });

  it("counts Workspace Member values in safe delete and field-type recovery dependencies", () => {
    const safeDelete = firstFunctionBody("delete_field_definition_if_safe");
    expect(safeDelete).toContain("from entity_record_workspace_member_values");
    expect(safeDelete).toContain("relation_value_count := relation_value_count + v_workspace_member_value_count");

    const dependencies = functionBody(
      "private.field_definition_type_change_dependencies",
      "  p_workspace_id uuid,\n  p_entity_type_id uuid,\n  p_field_definition_id uuid",
    );
    expect(dependencies).toContain("from entity_record_workspace_member_values");
    expect(dependencies).toContain("relation_value_count := d.relation_value_count + v_workspace_member_value_count");
    expect(dependencies).toContain("pristine := d.pristine and v_workspace_member_value_count = 0");

    const changeType = functionBody(
      "change_field_definition_type_if_safe_authorized",
      "  p_workspace_id uuid,\n  p_entity_type_id uuid,\n  p_field_definition_id uuid,\n  p_new_type text,",
    );
    expect(changeType).toContain("'workspace_member'");
    expect(changeType).toContain("perform pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0))");
    expect(changeType).toContain("perform private.governance_audit_insert(");
  });
});
