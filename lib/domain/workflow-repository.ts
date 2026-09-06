import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  WorkflowAction,
  WorkflowActionResult,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowExecutionLog,
  WorkflowExecutionStatus,
  WorkflowTriggerConfig,
  WorkflowTriggerType,
} from "./workflow-types";

type WorkflowActionRow = {
  actionType: WorkflowActionType;
  actionTargetEntityTypeId?: string | null;
  relatedFieldDefinitionId?: string | null;
  processTemplateId?: string | null;
  fieldMappings?: WorkflowAction["fieldMappings"];
};

type WorkflowRow = {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  trigger_type: WorkflowTriggerType;
  trigger_entity_type_id: string;
  action_config: {
    triggerConfig?: WorkflowTriggerConfig;
    conditions?: WorkflowCondition[];
  };
  actions: WorkflowActionRow[];
  created_at: string;
  updated_at: string;
};

type WorkflowExecutionLogRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_name_snapshot: string | null;
  trigger_entity_type_name_snapshot: string | null;
  trigger_context_snapshot: Record<string, unknown> | null;
  action_context_snapshot: Array<Record<string, unknown>> | null;
  trigger_entity_type_id: string;
  trigger_record_id: string;
  status: WorkflowExecutionStatus;
  error_message: string | null;
  result_message: string | null;
  created_record_id: string | null;
  action_entity_type_id: string | null;
  action_record_id: string | null;
  action_results: WorkflowActionResult[] | null;
  started_at: string;
  completed_at: string;
};

type CreateWorkflowInput = {
  workspaceId: string;
  name: string;
  enabled?: boolean;
  triggerType: WorkflowTriggerType;
  triggerEntityTypeId: string;
  triggerConfig?: WorkflowTriggerConfig;
  conditions?: WorkflowCondition[];
  actions: WorkflowAction[];
};

type UpdateWorkflowInput = CreateWorkflowInput & {
  workflowId: string;
  enabled: boolean;
};

type CreateWorkflowExecutionLogInput = {
  workspaceId: string;
  workflowId: string;
  workflowNameSnapshot?: string;
  triggerEntityTypeNameSnapshot?: string;
  triggerContextSnapshot?: Record<string, unknown>;
  actionContextSnapshot?: Array<Record<string, unknown>>;
  triggerEntityTypeId: string;
  triggerRecordId: string;
  status: WorkflowExecutionStatus;
  errorMessage?: string;
  resultMessage?: string;
  createdRecordId?: string;
  actionEntityTypeId?: string;
  actionRecordId?: string;
  actionResults: WorkflowActionResult[];
  startedAt: string;
  completedAt: string;
};

async function getExecutionContextSnapshot(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
  workflowId: string,
) {
  const { data: workflow, error: workflowError } = await supabase
    .from("workflows")
    .select("name, trigger_type, trigger_entity_type_id, action_config, actions")
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .maybeSingle<WorkflowRow>();

  if (workflowError || !workflow) {
    return {};
  }

  const entityTypeIds = [
    workflow.trigger_entity_type_id,
    ...workflow.actions
      .map((action) => action.actionTargetEntityTypeId)
      .filter((id): id is string => Boolean(id)),
  ];
  const fieldIds = [
    ...(workflow.action_config?.triggerConfig?.watchedFieldDefinitionIds ?? []),
    ...(workflow.action_config?.conditions ?? []).map((condition) => condition.sourceFieldDefinitionId),
    ...workflow.actions.flatMap((action) => [
      ...(action.relatedFieldDefinitionId ? [action.relatedFieldDefinitionId] : []),
      ...(action.fieldMappings ?? []).flatMap((mapping) => [
        mapping.targetFieldDefinitionId,
        mapping.source.type === "source_field" ? mapping.source.sourceFieldDefinitionId : undefined,
      ]),
    ]),
  ].filter((id): id is string => Boolean(id));
  const processTemplateIds = workflow.actions
    .map((action) => action.processTemplateId)
    .filter((id): id is string => Boolean(id));

  const [{ data: entityTypes }, { data: fields }, { data: templates }] = await Promise.all([
    supabase.from("entity_types").select("id, name").eq("workspace_id", workspaceId).in("id", [...new Set(entityTypeIds)]),
    supabase.from("field_definitions").select("id, name").eq("workspace_id", workspaceId).in("id", [...new Set(fieldIds)]),
    supabase.from("process_templates").select("id, name").eq("workspace_id", workspaceId).in("id", [...new Set(processTemplateIds)]),
  ]);
  const entityNames = new Map((entityTypes ?? []).map((row) => [row.id, row.name]));
  const fieldNames = new Map((fields ?? []).map((row) => [row.id, row.name]));
  const templateNames = new Map((templates ?? []).map((row) => [row.id, row.name]));
  const triggerConfig = workflow.action_config?.triggerConfig ?? {};

  return {
    workflowNameSnapshot: workflow.name,
    triggerEntityTypeNameSnapshot: entityNames.get(workflow.trigger_entity_type_id),
    triggerContextSnapshot: {
      triggerType: workflow.trigger_type,
      watchedFields: (triggerConfig.watchedFieldDefinitionIds ?? []).map((id) => ({
        id,
        name: fieldNames.get(id) ?? null,
      })),
      conditions: workflow.action_config?.conditions ?? [],
    },
    actionContextSnapshot: workflow.actions.map((action, index) => ({
      index,
      actionType: action.actionType,
      targetEntityTypeId: action.actionTargetEntityTypeId ?? null,
      targetEntityTypeName: action.actionTargetEntityTypeId
        ? entityNames.get(action.actionTargetEntityTypeId) ?? null
        : null,
      relatedFieldDefinitionId: action.relatedFieldDefinitionId ?? null,
      relatedFieldName: action.relatedFieldDefinitionId
        ? fieldNames.get(action.relatedFieldDefinitionId) ?? null
        : null,
      processTemplateId: action.processTemplateId ?? null,
      processTemplateName: action.processTemplateId
        ? templateNames.get(action.processTemplateId) ?? null
        : null,
    })),
  };
}

