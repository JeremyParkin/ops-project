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
    await admin.from("workspaces").delete().eq("id", workspaceId);
  }
  for (const userId of users) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  workspaces.push(id);
  const { error } = await admin.from("workspaces").insert({ id, name });
  if (error) throw new Error(error.message);
  return id;
}

async function memberClient(workspaceId: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const password = `CreateObjectChoice-${randomUUID()}!`;
  const email = `e2e-create-object-choice-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(error?.message ?? "Unable to create test user");
  }
  users.push(data.user.id);

  const roleId = randomUUID();
  const roleResult = await admin
    .from("workspace_roles")
    .insert({ id: roleId, workspace_id: workspaceId, name: `Role ${roleId.slice(0, 8)}` });
  if (roleResult.error) throw new Error(roleResult.error.message);

  if (capabilities.length > 0) {
    const capabilityResult = await admin.from("workspace_role_capabilities").insert(
      capabilities.map((capability) => ({
        workspace_id: workspaceId,
        role_id: roleId,
        capability,
      })),
    );
    if (capabilityResult.error) throw new Error(capabilityResult.error.message);
  }

  const membershipResult = await admin
    .from("workspace_memberships")
    .insert({ workspace_id: workspaceId, user_id: data.user.id, role_id: roleId });
  if (membershipResult.error) throw new Error(membershipResult.error.message);

  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(signIn.error.message);
  return client;
}

async function createEntityViaRpc(
  client: SupabaseClient,
  workspaceId: string,
  name: string,
  fields: unknown[],
) {
  return client.rpc("create_entity_type_with_fields", {
    p_workspace_id: workspaceId,
    p_entity_name: name,
    p_entity_slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`,
    p_entity_description: null,
    p_fields: fields,
  });
}

