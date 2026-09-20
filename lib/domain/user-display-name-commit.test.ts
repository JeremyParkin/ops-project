import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0145_user_display_name.sql"),
  "utf8",
);

function functionBody(name: string) {
  const start = migrationSql.indexOf(`create function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = migrationSql.indexOf("as $$", start);
  const bodyEnd = migrationSql.indexOf("\n$$;", bodyStart);
  expect(bodyStart).toBeGreaterThanOrEqual(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return migrationSql.slice(bodyStart, bodyEnd);
}

describe("user display name migration contract", () => {
  it("adds nullable display_name to user_preferences without uniqueness or backfill", () => {
    expect(migrationSql).toContain("add column display_name text");
    expect(migrationSql).toContain("char_length(display_name) <= 120");
    expect(migrationSql).not.toMatch(/unique\s*\([^)]*display_name/i);
    expect(migrationSql).not.toMatch(/raw_user_meta_data|user_metadata|app_metadata/i);
    expect(migrationSql).not.toMatch(/split_part\([^)]*email/i);
  });

  it("normalizes display name through the owner-only preferences RPC", () => {
    const body = functionBody("update_user_preferences_authorized");
    expect(migrationSql).toContain("p_display_name text");
    expect(body).toContain("v_display_name text := nullif(btrim(p_display_name), '')");
    expect(body).toContain("char_length(v_display_name) > 120");
    expect(body).toContain("Exit impersonation before changing personal settings");
    expect(body).toContain("display_name = excluded.display_name");
    expect(migrationSql).toContain(
      "revoke all on function update_user_preferences_authorized(text, text, boolean, boolean, text) from public, anon, service_role",
    );
    expect(migrationSql).toContain(
      "grant execute on function update_user_preferences_authorized(text, text, boolean, boolean, text) to authenticated",
    );
  });

  it("extends active member identity projection without adding arbitrary user-id resolution", () => {
    const body = functionBody("list_workspace_member_identities_authorized");
    expect(migrationSql).toContain("returns table (\n  user_id uuid,\n  email text,\n  display_name text");
    expect(body).toContain("if not private.is_workspace_member(p_workspace_id)");
    expect(body).toContain("membership.deactivated_at is null");
    expect(body).toContain("left join public.user_preferences preferences");
    expect(body).toContain("preferences.display_name");
    expect(migrationSql).not.toMatch(/p_user_ids|p_user_id uuid/i);
  });

  it("keeps inactive Workspace Member identity resolution record-scoped", () => {
    const body = functionBody("list_workspace_member_values_for_records_authorized");
    expect(migrationSql).toContain("drop function if exists list_workspace_member_values_for_records_authorized(uuid, uuid, uuid[])");
    expect(migrationSql).toContain("display_name text,\n  deactivated_at timestamptz");
    expect(body).toContain("value.source_record_id = any(p_record_ids)");
    expect(body).toContain("private.can_view_people_sensitive_record");
    expect(body).toContain("left join user_preferences preferences");
    expect(body).toContain("preferences.display_name");
  });
});
