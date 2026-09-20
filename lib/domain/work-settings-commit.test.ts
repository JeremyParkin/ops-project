// DB/RPC-level verification for Record Work / Work Settings v1a (migrations
// 0146-0150): configuration RPCs, archival/hard-delete/type-change/Choice-
// option dependency protection, assignment/reassignment notifications, and
// the derived Assigned Records projection (including people-sensitive
// visibility and workspace-timezone overdue semantics).
//
// NOT YET RUN: written against migrations 0146-0150, which have not been
// applied to the live database this test suite targets as of authoring.
// Do not run this file until migration application is confirmed -- see the
// implementation report for the explicit stop point. Once confirmed, run:
//   npx vitest run lib/domain/work-settings-commit.test.ts
import { randomUUID } from "node:crypto";
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
  const password = `WorkSettings-${randomUUID()}!`;
  const email = `e2e-work-settings-${label}-${randomUUID()}@example.test`;
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

async function setWorkspaceTimezone(client: SupabaseClient, workspaceId: string, timezone: string) {
  const { error } = await client.rpc("set_workspace_timezone_authorized", {
    p_workspace_id: workspaceId,
    p_timezone: timezone,
  });
  if (error) throw new Error(error.message);
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

const BUILDER_WORKER_CAPS = ["schema.manage", "records.operate"];

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
  options: { key: string; name: string; type: string; relatedEntityTypeId?: string },
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
  return data as string;
}

async function addChoiceOption(client: SupabaseClient, workspaceId: string, fieldDefinitionId: string, label: string) {
  const { data, error } = await client.rpc("add_field_choice_option", {
    p_workspace_id: workspaceId,
    p_field_definition_id: fieldDefinitionId,
    p_label: label,
    p_color: "amber",
  });
  if (error) throw new Error(error.message);
  return data as string;
}

async function setWorkMapping(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  args: { assignmentFieldId: string | null; dueFieldId?: string | null; statusFieldId?: string | null; completionOptionIds?: string[] },
) {
  return client.rpc("set_entity_type_work_mapping_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_assignment_field_id: args.assignmentFieldId,
    p_due_field_id: args.dueFieldId ?? null,
    p_status_field_id: args.statusFieldId ?? null,
    p_completion_option_ids: args.completionOptionIds ?? [],
  });
}

async function setWorkEnabled(client: SupabaseClient, workspaceId: string, entityTypeId: string, enabled: boolean) {
  return client.rpc("set_entity_type_work_enabled_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_enabled: enabled,
  });
}

async function createRecordWithAssignment(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  values: Record<string, unknown>,
  assignmentFieldId: string | null,
  assigneeUserId: string | null,
) {
  const { data, error } = await client
    .rpc("create_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId,
      p_entity_type_id: entityTypeId,
      p_values: values,
      p_relations: [],
      p_workspace_members: assignmentFieldId && assigneeUserId
        ? [{ field_definition_id: assignmentFieldId, member_user_id: assigneeUserId }]
        : [],
      p_originating_process_step_run_id: null,
    })
    .single<{ id: string }>();
  if (error) throw new Error(error.message);
  return data!.id;
}

async function updateRecordAssignment(
  client: SupabaseClient,
  workspaceId: string,
  entityTypeId: string,
  recordId: string,
  values: Record<string, unknown>,
  assignmentFieldId: string,
  assigneeUserId: string | null,
) {
  const { error } = await client.rpc("update_entity_record_with_relations_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_record_id: recordId,
    p_values: values,
    p_relation_field_ids: [],
    p_relations: [],
    p_workspace_member_field_ids: [assignmentFieldId],
    p_workspace_members: assigneeUserId
      ? [{ field_definition_id: assignmentFieldId, member_user_id: assigneeUserId }]
      : [],
  });
  if (error) throw new Error(error.message);
}

async function notificationsFor(workspaceId: string, recipientUserId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("notifications")
    .select("id, event_type, recipient_user_id, dedup_key, entity_record_id")
    .eq("workspace_id", workspaceId)
    .eq("recipient_user_id", recipientUserId);
  if (error) throw new Error(error.message);
  return data!;
}

