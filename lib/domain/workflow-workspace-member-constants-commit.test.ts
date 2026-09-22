import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { requireE2eEnv } from "../../tests/e2e/helpers/env";
import { createSupabaseTestClient } from "../../tests/e2e/helpers/supabase-test-data";
import { createEntityRecord, updateEntityRecord, workspaceMemberExists } from "./record-repository";
import { validateWorkflowFormData, type EntityFieldContext } from "./workflow-validation";
import type { EntityRecord, EntityType, FieldDefinition } from "./types";
import type { WorkflowAction } from "./workflow-types";

const workspaceIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  const admin = createSupabaseTestClient();
  if (workspaceIds.length > 0) {
    await admin.from("workspaces").delete().in("id", workspaceIds);
  }
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

function now() {
  return new Date().toISOString();
}

function entity(workspaceId: string, id: string, name: string): EntityType {
  const timestamp = now();
  return {
    id,
    workspaceId,
    name,
    slug: `${name.toLowerCase()}-${id.slice(0, 8)}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function field(
  workspaceId: string,
  entityTypeId: string,
  options: {
    id: string;
    key: string;
    name: string;
    type: FieldDefinition["type"];
    position: number;
    relatedEntityTypeId?: string;
  },
): FieldDefinition {
  const timestamp = now();
  return {
    id: options.id,
    workspaceId,
    entityTypeId,
    key: options.key,
    name: options.name,
    slug: options.key,
    type: options.type,
    relatedEntityTypeId: options.relatedEntityTypeId,
    required: false,
    position: options.position,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function record(
  workspaceId: string,
  entityTypeId: string,
  id: string,
  values: EntityRecord["values"] = {},
): EntityRecord {
  const timestamp = now();
  return {
    id,
    workspaceId,
    entityTypeId,
    values,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function createUser(label: string) {
  const admin = createSupabaseTestClient();
  const password = `WorkflowMember-${randomUUID()}!`;
  const email = `e2e-workflow-member-${label}-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? "Unable to create test user.");
  userIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function authClient(user: { email: string; password: string }): Promise<SupabaseClient> {
  const { supabaseUrl, supabasePublishableKey } = requireE2eEnv();
  const client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(error.message);
  return client;
}

async function addRoleMember(workspaceId: string, userId: string, capabilities: string[] = []) {
  const admin = createSupabaseTestClient();
  const roleId = randomUUID();
  const { error: roleError } = await admin.from("workspace_roles").insert({
    id: roleId,
    workspace_id: workspaceId,
    name: `Role ${roleId.slice(0, 8)}`,
  });
  if (roleError) throw new Error(roleError.message);

  if (capabilities.length > 0) {
    const { error: capabilityError } = await admin.from("workspace_role_capabilities").insert(
      capabilities.map((capability) => ({ workspace_id: workspaceId, role_id: roleId, capability })),
    );
    if (capabilityError) throw new Error(capabilityError.message);
  }

  const { error: memberError } = await admin.from("workspace_memberships").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role_id: roleId,
  });
  if (memberError) throw new Error(memberError.message);
}

async function setupWorkspace() {
  const admin = createSupabaseTestClient();
  const workspaceId = randomUUID();
  workspaceIds.push(workspaceId);
  const { error } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `Workflow Member Constants ${workspaceId.slice(0, 8)}`,
  });
  if (error) throw new Error(error.message);

  const assignee = await createUser("assignee");
  await addRoleMember(workspaceId, assignee.id, ["records.operate"]);
  return { workspaceId, assignee };
}

