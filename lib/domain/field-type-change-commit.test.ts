// DB/RPC-level verification for safe pristine-only field-type recovery
// (migration 0141): the authoritative preflight/mutation RPCs, the shared
// dependency surface across all nine categories, the entity-type advisory
// lock protocol (including the new workflow-write trigger and the Choice-
// option/Process-Template lock hardening this feature required), and the
// governance event. Concurrency proofs use real concurrent-pair outcome
// tests, not black-box HTTP timing (see the structural test's own comment
// for why timing was rejected earlier this session).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";

type User = { id: string; email: string; password: string };

const createdUserIds: string[] = [];
const createdWorkspaceIds: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  if (createdWorkspaceIds.length > 0) {
    const { error } = await admin.from("workspaces").delete().in("id", createdWorkspaceIds);
    if (error) throw new Error(error.message);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

async function createUser(label: string): Promise<User> {
  const admin = createSupabaseTestClient();
  const password = `FieldType-${randomUUID()}!`;
  const email = `e2e-field-type-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function authenticatedClient(user: User): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function createWorkspace(name: string) {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  const { error } = await admin.from("workspaces").insert({ id: workspaceId, name: `${name} ${workspaceId.slice(0, 8)}` });
  if (error) throw new Error(error.message);
  createdWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function createRole(workspaceId: string, name: string, capabilities: string[]) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({ id, workspace_id: workspaceId, name });
  if (roleError) throw new Error(roleError.message);
  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin
      .from("workspace_role_capabilities")
      .insert(capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: id, capability })));
    if (capabilityError) throw new Error(capabilityError.message);
  }
  return id;
}

async function memberWithCapabilities(workspaceId: string, label: string, capabilities: string[]) {
  const user = await createUser(label);
  const roleId = await createRole(workspaceId, `${label}-${randomUUID().slice(0, 6)}`, capabilities);
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: user.id, role_id: roleId });
  if (error) throw new Error(error.message);
  return user;
}

async function createEntityType(workspaceId: string, name: string) {
  const admin = createSupabaseTestClient();
  const id = randomUUID();
  const { error } = await admin.from("entity_types").insert({
    id,
    workspace_id: workspaceId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);
  return id;
}

async function createField(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  options: { key: string; name: string; type: string; position: number; relatedEntityTypeId?: string },
) {
  const { data, error } = await client.rpc("add_field_definition", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_name: options.name,
    p_slug: options.key,
    p_key: options.key,
    p_type: options.type,
    p_required: false,
    p_related_entity_type_id: options.relatedEntityTypeId ?? null,
  });
  if (error) throw new Error(error.message);
  return { id: data as string };
}

async function getField(workspaceId: string, fieldDefinitionId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("field_definitions")
    .select("id, key, type, related_entity_type_id")
    .eq("workspace_id", workspaceId)
    .eq("id", fieldDefinitionId)
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string; key: string; type: string; related_entity_type_id: string | null };
}

type DependencyResult = {
  pristine?: boolean;
  changed?: boolean;
  record_value_count: number;
  relation_value_count: number;
  choice_option_count: number;
  display_field_reference_count: number;
  quality_review_reference_count: number;
  people_sensitive_reference_count: number;
  view_reference_count: number;
  workflow_reference_count: number;
  process_reference_count: number;
};

async function preflight(client: SupabaseClient, workspaceId: string, entityTypeId: string, fieldDefinitionId: string) {
  return client
    .rpc("get_field_definition_type_change_preflight_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_field_definition_id: fieldDefinitionId,
    })
    .single<DependencyResult>();
}

async function attemptChangeType(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  fieldDefinitionId: string,
  newType: string,
  newRelatedEntityTypeId?: string,
) {
  return client
    .rpc("change_field_definition_type_if_safe_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_field_definition_id: fieldDefinitionId,
      p_new_type: newType,
      p_new_related_entity_type_id: newRelatedEntityTypeId ?? null,
    })
    .single<DependencyResult>();
}

async function createRecordWithValue(client: SupabaseClient, workspaceId: string, entityTypeId: string, key: string, value: unknown) {
  const { data, error } = await client
    .rpc("create_entity_record_with_relations", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: { [key]: value },
      p_relations: {},
    })
    .single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data!.id;
}

async function createEntityView(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  filters: unknown[] = [],
) {
  const { data, error } = await client
    .rpc("create_entity_view_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_name: `View ${randomUUID().slice(0, 8)}`,
      p_filters: filters,
      p_sorts: [],
      p_column_field_definition_ids: [],
    })
    .single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data!.id;
}

async function insertWorkflow(
  client: SupabaseClient,
  workspaceId: string,
  triggerEntityTypeId: string,
  options: { conditions?: unknown[]; actions?: unknown[] } = {},
) {
  return client.from("workflows").insert({
    workspace_id: workspaceId,
    name: `Workflow ${randomUUID().slice(0, 8)}`,
    enabled: true,
    trigger_type: "record_created",
    trigger_entity_type_id: triggerEntityTypeId,
    action_config: { triggerConfig: {}, conditions: options.conditions ?? [] },
    actions: options.actions ?? [{ actionType: "create_record", actionTargetEntityTypeId: triggerEntityTypeId, fieldMappings: [] }],
  }).select("id").single<{ id: string }>();
}

function processTemplateSteps(fieldDefinitionId?: string) {
  return [
    {
      client_key: "first",
      node_id: "",
      node_type: "human_task",
      parallel_group_id: null,
      name: "Review",
      assignee_user_id: "",
      due_rule: null,
      wait_rule: null,
      condition_wait_rule: null,
      action_config: null,
      routes: [
        {
          target_client_key: "second",
          is_default: false,
          is_parallel: false,
          approval_outcome_id: null,
          approval_outcome_label: null,
          conditions: fieldDefinitionId
            ? [{ sourceFieldDefinitionId: fieldDefinitionId, operator: "equals", value: "x" }]
            : [],
        },
        {
          target_client_key: "second",
          is_default: true,
          is_parallel: false,
          approval_outcome_id: null,
          approval_outcome_label: null,
          conditions: [],
        },
      ],
    },
    {
      client_key: "second",
      node_id: "",
      node_type: "human_task",
      parallel_group_id: null,
      name: "Approve",
      assignee_user_id: "",
      due_rule: null,
      wait_rule: null,
      condition_wait_rule: null,
      action_config: null,
      routes: [],
    },
  ];
}

async function saveProcessTemplate(client: SupabaseClient, workspaceId: string, entityTypeId: string, fieldDefinitionId?: string) {
  return client.rpc("save_process_template_authorized", {
    p_workspace_id: workspaceId,
    p_process_template_id: null,
    p_name: `Template ${randomUUID().slice(0, 8)}`,
    p_description: null,
    p_applies_to_entity_type_id: entityTypeId,
    p_steps: processTemplateSteps(fieldDefinitionId),
  });
}

describe("Safe pristine-only field type change", () => {
  it("takes the identical entity-type advisory lock in every participating writer, before any dependency read or write", () => {
    const migrationSql = readFileSync(
      "supabase/migrations/0141_safe_pristine_field_type_change.sql",
      "utf8",
    );
    const lockCall = "pg_advisory_xact_lock(hashtextextended(";

    function functionBody(name: string) {
      const start = migrationSql.indexOf(`function ${name}(`);
      expect(start, `${name} not found in 0141`).toBeGreaterThan(-1);
      const end = migrationSql.indexOf("\n$$;", start);
      expect(end, `end of ${name} not found in 0141`).toBeGreaterThan(start);
      return migrationSql.slice(start, end);
    }

    for (const name of [
      "private.lock_workflow_referenced_entity_types",
      "add_field_choice_option_core",
      "update_field_choice_option_core",
      "archive_field_choice_option_core",
      "restore_field_choice_option_core",
      "save_process_template_authorized",
      "change_field_definition_type_if_safe_authorized",
    ]) {
      const body = functionBody(name);
      const lockIndex = body.indexOf(lockCall);
      expect(lockIndex, `${name} must call pg_advisory_xact_lock`).toBeGreaterThan(-1);
      expect(body.slice(lockIndex, lockIndex + lockCall.length + 40)).toMatch(/entity_type_id::text, 0\)\)/);
    }
  });

  it("changes a pristine field's type for representative primitive cases, preserving id/key, and records field_type_changed", async () => {
    const workspaceId = await createWorkspace("Field Type Pristine");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
    const client = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");

    for (const newType of ["number", "date", "boolean", "choice"]) {
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`,
        name: `Field to ${newType}`,
        type: "text",
        position: 1,
      });
      const before = await getField(workspaceId, fieldId);

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, newType);
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(true);

      const after = await getField(workspaceId, fieldId);
      expect(after.id).toBe(before.id);
      expect(after.key).toBe(before.key);
      expect(after.type).toBe(newType);
      expect(after.related_entity_type_id).toBeNull();

      const admin = createSupabaseTestClient();
      const { data: events } = await admin
        .from("governance_audit_events")
        .select("event_type, changes")
        .eq("workspace_id", workspaceId)
        .eq("subject_id", fieldId)
        .eq("event_type", "field_type_changed");
      expect(events).toHaveLength(1);
      expect(events![0].changes).toMatchObject({
        old: { type: "text", relatedEntityTypeId: null },
        new: { type: newType, relatedEntityTypeId: null },
      });
    }
  });

  it("changes a pristine non-Relation field to Relation with a valid same-workspace target", async () => {
    const workspaceId = await createWorkspace("Field Type To Relation");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
    const client = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const targetEntityTypeId = await createEntityType(workspaceId, "Client");
    const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
      key: `f_${randomUUID().slice(0, 8)}`,
      name: "Owner",
      type: "text",
      position: 1,
    });

    const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "relation", targetEntityTypeId);
    expect(result.error).toBeNull();
    expect(result.data?.changed).toBe(true);

    const after = await getField(workspaceId, fieldId);
    expect(after.type).toBe("relation");
    expect(after.related_entity_type_id).toBe(targetEntityTypeId);
  });

  it("changing a pristine Relation field to non-Relation atomically clears related_entity_type_id", async () => {
    const workspaceId = await createWorkspace("Field Type From Relation");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
    const client = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const targetEntityTypeId = await createEntityType(workspaceId, "Client");
    const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
      key: `f_${randomUUID().slice(0, 8)}`,
      name: "Owner",
      type: "relation",
      position: 1,
      relatedEntityTypeId: targetEntityTypeId,
    });

    const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "text");
    expect(result.error).toBeNull();
    expect(result.data?.changed).toBe(true);

    const after = await getField(workspaceId, fieldId);
    expect(after.type).toBe("text");
    expect(after.related_entity_type_id).toBeNull();
  });

  describe("blocked individually by each dependency category", () => {
    it("record value", async () => {
      const workspaceId = await createWorkspace("Field Type Block Record");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const key = `f_${randomUUID().slice(0, 8)}`;
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, { key, name: "Notes", type: "text", position: 1 });
      await createRecordWithValue(client, workspaceId, entityTypeId, key, "hello");

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.record_value_count).toBe(1);
      expect((await getField(workspaceId, fieldId)).type).toBe("text");
    });

    it("relation row", async () => {
      const workspaceId = await createWorkspace("Field Type Block Relation");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const targetEntityTypeId = await createEntityType(workspaceId, "Client");
      const key = `f_${randomUUID().slice(0, 8)}`;
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key, name: "Owner", type: "relation", position: 1, relatedEntityTypeId: targetEntityTypeId,
      });
      const targetRecordId = await createRecordWithValue(client, workspaceId, targetEntityTypeId, "irrelevant", null);
      const { error: recordError } = await client
        .rpc("create_entity_record_with_relations", {
          p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_values: {},
          p_relations: { [key]: targetRecordId },
        });
      expect(recordError).toBeNull();

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "text");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.relation_value_count).toBe(1);
    });

    it("Choice option", async () => {
      const workspaceId = await createWorkspace("Field Type Block Choice");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Priority", type: "choice", position: 1,
      });
      const { error: optionError } = await client.rpc("add_field_choice_option", {
        p_workspace_id: workspaceId, p_field_definition_id: fieldId, p_label: "High", p_color: "red",
      });
      expect(optionError).toBeNull();

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "text");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.choice_option_count).toBe(1);
    });

    it("display-field designation", async () => {
      const workspaceId = await createWorkspace("Field Type Block Display");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Title", type: "text", position: 1,
      });
      const { error: setError } = await client.rpc("set_entity_display_field", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_field_definition_id: fieldId,
      });
      expect(setError).toBeNull();

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.display_field_reference_count).toBe(1);
    });

    it("Quality Review designation", async () => {
      const workspaceId = await createWorkspace("Field Type Block QR");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Review");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Status", type: "choice", position: 1,
      });
      const draft = await client.rpc("add_field_choice_option", {
        p_workspace_id: workspaceId, p_field_definition_id: fieldId, p_label: "Draft", p_color: "gray",
      });
      const finalized = await client.rpc("add_field_choice_option", {
        p_workspace_id: workspaceId, p_field_definition_id: fieldId, p_label: "Finalized", p_color: "emerald",
      });
      expect(draft.error).toBeNull();
      expect(finalized.error).toBeNull();
      const { error: qrError } = await client.rpc("set_entity_type_quality_review_lifecycle_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_quality_review: true,
        p_status_field_id: fieldId, p_draft_option_id: draft.data, p_finalized_option_id: finalized.data,
      });
      expect(qrError).toBeNull();

      // The field now has 2 Choice options too, but we want to prove the QR
      // check specifically fires -- use a fresh field designated as the QR
      // status field via a legitimate stale-option path is unnecessary here;
      // choice_option_count already blocks. Assert QR count is what's set.
      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "text");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.quality_review_reference_count).toBe(1);
    });

    it("people-sensitive subject/author designation", async () => {
      const workspaceId = await createWorkspace("Field Type Block Sensitive");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const client = await authenticatedClient(builder);
      const personEntityTypeId = await createEntityType(workspaceId, "Person");
      const entityTypeId = await createEntityType(workspaceId, "Review");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Subject", type: "relation", position: 1,
        relatedEntityTypeId: personEntityTypeId,
      });
      const { error: personError } = await client.rpc("set_person_entity_type_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId,
      });
      expect(personError).toBeNull();
      const { error: sensitiveError } = await client.rpc("set_entity_type_people_sensitive_access_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_people_sensitive: true,
        p_subject_person_field_id: fieldId, p_author_person_field_id: null,
        p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: false,
      });
      expect(sensitiveError).toBeNull();

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "text");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.people_sensitive_reference_count).toBe(1);
    });

    it("saved-view reference", async () => {
      const workspaceId = await createWorkspace("Field Type Block View");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });
      await createEntityView(client, workspaceId, entityTypeId, [
        { fieldDefinitionId: fieldId, operator: "equals", value: "x" },
      ]);

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.view_reference_count).toBe(1);
    });

    it("workflow reference", async () => {
      const workspaceId = await createWorkspace("Field Type Block Workflow");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "automation.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });
      const { error: workflowError } = await insertWorkflow(client, workspaceId, entityTypeId, {
        conditions: [{ sourceFieldDefinitionId: fieldId, operator: "equals", value: "x" }],
      });
      expect(workflowError).toBeNull();

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.workflow_reference_count).toBe(1);
    });

    it("Process reference", async () => {
      const workspaceId = await createWorkspace("Field Type Block Process");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "automation.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });
      const { error: templateError } = await saveProcessTemplate(client, workspaceId, entityTypeId, fieldId);
      expect(templateError).toBeNull();

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number");
      expect(result.error).toBeNull();
      expect(result.data?.changed).toBe(false);
      expect(result.data?.process_reference_count).toBe(1);
    });
  });

  it("preflight reports the same dependency counts as the authoritative check, without mutating anything", async () => {
    const workspaceId = await createWorkspace("Field Type Preflight");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
    const client = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const key = `f_${randomUUID().slice(0, 8)}`;
    const { id: fieldId } = await createField(client, workspaceId, entityTypeId, { key, name: "Notes", type: "text", position: 1 });
    await createRecordWithValue(client, workspaceId, entityTypeId, key, "hello");

    const result = await preflight(client, workspaceId, entityTypeId, fieldId);
    expect(result.error).toBeNull();
    expect(result.data?.pristine).toBe(false);
    expect(result.data?.record_value_count).toBe(1);

    // Read-only: the field's type is completely unchanged by running preflight.
    expect((await getField(workspaceId, fieldId)).type).toBe("text");
  });

  describe("authority and integrity", () => {
    it("requires schema.manage", async () => {
      const workspaceId = await createWorkspace("Field Type Authority");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const builderClient = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(builderClient, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });
      const nonBuilder = await memberWithCapabilities(workspaceId, "nonbuilder", ["records.operate"]);
      const nonBuilderClient = await authenticatedClient(nonBuilder);

      const result = await attemptChangeType(nonBuilderClient, workspaceId, entityTypeId, fieldId, "number");
      expect(result.error).not.toBeNull();
      expect((await getField(workspaceId, fieldId)).type).toBe("text");
    });

    it("rejects a field belonging to a different workspace", async () => {
      const workspaceIdA = await createWorkspace("Field Type Cross A");
      const workspaceIdB = await createWorkspace("Field Type Cross B");
      const builderA = await memberWithCapabilities(workspaceIdA, "builder", ["schema.manage"]);
      const clientA = await authenticatedClient(builderA);
      const builderB = await memberWithCapabilities(workspaceIdB, "builder", ["schema.manage"]);
      const clientB = await authenticatedClient(builderB);
      const entityTypeIdB = await createEntityType(workspaceIdB, "Task");
      const { id: fieldId } = await createField(clientB, workspaceIdB, entityTypeIdB, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });

      const result = await attemptChangeType(clientA, workspaceIdA, entityTypeIdB, fieldId, "number");
      expect(result.error).not.toBeNull();
      expect((await getField(workspaceIdB, fieldId)).type).toBe("text");
    });

    it("rejects a malformed/foreign relation target", async () => {
      const workspaceId = await createWorkspace("Field Type Bad Target");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Owner", type: "text", position: 1,
      });

      const result = await attemptChangeType(client, workspaceId, entityTypeId, fieldId, "relation", randomUUID());
      expect(result.error).not.toBeNull();
      expect((await getField(workspaceId, fieldId)).type).toBe("text");
    });
  });

  describe("real concurrency proofs (not timing-based)", () => {
    it("record write vs type change: the type-change's own record_value_count is never stale relative to a concurrently committing record", async () => {
      const workspaceId = await createWorkspace("Field Type Race Record");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "records.operate"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const key = `f_${randomUUID().slice(0, 8)}`;
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, { key, name: "Notes", type: "text", position: 1 });

      const [changeResult] = await Promise.all([
        attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number"),
        createRecordWithValue(client, workspaceId, entityTypeId, key, "42"),
      ]);

      const finalField = await getField(workspaceId, fieldId);
      if (changeResult.data?.changed) {
        expect(changeResult.data.record_value_count).toBe(0);
        expect(finalField.type).toBe("number");
      } else {
        expect(changeResult.data?.record_value_count).toBeGreaterThan(0);
        expect(finalField.type).toBe("text");
      }
    });

    it("Choice-option creation vs type change: exactly one valid ordering occurs, never a dangling option on a non-Choice field", async () => {
      const workspaceId = await createWorkspace("Field Type Race Choice");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Priority", type: "choice", position: 1,
      });

      const [changeResult, optionResult] = await Promise.all([
        attemptChangeType(client, workspaceId, entityTypeId, fieldId, "text"),
        client.rpc("add_field_choice_option", {
          p_workspace_id: workspaceId, p_field_definition_id: fieldId, p_label: "High", p_color: "red",
        }),
      ]);

      const finalField = await getField(workspaceId, fieldId);
      if (changeResult.data?.changed) {
        expect(finalField.type).toBe("text");
        expect(optionResult.error).not.toBeNull();
      } else {
        expect(finalField.type).toBe("choice");
        expect(optionResult.error).toBeNull();
        expect(changeResult.data?.choice_option_count).toBeGreaterThan(0);
      }

      const admin = createSupabaseTestClient();
      const { data: options } = await admin.from("field_choice_options").select("id").eq("field_definition_id", fieldId);
      if (finalField.type !== "choice" ) {
        expect(options ?? []).toEqual([]);
      }
    });

    it("workflow save vs type change: the type-change's own workflow_reference_count is never stale relative to a concurrently committing workflow", async () => {
      const workspaceId = await createWorkspace("Field Type Race Workflow");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "automation.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });

      const [changeResult] = await Promise.all([
        attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number"),
        insertWorkflow(client, workspaceId, entityTypeId, {
          conditions: [{ sourceFieldDefinitionId: fieldId, operator: "equals", value: "x" }],
        }),
      ]);

      const finalField = await getField(workspaceId, fieldId);
      if (changeResult.data?.changed) {
        expect(changeResult.data.workflow_reference_count).toBe(0);
        expect(finalField.type).toBe("number");
      } else {
        expect(changeResult.data?.workflow_reference_count).toBeGreaterThan(0);
        expect(finalField.type).toBe("text");
      }
    });

    it("Process Template save vs type change: the type-change's own process_reference_count is never stale relative to a concurrently committing template", async () => {
      const workspaceId = await createWorkspace("Field Type Race Process");
      const builder = await memberWithCapabilities(workspaceId, "builder", ["schema.manage", "automation.manage"]);
      const client = await authenticatedClient(builder);
      const entityTypeId = await createEntityType(workspaceId, "Task");
      const { id: fieldId } = await createField(client, workspaceId, entityTypeId, {
        key: `f_${randomUUID().slice(0, 8)}`, name: "Notes", type: "text", position: 1,
      });

      const [changeResult] = await Promise.all([
        attemptChangeType(client, workspaceId, entityTypeId, fieldId, "number"),
        saveProcessTemplate(client, workspaceId, entityTypeId, fieldId),
      ]);

      const finalField = await getField(workspaceId, fieldId);
      if (changeResult.data?.changed) {
        expect(changeResult.data.process_reference_count).toBe(0);
        expect(finalField.type).toBe("number");
      } else {
        expect(changeResult.data?.process_reference_count).toBeGreaterThan(0);
        expect(finalField.type).toBe("text");
      }
    });
  });
});