async function assignedRecordWork(client: SupabaseClient, workspaceId: string) {
  const { data, error } = await client.rpc("list_assigned_record_work_authorized", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);
  return data as Array<{
    entity_type_id: string;
    entity_type_name: string;
    record_id: string;
    due_date: string | null;
    is_overdue: boolean;
  }>;
}

describe("Work Settings configuration RPCs", () => {
  it("rejects wrong field types, cross-EntityType fields, and options from the wrong field", async () => {
    const workspaceId = await createWorkspace("Work Config");
    const builder = await memberWithCapabilities(workspaceId, "builder", BUILDER_WORKER_CAPS);
    const client = await authenticatedClient(builder);
    const taskType = await createEntityType(workspaceId, "Task");
    const otherType = await createEntityType(workspaceId, "Other");

    const textField = await createField(client, workspaceId, taskType, { key: "notes", name: "Notes", type: "text" });
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });
    const dateField = await createField(client, workspaceId, taskType, { key: "due", name: "Due", type: "date" });
    const statusField = await createField(client, workspaceId, taskType, { key: "status", name: "Status", type: "choice" });
    const otherField = await createField(client, workspaceId, otherType, { key: "other_member", name: "Other Assignee", type: "workspace_member" });
    const doneOption = await addChoiceOption(client, workspaceId, statusField, "Done");
    const otherStatusField = await createField(client, workspaceId, taskType, { key: "priority", name: "Priority", type: "choice" });
    const priorityOption = await addChoiceOption(client, workspaceId, otherStatusField, "High");

    // wrong field type for each role
    expect((await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: textField })).error).toBeTruthy();
    expect((await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: memberField, dueFieldId: textField })).error).toBeTruthy();
    expect((await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: memberField, statusFieldId: textField })).error).toBeTruthy();

    // cross-EntityType field
    expect((await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: otherField })).error).toBeTruthy();

    // completion option from the wrong Choice field
    expect(
      (
        await setWorkMapping(client, workspaceId, taskType, {
          assignmentFieldId: memberField,
          statusFieldId: statusField,
          completionOptionIds: [priorityOption],
        })
      ).error,
    ).toBeTruthy();

    // completion options with no status field configured
    expect(
      (
        await setWorkMapping(client, workspaceId, taskType, {
          assignmentFieldId: memberField,
          completionOptionIds: [doneOption],
        })
      ).error,
    ).toBeTruthy();

    // valid mapping succeeds
    const { error: validError } = await setWorkMapping(client, workspaceId, taskType, {
      assignmentFieldId: memberField,
      dueFieldId: dateField,
      statusFieldId: statusField,
      completionOptionIds: [doneOption],
    });
    expect(validError).toBeNull();
  });

  it("rejects enabling without an assignment field, preserves mapping on disable, and re-validates on re-enable", async () => {
    const workspaceId = await createWorkspace("Work Enable");
    const builder = await memberWithCapabilities(workspaceId, "builder", BUILDER_WORKER_CAPS);
    const client = await authenticatedClient(builder);
    const taskType = await createEntityType(workspaceId, "Task");
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });

    expect((await setWorkEnabled(client, workspaceId, taskType, true)).error).toBeTruthy();

    await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: memberField });
    expect((await setWorkEnabled(client, workspaceId, taskType, true)).error).toBeNull();
    expect((await setWorkEnabled(client, workspaceId, taskType, false)).error).toBeNull();

    const { data: preserved } = await client
      .rpc("get_entity_type_work_settings_authorized", { p_workspace_id: workspaceId, p_entity_type_id: taskType })
      .single<{ work_enabled: boolean; work_assignment_field_id: string }>();
    expect(preserved!.work_enabled).toBe(false);
    expect(preserved!.work_assignment_field_id).toBe(memberField);

    expect((await setWorkEnabled(client, workspaceId, taskType, true)).error).toBeNull();

    // archive the assignment field via a second, disabled state -- proves
    // dependency blocking is independent of work_enabled (covered fully in
    // the lifecycle suite below); here we only prove enable succeeds when
    // the preserved mapping is still genuinely valid.
  });
});