async function insertEntityContext(context: EntityFieldContext) {
  const admin = createSupabaseTestClient();
  const { error: entityError } = await admin.from("entity_types").insert({
    id: context.entityType.id,
    workspace_id: context.entityType.workspaceId,
    name: context.entityType.name,
    slug: context.entityType.slug,
  });
  if (entityError) throw new Error(entityError.message);

  const { error: fieldError } = await admin.from("field_definitions").insert(
    context.fields.map((definition) => ({
      id: definition.id,
      workspace_id: definition.workspaceId,
      entity_type_id: definition.entityTypeId,
      name: definition.name,
      slug: definition.slug,
      key: definition.key,
      type: definition.type,
      related_entity_type_id: definition.relatedEntityTypeId ?? null,
      required: definition.required,
      position: definition.position,
    })),
  );
  if (fieldError) throw new Error(fieldError.message);
}

async function insertRecord(input: EntityRecord) {
  const admin = createSupabaseTestClient();
  const { error } = await admin.from("entity_records").insert({
    id: input.id,
    workspace_id: input.workspaceId,
    entity_type_id: input.entityTypeId,
    values: input.values,
  });
  if (error) throw new Error(error.message);
}

async function insertWorkflow({
  workspaceId,
  sourceEntityTypeId,
  action,
}: {
  workspaceId: string;
  sourceEntityTypeId: string;
  action: WorkflowAction;
}) {
  const admin = createSupabaseTestClient();
  const workflowId = randomUUID();
  const { error } = await admin.from("workflows").insert({
    id: workflowId,
    workspace_id: workspaceId,
    name: `Member assignment ${workflowId.slice(0, 8)}`,
    enabled: true,
    trigger_type: "record_created",
    trigger_entity_type_id: sourceEntityTypeId,
    action_config: {},
    actions: [action],
  });
  if (error) throw new Error(error.message);
  return workflowId;
}

async function memberValueFor(recordId: string, fieldId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("entity_record_workspace_member_values")
    .select("member_user_id")
    .eq("source_record_id", recordId)
    .eq("field_definition_id", fieldId)
    .maybeSingle<{ member_user_id: string }>();
  if (error) throw new Error(error.message);
  return data?.member_user_id ?? null;
}

