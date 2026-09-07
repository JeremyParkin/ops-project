// DB/RPC verification for Phase 13.2B1. This deliberately exercises the
// trusted service-role read path only; ordinary clients have no history-table
// grants. The suite covers semantic Field/Choice events, no-op presentation
// changes, append-only protection, isolation, and teardown.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

const workspaces: string[] = [];
const users: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  for (const workspaceId of workspaces) {
    const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
    if (error) throw new Error(error.message);
  }
  for (const userId of users) await admin.auth.admin.deleteUser(userId);
}, 30_000);

async function createBuilder(workspaceId: string): Promise<SupabaseClient> {
  const admin = createSupabaseTestClient();
  const password = `Governance-${randomUUID()}!`;
  const email = `e2e-governance-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user");
  users.push(data.user.id);
  const roleId = randomUUID();
  if ((await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: `Schema role ${roleId.slice(0, 8)}` })).error) {
    throw new Error("Unable to create test role");
  }
  if ((await admin.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability: "schema.manage" })).error) {
    throw new Error("Unable to grant schema capability");
  }
  if ((await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: data.user.id, role_id: roleId })).error) {
    throw new Error("Unable to create test membership");
  }
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(signIn.error.message);
  return client;
}

describe("governance_audit_events: Field and Choice semantics", () => {
  it("captures semantic configuration changes and preserves history", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = randomUUID();
    workspaces.push(workspaceId);
    expect((await admin.from("workspaces").insert({ id: workspaceId, name: `Governance ${workspaceId.slice(0, 8)}` })).error).toBeNull();
    const builder = await createBuilder(workspaceId);
    const entityTypeId = randomUUID();
    expect((await admin.from("entity_types").insert({ id: entityTypeId, workspace_id: workspaceId, name: "Tasks", slug: `tasks-${entityTypeId.slice(0, 8)}` })).error).toBeNull();

    const { data: fieldId, error: fieldError } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Title", p_slug: "title",
      p_key: "title", p_type: "text", p_required: false, p_related_entity_type_id: null,
    });
    expect(fieldError).toBeNull();
    expect((await builder.rpc("update_field_definition", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: fieldId,
      p_name: "Task title", p_slug: "task-title", p_required: true,
    })).error).toBeNull();
    expect((await builder.rpc("archive_field_definition_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: fieldId,
    })).error).toBeNull();
    expect((await builder.rpc("restore_field_definition_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: fieldId,
    })).error).toBeNull();

    const { data: choiceFieldId, error: choiceFieldError } = await builder.rpc("add_field_definition", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_name: "Status", p_slug: "status",
      p_key: "status", p_type: "choice", p_required: false, p_related_entity_type_id: null,
    });
    expect(choiceFieldError).toBeNull();
    const { data: firstOption } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId, p_label: "Open", p_color: "gray",
    });
    const { data: secondOption } = await builder.rpc("add_field_choice_option", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId, p_label: "Closed", p_color: "blue",
    });
    expect((await builder.rpc("update_field_choice_option", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId, p_option_id: firstOption,
      p_label: "In progress", p_color: "gray",
    })).error).toBeNull();
    const beforePresentationOnly = await admin.from("governance_audit_events").select("id").eq("workspace_id", workspaceId);
    expect(beforePresentationOnly.error).toBeNull();
    expect((await builder.rpc("update_field_choice_option", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId, p_option_id: firstOption,
      p_label: "In progress", p_color: "red",
    })).error).toBeNull();
    expect((await builder.rpc("swap_field_choice_option_positions", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId,
      p_first_option_id: firstOption, p_second_option_id: secondOption,
    })).error).toBeNull();
    const afterPresentationOnly = await admin.from("governance_audit_events").select("id").eq("workspace_id", workspaceId);
    expect(afterPresentationOnly.data).toHaveLength(beforePresentationOnly.data?.length ?? 0);
    expect((await builder.rpc("archive_field_choice_option", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId, p_option_id: firstOption,
    })).error).toBeNull();
    expect((await builder.rpc("restore_field_choice_option", {
      p_workspace_id: workspaceId, p_field_definition_id: choiceFieldId, p_option_id: firstOption,
    })).error).toBeNull();

    const { data: events, error: eventError } = await admin.from("governance_audit_events")
      .select("event_type, subject_id, subject_name_snapshot, parent_entity_type_id, parent_entity_type_name_snapshot, changes")
      .eq("workspace_id", workspaceId).order("created_at", { ascending: true });
    expect(eventError).toBeNull();
    expect(events?.map((event) => event.event_type)).toEqual([
      "field_created", "field_updated", "field_archived", "field_restored",
      "field_created", "choice_option_created", "choice_option_created",
      "choice_option_updated", "choice_option_archived", "choice_option_restored",
    ]);
    expect(events?.[1].changes).toEqual({ old: { name: "Title", required: false }, new: { name: "Task title", required: true } });
    expect(events?.[7].changes).toEqual({ old: { label: "Open" }, new: { label: "In progress" } });
    expect(events?.every((event) => event.parent_entity_type_id === entityTypeId && event.parent_entity_type_name_snapshot === "Tasks")).toBe(true);

    const { error: directUpdateError } = await admin.from("governance_audit_events").update({ subject_name_snapshot: "spoof" }).eq("workspace_id", workspaceId);
    expect(directUpdateError?.message).toMatch(/append-only/i);
    const { error: directDeleteError } = await admin.from("governance_audit_events").delete().eq("workspace_id", workspaceId);
    expect(directDeleteError?.message).toMatch(/append-only/i);

    const { data: deleted } = await builder.rpc("delete_field_definition_if_safe_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: fieldId,
    });
    expect(deleted?.[0]?.deleted).toBe(true);
    const { data: retained } = await admin.from("governance_audit_events").select("subject_id, subject_name_snapshot").eq("workspace_id", workspaceId).eq("subject_id", fieldId);
    expect(retained).toHaveLength(5);
  });
});