describe("Create Object Choice field creation RPC", () => {
  it("creates Text, Date, and Choice fields with initial options transactionally", async () => {
    const workspaceId = await createWorkspace("Create Object Choice");
    const builder = await memberClient(workspaceId, ["schema.manage"]);

    const created = await createEntityViaRpc(builder, workspaceId, "Household Task", [
      { key: "title", name: "Title", slug: "title", type: "text", required: true, position: 1 },
      { key: "due_date", name: "Due date", slug: "due-date", type: "date", position: 2 },
      {
        key: "priority",
        name: "Priority",
        slug: "priority",
        type: "choice",
        position: 3,
        choice_options: [
          { label: "Low", color: "gray" },
          { label: "High", color: "red" },
          { label: "Later" },
        ],
      },
    ]);
    expect(created.error).toBeNull();

    const admin = createSupabaseTestClient();
    const entityTypeId = created.data as string;
    const fields = await admin
      .from("field_definitions")
      .select("id, name, type, position")
      .eq("workspace_id", workspaceId)
      .eq("entity_type_id", entityTypeId)
      .order("position", { ascending: true });
    expect(fields.error).toBeNull();
    expect(fields.data?.map((field) => [field.name, field.type])).toEqual([
      ["Title", "text"],
      ["Due date", "date"],
      ["Priority", "choice"],
    ]);

    const choiceField = fields.data?.find((field) => field.name === "Priority");
    const options = await admin
      .from("field_choice_options")
      .select("field_definition_id, label, color, position, archived_at")
      .eq("workspace_id", workspaceId)
      .eq("field_definition_id", choiceField!.id)
      .order("position", { ascending: true });
    expect(options.error).toBeNull();
    expect(options.data).toEqual([
      { field_definition_id: choiceField!.id, label: "Low", color: "gray", position: 1, archived_at: null },
      { field_definition_id: choiceField!.id, label: "High", color: "red", position: 2, archived_at: null },
      { field_definition_id: choiceField!.id, label: "Later", color: null, position: 3, archived_at: null },
    ]);
  }, 30_000);

  it("supports multiple Choice fields in one object", async () => {
    const workspaceId = await createWorkspace("Create Object Multiple Choice");
    const builder = await memberClient(workspaceId, ["schema.manage"]);

    const created = await createEntityViaRpc(builder, workspaceId, "Multi Choice", [
      { key: "name", name: "Name", slug: "name", type: "text", position: 1 },
      {
        key: "status",
        name: "Status",
        slug: "status",
        type: "choice",
        position: 2,
        choice_options: [{ label: "Open" }, { label: "Closed" }],
      },
      {
        key: "priority",
        name: "Priority",
        slug: "priority",
        type: "choice",
        position: 3,
        choice_options: [{ label: "Low" }, { label: "High" }],
      },
    ]);
    expect(created.error).toBeNull();

    const admin = createSupabaseTestClient();
    const fields = await admin
      .from("field_definitions")
      .select("id, name, type")
      .eq("workspace_id", workspaceId)
      .eq("entity_type_id", created.data as string)
      .eq("type", "choice")
      .order("position", { ascending: true });
    expect(fields.error).toBeNull();
    expect(fields.data).toHaveLength(2);

    for (const field of fields.data ?? []) {
      const options = await admin
        .from("field_choice_options")
        .select("label")
        .eq("workspace_id", workspaceId)
        .eq("field_definition_id", field.id)
        .order("position", { ascending: true });
      expect(options.error).toBeNull();
      expect(options.data?.map((option) => option.label)).toHaveLength(2);
    }
  }, 30_000);

  it("rolls back malformed Choice configuration and rejects Choice payloads on non-Choice fields", async () => {
    const workspaceId = await createWorkspace("Create Object Choice Rollback");
    const builder = await memberClient(workspaceId, ["schema.manage"]);

    const duplicate = await createEntityViaRpc(builder, workspaceId, "Rejected Duplicate", [
      { key: "name", name: "Name", slug: "name", type: "text", position: 1 },
      {
        key: "priority",
        name: "Priority",
        slug: "priority",
        type: "choice",
        position: 2,
        choice_options: [{ label: "Low" }, { label: "low" }],
      },
    ]);
    expect(duplicate.error).not.toBeNull();

    const badColor = await createEntityViaRpc(builder, workspaceId, "Rejected Color", [
      {
        key: "status",
        name: "Status",
        slug: "status",
        type: "choice",
        position: 1,
        choice_options: [{ label: "Open", color: "chartreuse" }],
      },
    ]);
    expect(badColor.error).not.toBeNull();

    const blankLabel = await createEntityViaRpc(builder, workspaceId, "Rejected Blank", [
      {
        key: "status",
        name: "Status",
        slug: "status",
        type: "choice",
        position: 1,
        choice_options: [{ label: " " }],
      },
    ]);
    expect(blankLabel.error).not.toBeNull();

    const nonChoicePayload = await createEntityViaRpc(builder, workspaceId, "Rejected Non Choice", [
      {
        key: "name",
        name: "Name",
        slug: "name",
        type: "text",
        position: 1,
        choice_options: [{ label: "Not allowed" }],
      },
    ]);
    expect(nonChoicePayload.error).not.toBeNull();

    const admin = createSupabaseTestClient();
    const leftover = await admin
      .from("entity_types")
      .select("id")
      .eq("workspace_id", workspaceId);
    expect(leftover.error).toBeNull();
    expect(leftover.data).toHaveLength(0);
  }, 30_000);

  it("preserves existing primitive and Relation behavior, including same-workspace protection", async () => {
    const workspaceId = await createWorkspace("Create Object Existing Types");
    const foreignWorkspaceId = await createWorkspace("Create Object Foreign Target");
    const builder = await memberClient(workspaceId, ["schema.manage"]);
    const foreignBuilder = await memberClient(foreignWorkspaceId, ["schema.manage"]);

    const foreignTarget = await createEntityViaRpc(foreignBuilder, foreignWorkspaceId, "Foreign Target", [
      { key: "name", name: "Name", slug: "name", type: "text", position: 1 },
    ]);
    expect(foreignTarget.error).toBeNull();

    const localTarget = await createEntityViaRpc(builder, workspaceId, "Local Target", [
      { key: "name", name: "Name", slug: "name", type: "text", position: 1 },
    ]);
    expect(localTarget.error).toBeNull();

    const allTypes = await createEntityViaRpc(builder, workspaceId, "All Types", [
      { key: "title", name: "Title", slug: "title", type: "text", position: 1 },
      { key: "amount", name: "Amount", slug: "amount", type: "number", position: 2 },
      { key: "date", name: "Date", slug: "date", type: "date", position: 3 },
      { key: "active", name: "Active", slug: "active", type: "boolean", position: 4 },
      {
        key: "target",
        name: "Target",
        slug: "target",
        type: "relation",
        related_entity_type_id: localTarget.data,
        position: 5,
      },
    ]);
    expect(allTypes.error).toBeNull();

    const foreignRelation = await createEntityViaRpc(builder, workspaceId, "Foreign Relation", [
      {
        key: "target",
        name: "Target",
        slug: "target",
        type: "relation",
        related_entity_type_id: foreignTarget.data,
        position: 1,
      },
    ]);
    expect(foreignRelation.error).not.toBeNull();

    const admin = createSupabaseTestClient();
    const fields = await admin
      .from("field_definitions")
      .select("type, related_entity_type_id")
      .eq("workspace_id", workspaceId)
      .eq("entity_type_id", allTypes.data as string)
      .order("position", { ascending: true });
    expect(fields.error).toBeNull();
    expect(fields.data).toEqual([
      { type: "text", related_entity_type_id: null },
      { type: "number", related_entity_type_id: null },
      { type: "date", related_entity_type_id: null },
      { type: "boolean", related_entity_type_id: null },
      { type: "relation", related_entity_type_id: localTarget.data },
    ]);
  }, 30_000);

  it("keeps the existing schema.manage authorization boundary", async () => {
    const workspaceId = await createWorkspace("Create Object Choice Authority");
    const viewer = await memberClient(workspaceId, []);

    const denied = await createEntityViaRpc(viewer, workspaceId, "Denied Choice", [
      {
        key: "status",
        name: "Status",
        slug: "status",
        type: "choice",
        position: 1,
        choice_options: [{ label: "Open" }],
      },
    ]);
    expect(denied.error).not.toBeNull();

    const admin = createSupabaseTestClient();
    const leftover = await admin
      .from("entity_types")
      .select("id")
      .eq("workspace_id", workspaceId);
    expect(leftover.error).toBeNull();
    expect(leftover.data).toHaveLength(0);
  }, 30_000);
});
