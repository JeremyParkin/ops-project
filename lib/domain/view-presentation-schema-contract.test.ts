import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0152_saved_view_presentation_modes.sql"),
  "utf8",
);

describe("Saved View presentation migration contract", () => {
  it("adds separate presentation mode and typed config columns", () => {
    expect(migration).toContain("add column if not exists presentation_mode text not null default 'table'");
    expect(migration).toContain("add column if not exists presentation_config jsonb not null default '{}'::jsonb");
    expect(migration).toContain("check (presentation_mode in ('table', 'board', 'calendar'))");
  });

  it("adds mode-aware create/update RPC overloads without reopening raw writes", () => {
    expect(migration).toContain("create function create_entity_view_authorized(");
    expect(migration).toContain("p_presentation_mode text");
    expect(migration).toContain("p_presentation_config jsonb");
    expect(migration).toContain("private.require_effective_interactive_workspace_capability(p_workspace_id, 'records.operate')");
    expect(migration).toContain("revoke all on function create_entity_view_authorized(uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb) from public");
    expect(migration).toContain("revoke all on function update_entity_view_authorized(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text, jsonb) from public");
  });

  it("authoritatively validates exact board/calendar field references", () => {
    expect(migration).toContain("Board presentation must reference one Choice field.");
    expect(migration).toContain("v_field.type <> 'choice'");
    expect(migration).toContain("Calendar presentation must reference one Date field.");
    expect(migration).toContain("v_field.type <> 'date'");
    expect(migration).toContain("archived_at is null");
  });

  it("counts presentation config as a Saved View field dependency", () => {
    expect(migration).toContain("view.presentation_mode = 'board'");
    expect(migration).toContain("view.presentation_config ->> 'choiceFieldDefinitionId' = p_field_definition_id::text");
    expect(migration).toContain("view.presentation_mode = 'calendar'");
    expect(migration).toContain("view.presentation_config ->> 'dateFieldDefinitionId' = p_field_definition_id::text");
  });
});
