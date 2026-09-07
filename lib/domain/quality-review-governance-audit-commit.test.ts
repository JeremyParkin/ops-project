// DB/RPC verification for Phase 13.2C2. Runtime review events remain in
// workspace_events; this suite covers only configuration governance.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

const workspaceIds: string[] = [];
const userIds: string[] = [];

async function createBuilder(workspaceId: string): Promise<SupabaseClient> {
  const admin = createSupabaseTestClient();
  const password = `QualityGovernance-${randomUUID()}!`;
  const email = `e2e-quality-governance-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user");
  userIds.push(data.user.id);
  const roleId = randomUUID();
  for (const [table, row] of [
    ["workspace_roles", { id: roleId, workspace_id: workspaceId, name: "Schema role" }],
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
  const { error } = await admin.from("entity_types").insert({ id, workspace_id: workspaceId, name, slug: `${name.toLowerCase()}-${id.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  return id;
}

async function insertField(workspaceId: string, entityTypeId: string, name: string, type: string, position: number, relatedEntityTypeId: string | null = null) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("field_definitions").insert({
    id, workspace_id: workspaceId, entity_type_id: entityTypeId,
    key: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${id.slice(0, 8)}`,
    name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 8)}`,
    type, position, required: false, related_entity_type_id: relatedEntityTypeId,
  });
  if (error) throw new Error(error.message);
  return id;
}

async function insertOption(workspaceId: string, fieldDefinitionId: string, label: string, position: number) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("field_choice_options").insert({ id, workspace_id: workspaceId, field_definition_id: fieldDefinitionId, label, color: "gray", position });
  if (error) throw new Error(error.message);
  return id;
}

describe("Quality Review configuration governance", () => {
  afterAll(async () => {
    const admin = createSupabaseTestClient();
    for (const workspaceId of workspaceIds) {
      const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
      if (error) throw new Error(error.message);
    }
    for (const userId of userIds) await admin.auth.admin.deleteUser(userId);
  }, 30_000);

  it("captures lifecycle and presentation configuration once with frozen bounded snapshots", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    expect((await admin.from("workspaces").insert({ id: workspaceId, name: "Quality governance" })).error).toBeNull();
    const builder = await createBuilder(workspaceId);
    const personTypeId = await insertEntityType(workspaceId, "Person");
    const reviewTypeId = await insertEntityType(workspaceId, "Quality Review");
    const subjectFieldId = await insertField(workspaceId, reviewTypeId, "Subject", "relation", 1, personTypeId);
    const authorFieldId = await insertField(workspaceId, reviewTypeId, "Reviewer", "relation", 2, personTypeId);
    const statusFieldId = await insertField(workspaceId, reviewTypeId, "Status", "choice", 3);
    const dateFieldId = await insertField(workspaceId, reviewTypeId, "Review Date", "date", 4);
    const resultFieldId = await insertField(workspaceId, reviewTypeId, "Overall Result", "choice", 5);
    const draftOptionId = await insertOption(workspaceId, statusFieldId, "Draft", 1);
    const finalizedOptionId = await insertOption(workspaceId, statusFieldId, "Finalized", 2);
    await insertOption(workspaceId, resultFieldId, "Pass", 1);
    expect((await admin.from("workspaces").update({ person_entity_type_id: personTypeId }).eq("id", workspaceId)).error).toBeNull();

    const sensitive = await builder.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewTypeId, p_people_sensitive: true,
      p_subject_person_field_id: subjectFieldId, p_author_person_field_id: authorFieldId,
      p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: true,
    });
    expect(sensitive.error).toBeNull();
    expect((await builder.rpc("set_entity_type_quality_review_lifecycle_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewTypeId, p_quality_review: true,
      p_status_field_id: statusFieldId, p_draft_option_id: draftOptionId, p_finalized_option_id: finalizedOptionId,
    })).error).toBeNull();
    expect((await builder.rpc("set_entity_type_quality_review_presentation_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewTypeId,
      p_date_field_id: dateFieldId, p_result_field_id: resultFieldId,
    })).error).toBeNull();

    const configurePresentation = await builder.rpc("set_entity_type_quality_review_presentation_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: reviewTypeId,
      p_date_field_id: dateFieldId, p_result_field_id: resultFieldId,
    });
    expect(configurePresentation.error).toBeNull();

    const events = await admin.from("governance_audit_events")
      .select("event_type, subject_kind, subject_id, parent_entity_type_id, parent_field_id, changes")
      .eq("workspace_id", workspaceId).order("created_at", { ascending: true });
    expect(events.error).toBeNull();
    const qrEvents = (events.data ?? []).filter((event) => event.event_type.startsWith("quality_review_"));
    expect(qrEvents.map((event) => event.event_type)).toEqual([
      "quality_review_lifecycle_configured", "quality_review_presentation_configured",
    ]);
    expect(qrEvents.every((event) => event.subject_kind === "entity_type" && event.subject_id === reviewTypeId && event.parent_entity_type_id === null && event.parent_field_id === null)).toBe(true);
    expect(qrEvents[0].changes).toEqual(expect.objectContaining({
      old: expect.objectContaining({ quality_review: false }),
      new: expect.objectContaining({
        quality_review: true,
        status_field: { id: statusFieldId, name: "Status" },
        draft_option: { id: draftOptionId, label: "Draft" },
        finalized_option: { id: finalizedOptionId, label: "Finalized" },
      }),
    }));
    expect(qrEvents[1].changes).toEqual({
      old: { review_date_field: { id: null, name: null }, overall_result_field: { id: null, name: null } },
      new: {
        review_date_field: { id: dateFieldId, name: "Review Date" },
        overall_result_field: { id: resultFieldId, name: "Overall Result" },
      },
    });

    expect((await admin.from("entity_types").update({ name: "Renamed Review" }).eq("id", reviewTypeId)).error).toBeNull();
    expect((await admin.from("field_definitions").update({ name: "Renamed Status" }).eq("id", statusFieldId)).error).toBeNull();
    expect((await admin.from("field_choice_options").update({ label: "Renamed Draft" }).eq("id", draftOptionId)).error).toBeNull();
    const frozen = await admin.from("governance_audit_events").select("subject_name_snapshot, changes").eq("workspace_id", workspaceId).eq("event_type", "quality_review_lifecycle_configured").single();
    expect(frozen.data?.subject_name_snapshot).toBe("Quality Review");
    expect(frozen.data?.changes).toEqual(qrEvents[0].changes);
  });
});