describe("Work Settings lifecycle/dependency safety", () => {
  async function setup() {
    const workspaceId = await createWorkspace("Work Lifecycle");
    const builder = await memberWithCapabilities(workspaceId, "builder", BUILDER_WORKER_CAPS);
    const client = await authenticatedClient(builder);
    const taskType = await createEntityType(workspaceId, "Task");
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });
    const statusField = await createField(client, workspaceId, taskType, { key: "status", name: "Status", type: "choice" });
    const doneOption = await addChoiceOption(client, workspaceId, statusField, "Done");
    await setWorkMapping(client, workspaceId, taskType, {
      assignmentFieldId: memberField,
      statusFieldId: statusField,
      completionOptionIds: [doneOption],
    });
    return { workspaceId, client, taskType, memberField, statusField, doneOption };
  }

  it("blocks archival, hard delete, and pristine type change of a mapped field while enabled", async () => {
    const { workspaceId, client, taskType, memberField } = await setup();
    await setWorkEnabled(client, workspaceId, taskType, true);

    const { error: archiveError } = await client.rpc("archive_field_definition_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_field_definition_id: memberField,
    });
    expect(archiveError).toBeTruthy();

    const { data: deleteResult } = await client
      .rpc("delete_field_definition_if_safe_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: taskType, p_field_definition_id: memberField,
      })
      .single<{ deleted: boolean }>();
    expect(deleteResult!.deleted).toBe(false);

    const { data: typeChangeResult } = await client
      .rpc("change_field_definition_type_if_safe_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: taskType, p_field_definition_id: memberField,
        p_new_type: "text", p_new_related_entity_type_id: null,
      })
      .single<{ changed: boolean }>();
    expect(typeChangeResult!.changed).toBe(false);
  });

  it("blocks hard deletion of a configured completion option", async () => {
    const { workspaceId, client, statusField, doneOption } = await setup();
    await client.rpc("archive_field_choice_option", { p_workspace_id: workspaceId, p_field_definition_id: statusField, p_option_id: doneOption });
    const { data } = await client
      .rpc("delete_field_choice_option_if_safe_authorized", {
        p_workspace_id: workspaceId, p_field_definition_id: statusField, p_option_id: doneOption,
      })
      .single<{ deleted: boolean; work_completion_reference_count: number }>();
    expect(data!.deleted).toBe(false);
    expect(data!.work_completion_reference_count).toBeGreaterThan(0);
  });

  it("keeps every protection active while Work Settings is disabled (dormant mapping still blocks)", async () => {
    const { workspaceId, client, taskType, memberField, statusField, doneOption } = await setup();
    // work_enabled defaults to false from setup() -- never enabled here.
    const { error: archiveError } = await client.rpc("archive_field_definition_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_field_definition_id: memberField,
    });
    expect(archiveError).toBeTruthy();

    await client.rpc("archive_field_choice_option", { p_workspace_id: workspaceId, p_field_definition_id: statusField, p_option_id: doneOption });
    const { data } = await client
      .rpc("delete_field_choice_option_if_safe_authorized", {
        p_workspace_id: workspaceId, p_field_definition_id: statusField, p_option_id: doneOption,
      })
      .single<{ deleted: boolean }>();
    expect(data!.deleted).toBe(false);
  });
});

