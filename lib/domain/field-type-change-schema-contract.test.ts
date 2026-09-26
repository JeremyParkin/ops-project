import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/0154_field_type_change_typed_dependencies.sql",
  ),
  "utf8",
);

describe("field type-change typed dependency contract", () => {
  it("adds v2 RPCs while preserving the legacy RPC names for migration", () => {
    expect(migrationSql).toContain(
      "create function get_field_definition_type_change_preflight_v2_authorized",
    );
    expect(migrationSql).toContain(
      "create function change_field_definition_type_if_safe_v2_authorized",
    );
    expect(migrationSql).not.toContain(
      "drop function get_field_definition_type_change_preflight_authorized",
    );
    expect(migrationSql).not.toContain(
      "drop function change_field_definition_type_if_safe_authorized",
    );
  });

  it("reports typed saved-view references and keeps columns non-blocking", () => {
    expect(migrationSql).toContain("view_column_reference_count bigint");
    expect(migrationSql).toContain("view_filter_reference_count bigint");
    expect(migrationSql).toContain("view_sort_reference_count bigint");
    expect(migrationSql).toContain("view_board_presentation_reference_count bigint");
    expect(migrationSql).toContain("view_calendar_presentation_reference_count bigint");
    expect(migrationSql).toContain("view.presentation_config ->> 'choiceFieldDefinitionId'");
    expect(migrationSql).toContain("view.presentation_config ->> 'dateFieldDefinitionId'");
    expect(migrationSql).toContain("and view_filter_reference_count = 0");
    expect(migrationSql).toContain("and view_sort_reference_count = 0");
    expect(migrationSql).toContain("and view_board_presentation_reference_count = 0");
    expect(migrationSql).toContain("and view_calendar_presentation_reference_count = 0");
    expect(migrationSql).not.toMatch(/and view_column_reference_count = 0/);
  });

  it("surfaces Work Settings mappings as named blockers", () => {
    expect(migrationSql).toContain("work_settings_assignment_reference_count bigint");
    expect(migrationSql).toContain("work_settings_due_reference_count bigint");
    expect(migrationSql).toContain("work_settings_status_reference_count bigint");
    expect(migrationSql).toContain("work_assignment_field_id = p_field_definition_id");
    expect(migrationSql).toContain("work_due_field_id = p_field_definition_id");
    expect(migrationSql).toContain("work_status_field_id = p_field_definition_id");
    expect(migrationSql).toContain("and work_settings_assignment_reference_count = 0");
    expect(migrationSql).toContain("and work_settings_due_reference_count = 0");
    expect(migrationSql).toContain("and work_settings_status_reference_count = 0");
  });

  it("keeps the authoritative lock and re-check shape on mutation", () => {
    const mutationStart = migrationSql.indexOf(
      "create function change_field_definition_type_if_safe_v2_authorized",
    );
    expect(mutationStart).toBeGreaterThan(-1);
    const mutationBody = migrationSql.slice(mutationStart);

    expect(mutationBody).toContain(
      "pg_advisory_xact_lock(hashtextextended(p_entity_type_id::text, 0))",
    );
    expect(mutationBody).toContain("for update");
    expect(mutationBody).toContain(
      "from private.field_definition_type_change_dependencies_typed",
    );
    expect(mutationBody).toContain("if d.pristine then");
  });
});