function mapWorkflowAction(row: WorkflowActionRow): WorkflowAction {
  return {
    actionType: row.actionType,
    actionTargetEntityTypeId: row.actionTargetEntityTypeId ?? undefined,
    relatedFieldDefinitionId: row.relatedFieldDefinitionId ?? undefined,
    processTemplateId: row.processTemplateId ?? undefined,
    fieldMappings: row.fieldMappings ?? [],
  };
}

function mapWorkflow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    triggerEntityTypeId: row.trigger_entity_type_id,
    triggerConfig: row.action_config?.triggerConfig,
    conditions: row.action_config?.conditions,
    actions: row.actions.map(mapWorkflowAction),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkflowExecutionLog(
  row: WorkflowExecutionLogRow,
): WorkflowExecutionLog {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowNameSnapshot: row.workflow_name_snapshot ?? undefined,
    triggerEntityTypeNameSnapshot: row.trigger_entity_type_name_snapshot ?? undefined,
    triggerContextSnapshot: row.trigger_context_snapshot ?? undefined,
    actionContextSnapshot: row.action_context_snapshot ?? undefined,
    triggerEntityTypeId: row.trigger_entity_type_id,
    triggerRecordId: row.trigger_record_id,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    resultMessage: row.result_message ?? undefined,
    createdRecordId: row.created_record_id ?? undefined,
    actionEntityTypeId: row.action_entity_type_id ?? undefined,
    actionRecordId: row.action_record_id ?? undefined,
    actionResults: row.action_results ?? [],
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function workflowReferencesField(
  workflow: WorkflowDefinition,
  fieldDefinitionId: string,
) {
  const templateToken = `{{field:${fieldDefinitionId}}}`;
  const watchedFieldDefinitionIds =
    workflow.triggerConfig?.watchedFieldDefinitionIds ?? [];

  if (watchedFieldDefinitionIds.includes(fieldDefinitionId)) {
    return true;
  }

  if (
    (workflow.conditions ?? []).some(
      (condition) => condition.sourceFieldDefinitionId === fieldDefinitionId,
    )
  ) {
    return true;
  }

  return workflow.actions.some((action) => {
    if (action.relatedFieldDefinitionId === fieldDefinitionId) {
      return true;
    }

    return action.fieldMappings.some((mapping) => {
      if (mapping.targetFieldDefinitionId === fieldDefinitionId) {
        return true;
      }

      if (
        mapping.source.type === "source_field" &&
        mapping.source.sourceFieldDefinitionId === fieldDefinitionId
      ) {
        return true;
      }

      return (
        mapping.source.type === "template" &&
        mapping.source.template.includes(templateToken)
      );
    });
  });
}

export function countWorkflowReferencesByFieldId({
  workflows,
  fieldDefinitionIds,
}: {
  workflows: WorkflowDefinition[];
  fieldDefinitionIds: string[];
}) {
  return Object.fromEntries(
    fieldDefinitionIds.map((fieldDefinitionId) => [
      fieldDefinitionId,
      workflows.filter((workflow) =>
        workflowReferencesField(workflow, fieldDefinitionId),
      ).length,
    ]),
  );
}

export async function listWorkflows({ workspaceId }: { workspaceId: string }) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true })
    .returns<WorkflowRow[]>();

  if (error) {
    throw new Error(`Unable to load workflows: ${error.message}`);
  }

  return data.map(mapWorkflow);
}