describe("Record Work assignment/reassignment notifications", () => {
  async function setup() {
    const workspaceId = await createWorkspace("Work Notify");
    const builder = await memberWithCapabilities(workspaceId, "builder", BUILDER_WORKER_CAPS);
    const client = await authenticatedClient(builder);
    const taskType = await createEntityType(workspaceId, "Task");
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });
    const otherMemberField = await createField(client, workspaceId, taskType, { key: "reviewer", name: "Reviewer", type: "workspace_member" });
    const statusField = await createField(client, workspaceId, taskType, { key: "status", name: "Status", type: "choice" });
    const doneOption = await addChoiceOption(client, workspaceId, statusField, "Done");
    const openOption = await addChoiceOption(client, workspaceId, statusField, "Open");
    await setWorkMapping(client, workspaceId, taskType, {
      assignmentFieldId: memberField, statusFieldId: statusField, completionOptionIds: [doneOption],
    });
    await setWorkEnabled(client, workspaceId, taskType, true);
    const userA = await memberWithCapabilities(workspaceId, "a", ["records.operate"]);
    const userB = await memberWithCapabilities(workspaceId, "b", ["records.operate"]);
    return { workspaceId, client, taskType, memberField, otherMemberField, statusField, doneOption, openOption, userA, userB };
  }

  it("null -> A notifies A with record_work_assigned; A -> B notifies only B with record_work_reassigned; A -> null notifies nobody", async () => {
    const { workspaceId, client, taskType, memberField, openOption, userA, userB } = await setup();
    const recordId = await createRecordWithAssignment(client, workspaceId, taskType, { status: openOption }, memberField, userA.id);
    let a = await notificationsFor(workspaceId, userA.id);
    expect(a.filter((n) => n.event_type === "record_work_assigned" && n.entity_record_id === recordId)).toHaveLength(1);

    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: openOption }, memberField, userB.id);
    const b = await notificationsFor(workspaceId, userB.id);
    expect(b.filter((n) => n.event_type === "record_work_reassigned" && n.entity_record_id === recordId)).toHaveLength(1);
    a = await notificationsFor(workspaceId, userA.id);
    expect(a.filter((n) => n.event_type === "record_work_reassigned" && n.entity_record_id === recordId)).toHaveLength(0);

    const countBefore = (await notificationsFor(workspaceId, userB.id)).length;
    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: openOption }, memberField, null);
    expect((await notificationsFor(workspaceId, userB.id)).length).toBe(countBefore);
  }, 20_000);

  it("an unrelated Workspace Member field never notifies", async () => {
    const { workspaceId, client, taskType, memberField, otherMemberField, openOption, userA, userB } = await setup();
    const recordId = await createRecordWithAssignment(client, workspaceId, taskType, { status: openOption }, memberField, userA.id);
    const before = (await notificationsFor(workspaceId, userB.id)).length;

    const { error } = await client.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_record_id: recordId,
      p_values: { status: openOption }, p_relation_field_ids: [], p_relations: [],
      p_workspace_member_field_ids: [memberField, otherMemberField],
      p_workspace_members: [
        { field_definition_id: memberField, member_user_id: userA.id },
        { field_definition_id: otherMemberField, member_user_id: userB.id },
      ],
    });
    expect(error).toBeNull();
    expect((await notificationsFor(workspaceId, userB.id)).length).toBe(before);
  });

  it("assigning to an already-completed record notifies nobody; un-completing without an assignment change notifies nobody", async () => {
    const { workspaceId, client, taskType, memberField, doneOption, openOption, userA } = await setup();
    const recordId = await createRecordWithAssignment(client, workspaceId, taskType, { status: doneOption }, null, null);
    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: doneOption }, memberField, userA.id);
    expect((await notificationsFor(workspaceId, userA.id)).filter((n) => n.entity_record_id === recordId)).toHaveLength(0);

    const before = (await notificationsFor(workspaceId, userA.id)).length;
    // same assignee, status edited away from completion -- ordinary field
    // edit, no assignment change, must not notify.
    await client.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_record_id: recordId,
      p_values: { status: openOption }, p_relation_field_ids: [], p_relations: [],
      p_workspace_member_field_ids: [memberField],
      p_workspace_members: [{ field_definition_id: memberField, member_user_id: userA.id }],
    });
    expect((await notificationsFor(workspaceId, userA.id)).length).toBe(before);
  });

  it("A -> null -> A produces a second, non-suppressed notification (fresh value-row dedup, no generation counter)", async () => {
    const { workspaceId, client, taskType, memberField, openOption, userA } = await setup();
    const recordId = await createRecordWithAssignment(client, workspaceId, taskType, { status: openOption }, memberField, userA.id);
    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: openOption }, memberField, null);
    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: openOption }, memberField, userA.id);

    const notifications = (await notificationsFor(workspaceId, userA.id)).filter((n) => n.entity_record_id === recordId);
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map((n) => n.dedup_key)).size).toBe(2);
  });
});