async function notificationsFor(workspaceId: string, recipientUserId: string, recordId: string) {
  const admin = createSupabaseTestClient();
  const { data, error } = await admin
    .from("notifications")
    .select("event_type, recipient_user_id, entity_record_id")
    .eq("workspace_id", workspaceId)
    .eq("recipient_user_id", recipientUserId)
    .eq("entity_record_id", recordId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function formForWorkspaceMemberConstant({
  workflowName = "Assign member",
  triggerEntityTypeId,
  actionType,
  targetEntityTypeId,
  relatedFieldId,
  targetFieldId,
  userId,
}: {
  workflowName?: string;
  triggerEntityTypeId: string;
  actionType: WorkflowAction["actionType"];
  targetEntityTypeId?: string;
  relatedFieldId?: string;
  targetFieldId: string;
  userId: string;
}) {
  const form = new FormData();
  form.set("workflowName", workflowName);
  form.set("workflowEnabled", "true");
  form.set("workflowTriggerType", "record_created");
  form.set("triggerEntityTypeId", triggerEntityTypeId);
  form.append("actionId", "action-1");
  form.set("actionType:action-1", actionType);
  if (targetEntityTypeId) form.set("actionTargetEntityTypeId:action-1", targetEntityTypeId);
  if (relatedFieldId) form.set("relatedFieldDefinitionId:action-1", relatedFieldId);
  form.append("targetFieldDefinitionId:action-1", targetFieldId);
  form.set(`mappingType:action-1:${targetFieldId}`, "constant");
  form.set(`constantValue:action-1:${targetFieldId}`, userId);
  return form;
}

describe("Workflow Workspace Member fixed constants", () => {
  it("validates fixed Workspace Member constants at configuration time", async () => {
    const { workspaceId, assignee } = await setupWorkspace();
    const task = entity(workspaceId, randomUUID(), "Task");
    const assigneeField = field(workspaceId, task.id, {
      id: randomUUID(),
      key: "assignee",
      name: "Assignee",
      type: "workspace_member",
      position: 1,
    });
    const activeEntityContexts = [{ entityType: task, fields: [assigneeField] }];
    const base = {
      formVersion: 1,
      activeEntityContexts,
      processTemplates: [],
      validateConstantRelationValue: async () => false,
    };

    const accepted = await validateWorkflowFormData({
      ...base,
      formData: formForWorkspaceMemberConstant({
        triggerEntityTypeId: task.id,
        actionType: "update_record",
        targetFieldId: assigneeField.id,
        userId: assignee.id,
      }),
      validateWorkspaceMemberValue: async (_field, userId) => userId === assignee.id,
    });
    expect(accepted.success).toBe(true);
    expect(accepted.success ? accepted.workflow.actions[0].fieldMappings[0].source : null).toEqual({
      type: "constant",
      value: assignee.id,
    });

    const rejected = await validateWorkflowFormData({
      ...base,
      formData: formForWorkspaceMemberConstant({
        triggerEntityTypeId: task.id,
        actionType: "update_record",
        targetFieldId: assigneeField.id,
        userId: assignee.id,
      }),
      validateWorkspaceMemberValue: async () => false,
    });
    expect(rejected).toMatchObject({
      success: false,
      state: {
        errors: {
          [`constantValue:action-1:${assigneeField.id}`]: "Assignee must reference an active workspace member.",
        },
      },
    });

    const admin = createSupabaseTestClient();
    const builder = await createUser("builder");
    await addRoleMember(workspaceId, builder.id, ["automation.manage"]);
    const builderClient = await authClient(builder);
    expect((await admin.from("workspace_memberships").update({ deactivated_at: now() }).eq("workspace_id", workspaceId).eq("user_id", assignee.id)).error).toBeNull();
    const deactivatedRejected = await validateWorkflowFormData({
      ...base,
      formData: formForWorkspaceMemberConstant({
        triggerEntityTypeId: task.id,
        actionType: "update_record",
        targetFieldId: assigneeField.id,
        userId: assignee.id,
      }),
      validateWorkspaceMemberValue: async (_field, userId) =>
        workspaceMemberExists({ workspaceId, userId, supabase: builderClient }),
    });
    expect(deactivatedRejected).toMatchObject({
      success: false,
      state: {
        errors: {
          [`constantValue:action-1:${assigneeField.id}`]: "Assignee must reference an active workspace member.",
        },
      },
    });
  });

  it("persists fixed Workspace Member constants through create, update, and update-related Automation actions", async () => {
    const { workspaceId, assignee } = await setupWorkspace();
    const source = entity(workspaceId, randomUUID(), "Source");
    const target = entity(workspaceId, randomUUID(), "Target");
    const created = entity(workspaceId, randomUUID(), "Created");
    const sourceMember = field(workspaceId, source.id, { id: randomUUID(), key: `owner_${source.id.slice(0, 8)}`, name: "Owner", type: "workspace_member", position: 1 });
    const relation = field(workspaceId, source.id, {
      id: randomUUID(),
      key: `target_${source.id.slice(0, 8)}`,
      name: "Target",
      type: "relation",
      position: 2,
      relatedEntityTypeId: target.id,
    });
    const targetMember = field(workspaceId, target.id, { id: randomUUID(), key: `assignee_${target.id.slice(0, 8)}`, name: "Assignee", type: "workspace_member", position: 1 });
    const createdMember = field(workspaceId, created.id, { id: randomUUID(), key: `assignee_${created.id.slice(0, 8)}`, name: "Assignee", type: "workspace_member", position: 1 });
    const sourceContext = { entityType: source, fields: [sourceMember, relation] };
    const targetContext = { entityType: target, fields: [targetMember] };
    const createdContext = { entityType: created, fields: [createdMember] };
    await insertEntityContext(targetContext);
    await insertEntityContext(createdContext);
    await insertEntityContext(sourceContext);

    const sourceRecord = record(workspaceId, source.id, randomUUID(), { [relation.key]: "" });
    const targetRecord = record(workspaceId, target.id, randomUUID());
    await insertRecord(sourceRecord);
    await insertRecord(targetRecord);
    await createSupabaseTestClient().from("entity_record_relation_values").insert({
      workspace_id: workspaceId,
      source_entity_type_id: source.id,
      source_record_id: sourceRecord.id,
      field_definition_id: relation.id,
      target_entity_type_id: target.id,
      target_record_id: targetRecord.id,
    });

    const createAction: WorkflowAction = {
      actionType: "create_record",
      actionTargetEntityTypeId: created.id,
      fieldMappings: [{ targetFieldDefinitionId: createdMember.id, source: { type: "constant", value: assignee.id } }],
    };
    const createWorkflowId = await insertWorkflow({ workspaceId, sourceEntityTypeId: source.id, action: createAction });
    const createdRecordId = await createEntityRecord({
      workspaceId,
      entityTypeId: created.id,
      fields: [createdMember],
      values: { [createdMember.key]: assignee.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: createWorkflowId,
      originatingActionType: "create_record",
    });
    expect(await memberValueFor(createdRecordId, createdMember.id)).toBe(assignee.id);

    const updateAction: WorkflowAction = {
      actionType: "update_record",
      fieldMappings: [{ targetFieldDefinitionId: sourceMember.id, source: { type: "constant", value: assignee.id } }],
    };
    const updateWorkflowId = await insertWorkflow({ workspaceId, sourceEntityTypeId: source.id, action: updateAction });
    await expect(
      updateEntityRecord({
        workspaceId,
        entityTypeId: source.id,
        recordId: sourceRecord.id,
        fields: [sourceMember],
        values: { [sourceMember.key]: assignee.id },
        supabase: createSupabaseTestClient(),
        originatingWorkflowId: createWorkflowId,
        originatingActionType: "update_record",
      }),
    ).rejects.toThrow(/Workflow cause is not compatible/);
    await updateEntityRecord({
      workspaceId,
      entityTypeId: source.id,
      recordId: sourceRecord.id,
      fields: [sourceMember],
      values: { [sourceMember.key]: assignee.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: updateWorkflowId,
      originatingActionType: "update_record",
    });
    expect(await memberValueFor(sourceRecord.id, sourceMember.id)).toBe(assignee.id);

    const relatedAction: WorkflowAction = {
      actionType: "update_related_record",
      relatedFieldDefinitionId: relation.id,
      fieldMappings: [{ targetFieldDefinitionId: targetMember.id, source: { type: "constant", value: assignee.id } }],
    };
    const relatedWorkflowId = await insertWorkflow({ workspaceId, sourceEntityTypeId: source.id, action: relatedAction });
    await updateEntityRecord({
      workspaceId,
      entityTypeId: target.id,
      recordId: targetRecord.id,
      fields: [targetMember],
      values: { [targetMember.key]: assignee.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: relatedWorkflowId,
      originatingActionType: "update_related_record",
      originatingRelatedFieldDefinitionId: relation.id,
    });
    expect(await memberValueFor(targetRecord.id, targetMember.id)).toBe(assignee.id);
  }, 30_000);

  it("fails execution after the configured fixed member is deactivated and leaves the mapping unchanged", async () => {
    const { workspaceId, assignee } = await setupWorkspace();
    const task = entity(workspaceId, randomUUID(), "Task");
    const assigneeField = field(workspaceId, task.id, { id: randomUUID(), key: `assignee_${task.id.slice(0, 8)}`, name: "Assignee", type: "workspace_member", position: 1 });
    const taskContext = { entityType: task, fields: [assigneeField] };
    await insertEntityContext(taskContext);
    const admin = createSupabaseTestClient();
    expect((await admin.from("entity_types").update({
      work_enabled: true,
      work_assignment_field_id: assigneeField.id,
    }).eq("id", task.id)).error).toBeNull();
    const taskRecord = record(workspaceId, task.id, randomUUID());
    await insertRecord(taskRecord);
    const action: WorkflowAction = {
      actionType: "update_record",
      fieldMappings: [{ targetFieldDefinitionId: assigneeField.id, source: { type: "constant", value: assignee.id } }],
    };
    const workflowId = await insertWorkflow({ workspaceId, sourceEntityTypeId: task.id, action });
    expect((await admin.from("workspace_memberships").update({ deactivated_at: now() }).eq("workspace_id", workspaceId).eq("user_id", assignee.id)).error).toBeNull();

    await expect(
      updateEntityRecord({
        workspaceId,
        entityTypeId: task.id,
        recordId: taskRecord.id,
        fields: [assigneeField],
        values: { [assigneeField.key]: assignee.id },
        supabase: admin,
        originatingWorkflowId: workflowId,
        originatingActionType: "update_record",
      }),
    ).rejects.toThrow(/active workspace member/);

    const { data, error } = await admin.from("workflows").select("actions").eq("id", workflowId).single<{ actions: WorkflowAction[] }>();
    expect(error).toBeNull();
    expect(data?.actions[0].fieldMappings[0].source).toEqual({ type: "constant", value: assignee.id });
    expect(await memberValueFor(taskRecord.id, assigneeField.id)).toBeNull();
    expect(await notificationsFor(workspaceId, assignee.id, taskRecord.id)).toHaveLength(0);
  }, 30_000);

  it("composes fixed-member Automation writes with Record Work notifications and My Work projection", async () => {
    const { workspaceId, assignee: userA } = await setupWorkspace();
    const userB = await createUser("reassigned");
    await addRoleMember(workspaceId, userB.id, ["records.operate"]);
    const clientA = await authClient(userA);
    const clientB = await authClient(userB);
    const task = entity(workspaceId, randomUUID(), "Task");
    const assigneeField = field(workspaceId, task.id, { id: randomUUID(), key: `assignee_${task.id.slice(0, 8)}`, name: "Assignee", type: "workspace_member", position: 1 });
    const statusField = field(workspaceId, task.id, { id: randomUUID(), key: `status_${task.id.slice(0, 8)}`, name: "Status", type: "choice", position: 2 });
    const doneOptionId = randomUUID();
    const taskContext = { entityType: task, fields: [assigneeField, statusField] };
    await insertEntityContext(taskContext);
    const admin = createSupabaseTestClient();
    expect((await admin.from("field_choice_options").insert({
      id: doneOptionId,
      workspace_id: workspaceId,
      field_definition_id: statusField.id,
      label: "Done",
      color: "emerald",
      position: 1,
    })).error).toBeNull();
    expect((await admin.from("entity_types").update({
      work_enabled: true,
      work_assignment_field_id: assigneeField.id,
      work_status_field_id: statusField.id,
    }).eq("id", task.id)).error).toBeNull();
    expect((await admin.from("entity_type_work_completion_options").insert({
      workspace_id: workspaceId,
      entity_type_id: task.id,
      status_field_id: statusField.id,
      option_id: doneOptionId,
    })).error).toBeNull();
    const taskRecord = record(workspaceId, task.id, randomUUID());
    await insertRecord(taskRecord);

    const assignA: WorkflowAction = {
      actionType: "update_record",
      fieldMappings: [{ targetFieldDefinitionId: assigneeField.id, source: { type: "constant", value: userA.id } }],
    };
    const workflowA = await insertWorkflow({ workspaceId, sourceEntityTypeId: task.id, action: assignA });
    await updateEntityRecord({
      workspaceId,
      entityTypeId: task.id,
      recordId: taskRecord.id,
      fields: [assigneeField],
      values: { [assigneeField.key]: userA.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: workflowA,
      originatingActionType: "update_record",
    });
    expect((await notificationsFor(workspaceId, userA.id, taskRecord.id)).map((row) => row.event_type)).toEqual(["record_work_assigned"]);
    const { data: workA, error: workAError } = await clientA.rpc("list_assigned_record_work_authorized", { p_workspace_id: workspaceId });
    expect(workAError).toBeNull();
    expect((workA ?? []).some((row: { record_id: string }) => row.record_id === taskRecord.id)).toBe(true);

    await updateEntityRecord({
      workspaceId,
      entityTypeId: task.id,
      recordId: taskRecord.id,
      fields: [assigneeField],
      values: { [assigneeField.key]: userA.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: workflowA,
      originatingActionType: "update_record",
    });
    expect((await notificationsFor(workspaceId, userA.id, taskRecord.id)).map((row) => row.event_type)).toEqual(["record_work_assigned"]);

    const assignB: WorkflowAction = {
      actionType: "update_record",
      fieldMappings: [{ targetFieldDefinitionId: assigneeField.id, source: { type: "constant", value: userB.id } }],
    };
    const workflowB = await insertWorkflow({ workspaceId, sourceEntityTypeId: task.id, action: assignB });
    await updateEntityRecord({
      workspaceId,
      entityTypeId: task.id,
      recordId: taskRecord.id,
      fields: [assigneeField],
      values: { [assigneeField.key]: userB.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: workflowB,
      originatingActionType: "update_record",
    });
    expect((await notificationsFor(workspaceId, userB.id, taskRecord.id)).map((row) => row.event_type)).toEqual(["record_work_reassigned"]);
    const { data: workBAfter, error: workBError } = await clientB.rpc("list_assigned_record_work_authorized", { p_workspace_id: workspaceId });
    expect(workBError).toBeNull();
    expect((workBAfter ?? []).some((row: { record_id: string }) => row.record_id === taskRecord.id)).toBe(true);

    const clearRecord = record(workspaceId, task.id, randomUUID());
    await insertRecord(clearRecord);
    await updateEntityRecord({
      workspaceId,
      entityTypeId: task.id,
      recordId: clearRecord.id,
      fields: [assigneeField],
      values: { [assigneeField.key]: userA.id },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: workflowA,
      originatingActionType: "update_record",
    });
    expect((await notificationsFor(workspaceId, userA.id, clearRecord.id)).map((row) => row.event_type)).toEqual(["record_work_assigned"]);
    const clearAction: WorkflowAction = {
      actionType: "update_record",
      fieldMappings: [{ targetFieldDefinitionId: assigneeField.id, source: { type: "clear" } }],
    };
    const clearWorkflow = await insertWorkflow({ workspaceId, sourceEntityTypeId: task.id, action: clearAction });
    await updateEntityRecord({
      workspaceId,
      entityTypeId: task.id,
      recordId: clearRecord.id,
      fields: [assigneeField],
      values: { [assigneeField.key]: null },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: clearWorkflow,
      originatingActionType: "update_record",
    });
    expect(await memberValueFor(clearRecord.id, assigneeField.id)).toBeNull();
    expect((await notificationsFor(workspaceId, userA.id, clearRecord.id)).map((row) => row.event_type)).toEqual(["record_work_assigned"]);

    const completedRecord = record(workspaceId, task.id, randomUUID(), { [statusField.key]: doneOptionId });
    await insertRecord(completedRecord);
    await updateEntityRecord({
      workspaceId,
      entityTypeId: task.id,
      recordId: completedRecord.id,
      fields: [assigneeField, statusField],
      values: { [assigneeField.key]: userA.id, [statusField.key]: doneOptionId },
      supabase: createSupabaseTestClient(),
      originatingWorkflowId: workflowA,
      originatingActionType: "update_record",
    });
    expect(await memberValueFor(completedRecord.id, assigneeField.id)).toBe(userA.id);
    expect(await notificationsFor(workspaceId, userA.id, completedRecord.id)).toHaveLength(0);
  }, 30_000);
});