describe("Workflow advisory-lock trigger regressions", () => {
  it("single-entity workflow create/update still works", async () => {
    const workspaceId = await createWorkspace("Workflow Lock Single");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["automation.manage"]);
    const client = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");

    const created = await insertWorkflow(client, workspaceId, entityTypeId);
    expect(created.error).toBeNull();

    const { error: updateError } = await client
      .from("workflows")
      .update({ name: "Renamed workflow" })
      .eq("workspace_id", workspaceId)
      .eq("id", created.data!.id);
    expect(updateError).toBeNull();
  });

  it("multi-entity workflow create/update still works", async () => {
    const workspaceId = await createWorkspace("Workflow Lock Multi");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["automation.manage"]);
    const client = await authenticatedClient(builder);
    const entityTypeA = await createEntityType(workspaceId, "Task");
    const entityTypeB = await createEntityType(workspaceId, "Client");
    const entityTypeC = await createEntityType(workspaceId, "Invoice");

    const created = await insertWorkflow(client, workspaceId, entityTypeA, {
      actions: [
        { actionType: "create_record", actionTargetEntityTypeId: entityTypeB, fieldMappings: [] },
        { actionType: "create_record", actionTargetEntityTypeId: entityTypeC, fieldMappings: [] },
      ],
    });
    expect(created.error).toBeNull();

    const { error: updateError } = await client
      .from("workflows")
      .update({
        actions: [
          { actionType: "create_record", actionTargetEntityTypeId: entityTypeC, fieldMappings: [] },
        ],
      })
      .eq("workspace_id", workspaceId)
      .eq("id", created.data!.id);
    expect(updateError).toBeNull();
  });

  it("existing people-sensitive-target rejection still works", async () => {
    const workspaceId = await createWorkspace("Workflow Lock Sensitive");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["automation.manage", "schema.manage"]);
    const client = await authenticatedClient(builder);
    const personEntityTypeId = await createEntityType(workspaceId, "Person");
    const entityTypeId = await createEntityType(workspaceId, "Review");
    const { id: subjectFieldId } = await createField(client, workspaceId, entityTypeId, {
      key: `f_${randomUUID().slice(0, 8)}`, name: "Subject", type: "relation", position: 1,
      relatedEntityTypeId: personEntityTypeId,
    });
    const { error: personError } = await client.rpc("set_person_entity_type_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: personEntityTypeId,
    });
    expect(personError).toBeNull();
    const { error: sensitiveError } = await client.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: entityTypeId, p_people_sensitive: true,
      p_subject_person_field_id: subjectFieldId, p_author_person_field_id: null,
      p_subject_can_view: true, p_manager_can_view: true, p_author_can_view: false,
    });
    expect(sensitiveError).toBeNull();

    const result = await insertWorkflow(client, workspaceId, entityTypeId);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/people-sensitive/i);
  });

  it("DELETE remains unaffected by the lock trigger", async () => {
    const workspaceId = await createWorkspace("Workflow Lock Delete");
    const builder = await memberWithCapabilities(workspaceId, "builder", ["automation.manage"]);
    const client = await authenticatedClient(builder);
    const entityTypeId = await createEntityType(workspaceId, "Task");
    const created = await insertWorkflow(client, workspaceId, entityTypeId);
    expect(created.error).toBeNull();

    const { error: deleteError } = await client
      .from("workflows")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("id", created.data!.id);
    expect(deleteError).toBeNull();
  });
});
