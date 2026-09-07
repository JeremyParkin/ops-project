// Live DB/RPC verification for Phase 13.2B2. This suite covers both legacy
// EntityType creation contracts plus the normalized update/lifecycle paths.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

const workspaces: string[] = [];
const users: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  for (const workspaceId of workspaces) await admin.from("workspaces").delete().eq("id", workspaceId);
  for (const userId of users) await admin.auth.admin.deleteUser(userId);
}, 30_000);

async function memberClient(workspaceId: string, capabilities: string[]): Promise<SupabaseClient> {
  const admin = createSupabaseTestClient();
  const password = `EntityGovernance-${randomUUID()}!`;
  const email = `e2e-entity-governance-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user");
  users.push(data.user.id);
  const roleId = randomUUID();
  if ((await admin.from("workspace_roles").insert({ id: roleId, workspace_id: workspaceId, name: `Role ${roleId.slice(0, 8)}` })).error) throw new Error("Unable to create role");
  for (const capability of capabilities) {
    if ((await admin.from("workspace_role_capabilities").insert({ workspace_id: workspaceId, role_id: roleId, capability })).error) throw new Error("Unable to grant capability");
  }
  if ((await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: data.user.id, role_id: roleId })).error) throw new Error("Unable to create membership");
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(signIn.error.message);
  return client;
}

async function workspace(name: string) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  workspaces.push(id);
  const { error } = await admin.from("workspaces").insert({ id, name });
  if (error) throw new Error(error.message);
  return id;
}

async function events(workspaceId: string) {
  const admin = createSupabaseTestClient();
  const result = await admin.from("governance_audit_events")
    .select("event_type, subject_kind, subject_id, subject_name_snapshot, parent_field_id, parent_entity_type_id, parent_entity_type_name_snapshot, changes")
    .eq("workspace_id", workspaceId).order("created_at", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

describe("EntityType governance audit", () => {
  it("captures direct metadata updates once and keeps slug and authority boundaries narrow", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = await workspace("Entity governance direct metadata");
    const builder = await memberClient(workspaceId, ["schema.manage"]);
    const created = await builder.rpc("create_entity_type_with_fields", {
      p_workspace_id: workspaceId,
      p_entity_name: "Direct Metadata",
      p_entity_slug: `direct-metadata-${randomUUID().slice(0, 8)}`,
      p_entity_description: "Initial description",
      p_fields: [
        { key: "name", name: "Name", slug: "name", type: "text", position: 1 },
        { key: "summary", name: "Summary", slug: "summary", type: "text", position: 2 },
      ],
    });
    expect(created.error).toBeNull();
    const entityTypeId = created.data as string;
    const fields = await admin.from("field_definitions").select("id, name").eq("entity_type_id", entityTypeId).order("position");
    expect(fields.data).toHaveLength(2);
    const nameFieldId = fields.data?.[0]?.id as string;
    const summaryFieldId = fields.data?.[1]?.id as string;
    const baseline = (await events(workspaceId)).length;

    const directName = await builder.from("entity_types").update({ name: "Directly Renamed" }).eq("id", entityTypeId).select("id");
    expect(directName.error).toBeNull();
    expect((await events(workspaceId)).filter((event) => event.event_type === "entity_type_updated")).toHaveLength(1);
    expect((await events(workspaceId)).at(-1)?.changes).toEqual({ name: { old: "Direct Metadata", new: "Directly Renamed" } });

    const directDescription = await builder.from("entity_types").update({ description: "Directly described" }).eq("id", entityTypeId).select("id");
    expect(directDescription.error).toBeNull();
    expect((await events(workspaceId)).at(-1)?.changes).toEqual({ description: { old: "Initial description", new: "Directly described" } });

    const directDisplay = await builder.from("entity_types").update({ display_field_definition_id: summaryFieldId }).eq("id", entityTypeId).select("id");
    expect(directDisplay.error).toBeNull();
    expect((await events(workspaceId)).at(-1)?.changes).toEqual({ display_field: { old: { id: nameFieldId, name: "Name" }, new: { id: summaryFieldId, name: "Summary" } } });

    const grouped = await builder.from("entity_types").update({ name: "Grouped Name", description: "Grouped description", display_field_definition_id: nameFieldId }).eq("id", entityTypeId).select("id");
    expect(grouped.error).toBeNull();
    const groupedEvents = (await events(workspaceId)).filter((event) => event.event_type === "entity_type_updated");
    expect(groupedEvents).toHaveLength(4);
    expect(groupedEvents.at(-1)?.changes).toEqual({
      name: { old: "Directly Renamed", new: "Grouped Name" },
      description: { old: "Directly described", new: "Grouped description" },
      display_field: { old: { id: summaryFieldId, name: "Summary" }, new: { id: nameFieldId, name: "Name" } },
    });

    const noOp = await builder.from("entity_types").update({ name: "Grouped Name", description: "Grouped description", display_field_definition_id: nameFieldId }).eq("id", entityTypeId).select("id");
    expect(noOp.error).toBeNull();
    expect((await events(workspaceId)).filter((event) => event.event_type === "entity_type_updated")).toHaveLength(4);
    const timestampOnly = await builder.from("entity_types").update({ updated_at: new Date().toISOString() }).eq("id", entityTypeId).select("id");
    expect(timestampOnly.error).toBeNull();
    expect((await events(workspaceId)).filter((event) => event.event_type === "entity_type_updated")).toHaveLength(4);

    const rawSlug = await builder.from("entity_types").update({ slug: "raw-slug-attempt" }).eq("id", entityTypeId).select("id");
    expect(rawSlug.error).not.toBeNull();
    expect((await events(workspaceId)).filter((event) => event.event_type === "entity_type_updated")).toHaveLength(4);

    const rpcUpdate = await builder.rpc("update_entity_type_metadata_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_entity_name: "RPC Name",
      p_entity_slug: `rpc-name-${entityTypeId.slice(0, 8)}`, p_entity_description: "RPC description",
      p_display_field_definition_id: summaryFieldId,
    });
    expect(rpcUpdate.error).toBeNull();
    const finalUpdates = (await events(workspaceId)).filter((event) => event.event_type === "entity_type_updated");
    expect(finalUpdates).toHaveLength(5);
    expect(finalUpdates.at(-1)?.changes).toEqual({
      name: { old: "Grouped Name", new: "RPC Name" },
      description: { old: "Grouped description", new: "RPC description" },
      display_field: { old: { id: nameFieldId, name: "Name" }, new: { id: summaryFieldId, name: "Summary" } },
    });

    const viewer = await memberClient(workspaceId, []);
    const denied = await viewer.from("entity_types").update({ description: "Denied" }).eq("id", entityTypeId).select("id");
    expect(denied.error).toBeNull();
    expect(denied.data).toHaveLength(0);
    expect((await events(workspaceId)).length).toBe(baseline + 5);
  }, 30_000);

  it("audits normal compound creation, grouped metadata, lifecycle, safe delete, and authority", async () => {
    const admin = createSupabaseTestClient();
    const workspaceId = await workspace("Entity governance normal");
    const builder = await memberClient(workspaceId, ["schema.manage"]);
    const entityTypeId = randomUUID();

    const created = await builder.rpc("create_entity_type_with_fields", {
      p_workspace_id: workspaceId,
      p_entity_name: "Projects",
      p_entity_slug: `projects-${entityTypeId.slice(0, 8)}`,
      p_entity_description: "Active work",
      p_fields: [
        { key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1 },
        { key: "budget", name: "Budget", slug: "budget", type: "number", required: false, position: 2 },
        { key: "summary", name: "Summary", slug: "summary", type: "text", required: false, position: 3 },
      ],
    });
    expect(created.error).toBeNull();
    const createdId = created.data as string;
    const fieldResult = await admin.from("field_definitions").select("id, name").eq("entity_type_id", createdId).order("position");
    expect(fieldResult.data).toHaveLength(3);

    const initial = await events(workspaceId);
    expect(initial.filter((event) => event.event_type === "field_created")).toHaveLength(3);
    expect(initial.filter((event) => event.event_type === "entity_type_created")).toHaveLength(1);
    expect(initial.filter((event) => event.subject_kind === "entity_type")).toHaveLength(1);
    expect(initial.filter((event) => event.subject_kind === "field")).toHaveLength(3);
    expect(initial.find((event) => event.event_type === "entity_type_created")?.parent_entity_type_id).toBeNull();
    expect(initial.find((event) => event.event_type === "entity_type_created")?.changes).toEqual({
      new: { name: "Projects", description: "Active work", display_field_definition_id: fieldResult.data?.[0]?.id, display_field_name: "Name" },
    });

    const displayFieldId = fieldResult.data?.[0]?.id as string;
    const newDisplayFieldId = fieldResult.data?.[2]?.id as string;
    const update = await builder.rpc("update_entity_type_metadata_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: createdId, p_entity_name: "Initiatives",
      p_entity_slug: `initiatives-${createdId.slice(0, 8)}`, p_entity_description: "Strategic work",
      p_display_field_definition_id: newDisplayFieldId,
    });
    expect(update.error).toBeNull();
    expect((await builder.rpc("update_entity_type_metadata_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: createdId, p_entity_name: "Initiatives",
      p_entity_slug: `initiatives-${createdId.slice(0, 8)}`, p_entity_description: "Strategic work",
      p_display_field_definition_id: newDisplayFieldId,
    })).error).toBeNull();
    const afterUpdate = await events(workspaceId);
    const updates = afterUpdate.filter((event) => event.event_type === "entity_type_updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].changes).toEqual({
      name: { old: "Projects", new: "Initiatives" },
      description: { old: "Active work", new: "Strategic work" },
      display_field: { old: { id: displayFieldId, name: "Name" }, new: { id: newDisplayFieldId, name: "Summary" } },
    });

    expect((await builder.rpc("archive_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: createdId })).error).toBeNull();
    expect((await builder.rpc("archive_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: createdId })).error).toBeNull();
    expect((await builder.rpc("restore_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: createdId })).error).toBeNull();
    expect((await builder.rpc("restore_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: createdId })).error).toBeNull();
    const lifecycle = await events(workspaceId);
    const lifecycleTypes = lifecycle.filter((event) => event.subject_kind === "entity_type").map((event) => event.event_type);
    expect(lifecycleTypes).toHaveLength(4);
    for (const eventType of ["entity_type_created", "entity_type_updated", "entity_type_archived", "entity_type_restored"]) {
      expect(lifecycleTypes).toContain(eventType);
    }

    const rejected = await builder.rpc("create_entity_type_with_fields", {
      p_workspace_id: workspaceId, p_entity_name: "Rejected", p_entity_slug: `rejected-${randomUUID().slice(0, 8)}`,
      p_entity_description: null, p_fields: [{ key: "ok", name: "OK", slug: "ok", type: "text", position: 1 }, { key: "bad", name: "Bad", slug: "bad", type: "unsupported", position: 2 }],
    });
    expect(rejected.error).not.toBeNull();
    expect((await admin.from("entity_types").select("id").eq("workspace_id", workspaceId).eq("name", "Rejected")).data).toHaveLength(0);
    expect((await events(workspaceId)).filter((event) => event.subject_name_snapshot === "Rejected")).toHaveLength(0);

    const viewer = await memberClient(workspaceId, []);
    const denied = await viewer.rpc("archive_entity_type_authorized", { p_workspace_id: workspaceId, p_entity_type_id: createdId });
    expect(denied.error).not.toBeNull();
    expect((await events(workspaceId)).length).toBe(lifecycle.length);

    const deleted = await builder.rpc("delete_entity_type_if_safe_authorized", { p_workspace_id: workspaceId, p_entity_type_id: createdId });
    expect(deleted.error).toBeNull();
    expect(deleted.data?.[0]?.deleted).toBe(true);
    const finalEvents = await events(workspaceId);
    expect(finalEvents.filter((event) => event.subject_kind === "entity_type").map((event) => event.event_type)).toContain("entity_type_deleted");
    expect(finalEvents.some((event) => event.event_type === "field_deleted")).toBe(false);
    expect((await admin.from("entity_types").select("id").eq("id", createdId)).data).toHaveLength(0);

    expect((await events(workspaceId)).length).toBe(finalEvents.length);
  }, 30_000);

  it("audits onboarding EntityTypes and Fields atomically without changing its contract", async () => {
    const workspaceId = await workspace("Entity governance onboarding");
    const builder = await memberClient(workspaceId, ["schema.manage"]);
    const result = await builder.rpc("create_entity_types_with_fields_authorized", {
      p_workspace_id: workspaceId,
      p_entities: [
        { local_id: "project", name: "Project", slug: `project-${randomUUID().slice(0, 8)}`, fields: [{ key: "name", name: "Name", slug: "name", type: "text", required: true, position: 1 }] },
        { local_id: "task", name: "Task", slug: `task-${randomUUID().slice(0, 8)}`, fields: [{ key: "title", name: "Title", slug: "title", type: "text", required: true, position: 1 }, { key: "project", name: "Project", slug: "project", type: "relation", related_local_id: "project", position: 2 }] },
      ],
    });
    expect(result.error).toBeNull();
    expect(Object.keys(result.data ?? {}).sort()).toEqual(["project", "task"]);
    const audited = await events(workspaceId);
    expect(audited.filter((event) => event.event_type === "entity_type_created")).toHaveLength(2);
    expect(audited.filter((event) => event.event_type === "field_created")).toHaveLength(3);
    expect(audited.every((event) => event.subject_kind === "entity_type" || event.subject_kind === "field")).toBe(true);
  });
});