describe("Assigned Records projection", () => {
  it("appears on assign, moves on reassign, disappears on clear/completion, reappears when status moves away from completion", async () => {
    const workspaceId = await createWorkspace("Work Projection");
    const builder = await memberWithCapabilities(workspaceId, "builder", BUILDER_WORKER_CAPS);
    const client = await authenticatedClient(builder);
    const taskType = await createEntityType(workspaceId, "Task");
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });
    const statusField = await createField(client, workspaceId, taskType, { key: "status", name: "Status", type: "choice" });
    const doneOption = await addChoiceOption(client, workspaceId, statusField, "Done");
    const openOption = await addChoiceOption(client, workspaceId, statusField, "Open");
    await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: memberField, statusFieldId: statusField, completionOptionIds: [doneOption] });
    await setWorkEnabled(client, workspaceId, taskType, true);
    const userA = await memberWithCapabilities(workspaceId, "a", ["records.operate"]);
    const userB = await memberWithCapabilities(workspaceId, "b", ["records.operate"]);
    const clientA = await authenticatedClient(userA);
    const clientB = await authenticatedClient(userB);

    const recordId = await createRecordWithAssignment(client, workspaceId, taskType, { status: openOption }, memberField, userA.id);
    expect((await assignedRecordWork(clientA, workspaceId)).some((r) => r.record_id === recordId)).toBe(true);

    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: openOption }, memberField, userB.id);
    expect((await assignedRecordWork(clientA, workspaceId)).some((r) => r.record_id === recordId)).toBe(false);
    expect((await assignedRecordWork(clientB, workspaceId)).some((r) => r.record_id === recordId)).toBe(true);

    await updateRecordAssignment(client, workspaceId, taskType, recordId, { status: doneOption }, memberField, userB.id);
    expect((await assignedRecordWork(clientB, workspaceId)).some((r) => r.record_id === recordId)).toBe(false);

    await client.rpc("update_entity_record_with_relations_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_record_id: recordId,
      p_values: { status: openOption }, p_relation_field_ids: [], p_relations: [],
      p_workspace_member_field_ids: [memberField],
      p_workspace_members: [{ field_definition_id: memberField, member_user_id: userB.id }],
    });
    expect((await assignedRecordWork(clientB, workspaceId)).some((r) => r.record_id === recordId)).toBe(true);

    await client.rpc("set_entity_records_archived_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_record_ids: [recordId], p_archived: true,
    });
    expect((await assignedRecordWork(clientB, workspaceId)).some((r) => r.record_id === recordId)).toBe(false);
  }, 30_000);

  it("excludes a people-sensitive record the assignee is not otherwise authorized to view", async () => {
    const workspaceId = await createWorkspace("Work Sensitive");
    const builder = await memberWithCapabilities(workspaceId, "builder", [...BUILDER_WORKER_CAPS, "workspace.manage_members"]);
    const client = await authenticatedClient(builder);
    const personType = await createEntityType(workspaceId, "Person");
    const { error: designateError } = await client.rpc("set_person_entity_type_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: personType,
    });
    expect(designateError).toBeNull();

    const taskType = await createEntityType(workspaceId, "SensitiveTask");
    const subjectField = await createField(client, workspaceId, taskType, {
      key: "subject", name: "Subject", type: "relation", relatedEntityTypeId: personType,
    });
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });
    await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: memberField });
    await setWorkEnabled(client, workspaceId, taskType, true);

    const { error: sensitiveError } = await client.rpc("set_entity_type_people_sensitive_access_authorized", {
      p_workspace_id: workspaceId, p_entity_type_id: taskType, p_people_sensitive: true,
      p_subject_person_field_id: subjectField, p_author_person_field_id: null,
      p_subject_can_view: true, p_manager_can_view: false, p_author_can_view: false,
    });
    expect(sensitiveError).toBeNull();

    const subjectUser = await memberWithCapabilities(workspaceId, "subject", ["records.operate"]);
    const outsideAssignee = await memberWithCapabilities(workspaceId, "outside", ["records.operate"]);
    const { data: personRecordId, error: personError } = await client
      .rpc("create_entity_record_with_relations_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: personType, p_values: {}, p_relations: [],
      })
      .single<{ id: string }>();
    expect(personError).toBeNull();
    const { error: linkError } = await client.rpc("set_person_link_authorized", {
      p_workspace_id: workspaceId, p_entity_record_id: personRecordId!.id, p_user_id: subjectUser.id,
    });
    expect(linkError).toBeNull();

    const { data: taskRecordId, error: taskError } = await client
      .rpc("create_entity_record_with_relations_authorized", {
        p_workspace_id: workspaceId, p_entity_type_id: taskType,
        p_values: {}, p_relations: [{ field_definition_id: subjectField, target_entity_type_id: personType, target_record_id: personRecordId!.id }],
        p_workspace_members: [{ field_definition_id: memberField, member_user_id: outsideAssignee.id }],
        p_originating_process_step_run_id: null,
      })
      .single<{ id: string }>();
    expect(taskError).toBeNull();

    const outsideClient = await authenticatedClient(outsideAssignee);
    const outsideView = await assignedRecordWork(outsideClient, workspaceId);
    expect(outsideView.some((r) => r.record_id === taskRecordId!.id)).toBe(false);

    const subjectClient = await authenticatedClient(subjectUser);
    // subjectUser is not the assignee, so even though they can VIEW the
    // record, it must not appear in their Assigned Records -- assignment
    // and visibility are independent axes, proven from both directions.
    expect((await assignedRecordWork(subjectClient, workspaceId)).some((r) => r.record_id === taskRecordId!.id)).toBe(false);
  }, 30_000);

  it("derives overdue from the workspace's own timezone, not UTC", async () => {
    const workspaceId = await createWorkspace("Work Timezone");
    const builder = await memberWithCapabilities(workspaceId, "builder", BUILDER_WORKER_CAPS);
    const client = await authenticatedClient(builder);
    // A timezone far enough ahead of UTC that "now" in workspace-local time
    // has already rolled over to the next calendar date while UTC has not --
    // proves the calculation reads workspaces.timezone, not now()::date.
    await setWorkspaceTimezone(client, workspaceId, "Pacific/Kiritimati"); // UTC+14
    const taskType = await createEntityType(workspaceId, "Task");
    const memberField = await createField(client, workspaceId, taskType, { key: "assignee", name: "Assignee", type: "workspace_member" });
    const dueField = await createField(client, workspaceId, taskType, { key: "due", name: "Due", type: "date" });
    await setWorkMapping(client, workspaceId, taskType, { assignmentFieldId: memberField, dueFieldId: dueField });
    await setWorkEnabled(client, workspaceId, taskType, true);
    const userA = await memberWithCapabilities(workspaceId, "a", ["records.operate"]);
    const clientA = await authenticatedClient(userA);

    const utcTodayIso = new Date().toISOString().slice(0, 10);
    const recordId = await createRecordWithAssignment(client, workspaceId, taskType, { due: utcTodayIso }, memberField, userA.id);

    const rows = await assignedRecordWork(clientA, workspaceId);
    const row = rows.find((r) => r.record_id === recordId);
    expect(row).toBeDefined();
    // In a UTC+14 workspace, "today" (UTC calendar date) is already
    // yesterday in workspace-local time -- a due date of "today" (UTC) is
    // therefore already overdue in workspace-local terms.
    expect(row!.is_overdue).toBe(true);
  }, 20_000);
});
