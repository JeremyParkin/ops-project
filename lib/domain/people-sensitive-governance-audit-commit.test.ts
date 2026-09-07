// DB/RPC verification for Phase 13.2C1. The suite is intentionally narrow:
// it verifies the specialized configuration boundary and its bounded audit
// event without entering Person identity-link or Quality Review governance.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

const workspaceIds: string[] = [];
const userIds: string[] = [];

async function createBuilder(workspaceId: string): Promise<SupabaseClient> {
  const admin = createSupabaseTestClient();
  const password = `PeopleGovernance-${randomUUID()}!`;
  const email = `e2e-people-governance-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user");
  userIds.push(data.user.id);

  const roleId = randomUUID();
  for (const [table, row] of [
    ["workspace_roles", { id: roleId, workspace_id: workspaceId, name: `Schema role ${roleId.slice(0, 8)}` }],
    ["workspace_role_capabilities", { workspace_id: workspaceId, role_id: roleId, capability: "schema.manage" }],
    ["workspace_memberships", { workspace_id: workspaceId, user_id: data.user.id, role_id: roleId }],
  ] as const) {
    const result = await admin.from(table).insert(row);
    if (result.error) throw new Error(result.error.message);
  }

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(signIn.error.message);
  return client;
}

async function insertEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("entity_types").insert({
    id, workspace_id: workspaceId, name, slug: `${name.toLowerCase()}-${id.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  return id;
}

async function insertRelationField(workspaceId: string, entityTypeId: string, name: string, relatedEntityTypeId: string, position: number) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("field_definitions").insert({
    id, workspace_id: workspaceId, entity_type_id: entityTypeId,
    key: `${name.toLowerCase()}_${id.slice(0, 8)}`, name, slug: name.toLowerCase(),
    type: "relation", related_entity_type_id: relatedEntityTypeId, required: false, position,
  });
  if (error) throw new Error(error.message);
  return id;
}

describe("people-sensitive access governance", () => {
  afterAll(async () => {
    const admin = createSupabaseTestClient();
    for (const workspaceId of workspaceIds) {
      const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
      if (error) throw new Error(error.message);
    }
    for (const userId of userIds) await admin.auth.admin.deleteUser(userId);
  }, 30_000);

  it("captures grouped bounded configuration changes and suppresses no-ops", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    expect((await admin.from("workspaces").insert({ id: workspaceId, name: "People governance" })).error).toBeNull();
    const builder = await createBuilder(workspaceId);
    const personTypeId = await insertEntityType(workspaceId, "Person");
    const reviewTypeId = await insertEntityType(workspaceId, "Reviews");
    const subjectFieldId = await insertRelationField(workspaceId, reviewTypeId, "Subject", personTypeId, 1);
    const authorFieldId = await insertRelationField(workspaceId, reviewTypeId, "Author", personTypeId, 2);
    expect((await admin.from("workspaces").update({ person_entity_type_id: personTypeId }).eq("id", workspaceId)).error).toBeNull();

    const configure = (values: Record<string, unknown>) => builder.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewTypeId, ...values,
    });
    expect((await configure({
      p_people_sensitive: true, p_subject_person_field_id: subjectFieldId,
      p_author_person_field_id: authorFieldId, p_subject_can_view: true,
      p_manager_can_view: true, p_author_can_view: true,
    })).error).toBeNull();

    const first = await admin.from("governance_audit_events")
      .select("event_type, subject_kind, subject_id, subject_name_snapshot, parent_entity_type_id, parent_field_id, changes")
      .eq("workspace_id", workspaceId).eq("event_type", "people_sensitive_access_configured").single();
    expect(first.error).toBeNull();
    expect(first.data?.subject_kind).toBe("entity_type");
    expect(first.data?.subject_id).toBe(reviewTypeId);
    expect(first.data?.parent_entity_type_id).toBeNull();
    expect(first.data?.parent_field_id).toBeNull();
    expect(first.data?.changes).toEqual(expect.objectContaining({
      old: expect.objectContaining({ people_sensitive: false }),
      new: expect.objectContaining({
        people_sensitive: true,
        subject_can_view: true,
        manager_can_view: true,
        author_can_view: true,
      }),
    }));

    expect((await configure({
      p_people_sensitive: true, p_subject_person_field_id: subjectFieldId,
      p_author_person_field_id: authorFieldId, p_subject_can_view: false,
      p_manager_can_view: true, p_author_can_view: false,
    })).error).toBeNull();
    expect((await configure({
      p_people_sensitive: true, p_subject_person_field_id: subjectFieldId,
      p_author_person_field_id: authorFieldId, p_subject_can_view: false,
      p_manager_can_view: true, p_author_can_view: false,
    })).error).toBeNull();

    const events = await admin.from("governance_audit_events")
      .select("event_type, changes").eq("workspace_id", workspaceId)
      .eq("event_type", "people_sensitive_access_configured").order("created_at", { ascending: true });
    expect(events.error).toBeNull();
    expect(events.data).toHaveLength(2);
    expect(events.data?.[1].changes).toEqual(expect.objectContaining({
      old: expect.objectContaining({ subject_can_view: true, author_can_view: true }),
      new: expect.objectContaining({ subject_can_view: false, author_can_view: false }),
    }));
  });
});