export async function getWorkflow({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .single<WorkflowRow>();

  if (error) {
    throw new Error(`Unable to load workflow: ${error.message}`);
  }

  return mapWorkflow(data);
}

export async function listEnabledWorkflowsForTrigger({
  workspaceId,
  triggerType,
  triggerEntityTypeId,
}: {
  workspaceId: string;
  triggerType: WorkflowTriggerType;
  triggerEntityTypeId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("trigger_type", triggerType)
    .eq("trigger_entity_type_id", triggerEntityTypeId)
    .eq("enabled", true)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .returns<WorkflowRow[]>();

  if (error) {
    throw new Error(`Unable to load matching workflows: ${error.message}`);
  }

  return data.map(mapWorkflow);
}

export async function listEnabledRecordCreatedWorkflows({
  workspaceId,
  triggerEntityTypeId,
}: {
  workspaceId: string;
  triggerEntityTypeId: string;
}) {
  return listEnabledWorkflowsForTrigger({
    workspaceId,
    triggerType: "record_created",
    triggerEntityTypeId,
  });
}

export async function createWorkflowDefinition({
  workspaceId,
  name,
  enabled = true,
  triggerType,
  triggerEntityTypeId,
  triggerConfig,
  conditions,
  actions,
}: CreateWorkflowInput) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .insert({
      workspace_id: workspaceId,
      name,
      enabled,
      trigger_type: triggerType,
      trigger_entity_type_id: triggerEntityTypeId,
      action_config: { triggerConfig, conditions: conditions ?? [] },
      actions,
    })
    .select("id")
    .single<{ id: string }>();

  if (error) {
    throw new Error(`Unable to create workflow: ${error.message}`);
  }

  return data.id;
}

export async function updateWorkflowDefinition({
  workspaceId,
  workflowId,
  name,
  enabled,
  triggerType,
  triggerEntityTypeId,
  triggerConfig,
  conditions,
  actions,
}: UpdateWorkflowInput) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .update({
      name,
      enabled,
      trigger_type: triggerType,
      trigger_entity_type_id: triggerEntityTypeId,
      action_config: { triggerConfig, conditions: conditions ?? [] },
      actions,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to update workflow: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to update workflow: workflow not found.");
  }
}

export async function setWorkflowEnabled({
  workspaceId,
  workflowId,
  enabled,
}: {
  workspaceId: string;
  workflowId: string;
  enabled: boolean;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .update({
      enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to update workflow status: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to update workflow status: workflow not found.");
  }
}

export async function deleteWorkflowDefinition({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflows")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", workflowId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(`Unable to delete workflow: ${error.message}`);
  }

  if (!data) {
    throw new Error("Unable to delete workflow: workflow not found.");
  }
}

export async function createWorkflowExecutionLog({
  workspaceId,
  workflowId,
  workflowNameSnapshot,
  triggerEntityTypeNameSnapshot,
  triggerContextSnapshot,
  actionContextSnapshot,
  triggerEntityTypeId,
  triggerRecordId,
  status,
  errorMessage,
  resultMessage,
  createdRecordId,
  actionEntityTypeId,
  actionRecordId,
  actionResults,
  startedAt,
  completedAt,
}: CreateWorkflowExecutionLogInput) {
  const supabase = await createServerSupabaseClient();
  const snapshot = await getExecutionContextSnapshot(supabase, workspaceId, workflowId);
  const { error } = await supabase.from("workflow_execution_logs").insert({
    workspace_id: workspaceId,
    workflow_id: workflowId,
    workflow_name_snapshot: workflowNameSnapshot ?? snapshot.workflowNameSnapshot ?? null,
    trigger_entity_type_name_snapshot:
      triggerEntityTypeNameSnapshot ?? snapshot.triggerEntityTypeNameSnapshot ?? null,
    trigger_context_snapshot: triggerContextSnapshot ?? snapshot.triggerContextSnapshot ?? {},
    action_context_snapshot: actionContextSnapshot ?? snapshot.actionContextSnapshot ?? [],
    trigger_entity_type_id: triggerEntityTypeId,
    trigger_record_id: triggerRecordId,
    status,
    error_message: errorMessage ?? null,
    result_message: resultMessage ?? null,
    created_record_id: createdRecordId ?? null,
    action_entity_type_id: actionEntityTypeId ?? null,
    action_record_id: actionRecordId ?? null,
    action_results: actionResults,
    started_at: startedAt,
    completed_at: completedAt,
  });

  if (error) {
    throw new Error(`Unable to create workflow execution log: ${error.message}`);
  }
}

export async function listRecentWorkflowExecutionLogs({
  workspaceId,
  limit = 20,
}: {
  workspaceId: string;
  limit?: number;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workflow_execution_logs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(limit)
    .returns<WorkflowExecutionLogRow[]>();

  if (error) {
    throw new Error(`Unable to load workflow execution logs: ${error.message}`);
  }

  return data.map(mapWorkflowExecutionLog);
}
